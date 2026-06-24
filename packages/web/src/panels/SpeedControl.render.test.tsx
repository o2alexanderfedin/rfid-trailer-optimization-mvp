/**
 * SpeedControl.tsx jsdom RENDER test (the `ui` lane).
 *
 * The pure slider/readout/guard helpers are already covered by the Node unit
 * test (SpeedControl.test.ts). This file exercises the RENDERED component — the
 * branches the unit lane can't reach because they need a DOM, the WsContext bus,
 * and the `fetch` boundary:
 *   - the range slider `onChange` → debounced POST /api/sim/speed (spied via
 *     a per-test `server.use(http.post(...))` override),
 *   - the Pause/Resume button → POST { paused } and the label/aria flip driven
 *     by a server-confirmed envelope,
 *   - the readout text (×multiplier · ~N sim-min/real-sec) reflecting the live
 *     slider value + the confirmed tick interval,
 *   - reflecting a server-confirmed `envelope.speed` dispatched on the shared bus.
 *
 * Driving the bus: instead of a real socket, we wrap <SpeedControl/> in our own
 * WsContext.Provider whose `registry` we hold a handle to, so a test can
 * `registry.dispatch(envelope)` to play the server's confirmation — exactly the
 * path the component subscribes to in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  WsContext,
  makeSubscriberRegistry,
  type WsContextValue,
  type SubscriberRegistry,
} from "../map/WsProvider.js";
import { makeEntityMaps } from "../map/wsClient.js";
import { SpeedControl, DEFAULT_SPEED } from "./SpeedControl.js";
import type { SimSpeedState } from "../api/client.js";
import type { WsEnvelope } from "@mm/api";

// ---------------------------------------------------------------------------
// Harness: a WsContext provider whose registry the test can dispatch through.
// ---------------------------------------------------------------------------

/** Build an isolated WsContext value with a real (in-memory) fanout registry. */
function makeCtx(): { value: WsContextValue; registry: SubscriberRegistry } {
  const registry = makeSubscriberRegistry();
  return { value: { registry, maps: makeEntityMaps() }, registry };
}

/** Wrap an envelope-level `speed` into a minimal valid snapshot envelope. */
function speedEnvelope(speed: SimSpeedState): WsEnvelope {
  return {
    v: 1,
    type: "snapshot",
    seq: 1,
    simMs: 0,
    simDay: 0,
    speed,
    payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: [] },
  };
}

/** Render <SpeedControl/> under a test-controlled bus; return the registry. */
function renderControl(): { registry: SubscriberRegistry } {
  const { value, registry } = makeCtx();
  render(
    <WsContext.Provider value={value}>
      <SpeedControl />
    </WsContext.Provider>,
  );
  return { registry };
}

/**
 * Capture every POST /api/sim/speed body in order (a spy over the shared
 * handler — added per-test via `server.use`, never editing the shared file).
 */
function spyOnSpeedPosts(): Array<{ multiplier?: number; paused?: boolean }> {
  const calls: Array<{ multiplier?: number; paused?: boolean }> = [];
  server.use(
    http.post("/api/sim/speed", async ({ request }) => {
      const body = (await request.json()) as { multiplier?: number; paused?: boolean };
      calls.push(body);
      const next: SimSpeedState = {
        multiplier: body.multiplier ?? DEFAULT_SPEED.multiplier,
        tickIntervalMs: DEFAULT_SPEED.tickIntervalMs,
        simSpeed: body.paused === true ? 0 : DEFAULT_SPEED.simSpeed,
        paused: body.paused ?? DEFAULT_SPEED.paused,
      };
      return HttpResponse.json(next);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe("SpeedControl (jsdom ui lane) — initial render", () => {
  it("mounts the gauge with title, slider, pause button, and readout", () => {
    renderControl();
    expect(screen.getByTestId("speed-control")).toBeInTheDocument();
    expect(screen.getByText("Speed of Time")).toBeInTheDocument();

    const slider = screen.getByTestId("speed-slider");
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("aria-label", "Simulation speed");
    // DEFAULT_SPEED is 1× → slider value log2(1) = 0.
    expect(slider).toHaveValue("0");

    // Pre-envelope readout: 1.00× at the default 500ms tick → ~2 sim-min/real-sec.
    expect(screen.getByTestId("speed-readout")).toHaveTextContent(
      "1.00× · ~2 sim-min/real-sec",
    );
  });

  it("starts in the 'Pause' (running) state — aria-pressed false", () => {
    renderControl();
    const pause = screen.getByTestId("speed-pause");
    expect(pause).toHaveTextContent("Pause");
    expect(pause).toHaveAttribute("aria-pressed", "false");
  });
});

// ---------------------------------------------------------------------------
// Slider change → debounced POST /api/sim/speed
// ---------------------------------------------------------------------------

describe("SpeedControl — slider drag POSTs the new multiplier", () => {
  it("moving the slider to +1 (×2) POSTs { multiplier: 2 } after the debounce", async () => {
    const calls = spyOnSpeedPosts();
    renderControl();

    const slider = screen.getByTestId("speed-slider");
    // +1 in log2 space = ×2 multiplier.
    fireEvent.change(slider, { target: { value: "1" } });

    // The live readout re-anchors immediately (before any server confirmation).
    expect(screen.getByTestId("speed-readout")).toHaveTextContent("2.00×");

    // The POST is debounced (~150ms) — wait for it to land.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.multiplier).toBeCloseTo(2);
    expect(calls[0]?.paused).toBeUndefined();
  });

  it("coalesces rapid slider moves into a single trailing POST (debounce)", async () => {
    const calls = spyOnSpeedPosts();
    renderControl();

    const slider = screen.getByTestId("speed-slider");
    fireEvent.change(slider, { target: { value: "1" } }); // ×2
    fireEvent.change(slider, { target: { value: "2" } }); // ×4
    fireEvent.change(slider, { target: { value: "3" } }); // ×8 (final)

    // Readout follows the latest move synchronously.
    expect(screen.getByTestId("speed-readout")).toHaveTextContent("8.00×");

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    // Only the last value survives the debounce window.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.multiplier).toBeCloseTo(8);
  });

  it("a slider commit (mouseUp) lets a later envelope re-anchor the slider", async () => {
    const calls = spyOnSpeedPosts();
    const { registry } = renderControl();

    const slider = screen.getByTestId("speed-slider");
    // Drag to ×4, then release.
    fireEvent.change(slider, { target: { value: "2" } });
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.mouseUp(slider);

    // After release, a server-confirmed ×0.5 envelope must re-anchor the slider
    // (log2(0.5) = -1) rather than being ignored as "mid-drag".
    const confirmed: SimSpeedState = {
      multiplier: 0.5,
      tickIntervalMs: 1000,
      simSpeed: 60,
      paused: false,
    };
    registry.dispatch(speedEnvelope(confirmed));

    await waitFor(() => expect(slider).toHaveValue("-1"));
    // Readout reflects the confirmed 0.5× and 1000ms tick → ~1 sim-min/real-sec.
    expect(screen.getByTestId("speed-readout")).toHaveTextContent(
      "0.50× · ~1 sim-min/real-sec",
    );
  });
});

// ---------------------------------------------------------------------------
// Pause / Resume toggle → POST { paused } + server-confirmed label flip
// ---------------------------------------------------------------------------

describe("SpeedControl — pause / resume", () => {
  it("clicking Pause POSTs { paused: true }", async () => {
    const calls = spyOnSpeedPosts();
    renderControl();

    fireEvent.click(screen.getByTestId("speed-pause"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.paused).toBe(true);
    expect(calls[0]?.multiplier).toBeUndefined();
  });

  it("flips to 'Resume' (aria-pressed true) once the server confirms paused", async () => {
    const { registry } = renderControl();

    const pause = screen.getByTestId("speed-pause");
    expect(pause).toHaveTextContent("Pause");

    // Server confirms a pause on the next envelope.
    registry.dispatch(
      speedEnvelope({ multiplier: 1, tickIntervalMs: 500, simSpeed: 0, paused: true }),
    );

    await waitFor(() => expect(pause).toHaveTextContent("Resume"));
    expect(pause).toHaveAttribute("aria-pressed", "true");
    expect(pause).toHaveClass("speed-control__pause--paused");
  });

  it("after a confirmed pause, clicking Resume POSTs { paused: false }", async () => {
    const { registry } = renderControl();
    // Confirm paused first so the button's next toggle target is `false`.
    registry.dispatch(
      speedEnvelope({ multiplier: 1, tickIntervalMs: 500, simSpeed: 0, paused: true }),
    );
    const pause = screen.getByTestId("speed-pause");
    await waitFor(() => expect(pause).toHaveTextContent("Resume"));

    const calls = spyOnSpeedPosts();
    fireEvent.click(pause);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server-confirmed envelope.speed drives the readout (the authoritative display)
// ---------------------------------------------------------------------------

describe("SpeedControl — reflects the server-confirmed envelope.speed", () => {
  it("re-anchors slider + readout to a confirmed 4× / 125ms-tick envelope", async () => {
    const { registry } = renderControl();

    registry.dispatch(
      speedEnvelope({ multiplier: 4, tickIntervalMs: 125, simSpeed: 480, paused: false }),
    );

    const slider = screen.getByTestId("speed-slider");
    // log2(4) = 2.
    await waitFor(() => expect(slider).toHaveValue("2"));
    // 4.00× at 125ms tick → 1000/125 = 8 sim-min/real-sec.
    expect(screen.getByTestId("speed-readout")).toHaveTextContent(
      "4.00× · ~8 sim-min/real-sec",
    );
  });

  it("ignores a per-tick envelope whose speed is unchanged (no spurious re-anchor)", async () => {
    const { registry } = renderControl();
    const slider = screen.getByTestId("speed-slider");

    // Move the (local) slider WITHOUT releasing — draggingRef stays true.
    fireEvent.change(slider, { target: { value: "1" } }); // ×2 locally
    expect(slider).toHaveValue("1");

    // A tick echoing the UNCHANGED default speed must not yank the slider back:
    // speedChanged(DEFAULT, DEFAULT) === false, so no setState/re-anchor occurs.
    registry.dispatch(speedEnvelope({ ...DEFAULT_SPEED }));

    // Give any (erroneous) async re-anchor a chance, then assert it did NOT move.
    await Promise.resolve();
    expect(slider).toHaveValue("1");
  });

  it("does not fight a mid-drag user: a changed envelope updates the readout interval but not the slider value", async () => {
    const { registry } = renderControl();
    const slider = screen.getByTestId("speed-slider");

    // User is mid-drag at ×8 (no mouseUp → draggingRef true).
    fireEvent.change(slider, { target: { value: "3" } });
    expect(slider).toHaveValue("3");

    // A server confirmation for a DIFFERENT speed arrives mid-drag. The component
    // updates `speed` (so the readout's tick interval changes) but must NOT
    // re-anchor the slider value while dragging.
    registry.dispatch(
      speedEnvelope({ multiplier: 2, tickIntervalMs: 250, simSpeed: 240, paused: false }),
    );

    await waitFor(() =>
      // Readout: live slider multiplier (8.00×) · confirmed 250ms tick (~4).
      expect(screen.getByTestId("speed-readout")).toHaveTextContent(
        "8.00× · ~4 sim-min/real-sec",
      ),
    );
    // Slider stays where the user left it.
    expect(slider).toHaveValue("3");
  });
});

// ---------------------------------------------------------------------------
// Cleanup / lifecycle (unmount aborts in-flight work, unsubscribes the bus)
// ---------------------------------------------------------------------------

describe("SpeedControl — lifecycle", () => {
  let warnSpy: MockInstance<typeof console.error>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("unsubscribes from the bus on unmount (dispatch after unmount is a no-op)", () => {
    const { value, registry } = makeCtx();
    const { unmount } = render(
      <WsContext.Provider value={value}>
        <SpeedControl />
      </WsContext.Provider>,
    );
    expect(registry.size()).toBe(1);

    unmount();
    expect(registry.size()).toBe(0);
    // Dispatching after unmount must not throw or warn (no setState-after-unmount).
    expect(() =>
      registry.dispatch(
        speedEnvelope({ multiplier: 2, tickIntervalMs: 250, simSpeed: 240, paused: false }),
      ),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("aborts an in-flight debounced POST when unmounted before it fires", async () => {
    const calls = spyOnSpeedPosts();
    const { value } = makeCtx();
    const { unmount } = render(
      <WsContext.Provider value={value}>
        <SpeedControl />
      </WsContext.Provider>,
    );

    // Kick a slider change (schedules the debounced POST), then unmount before
    // the 150ms debounce elapses — the cleanup clears the timer.
    fireEvent.change(screen.getByTestId("speed-slider"), { target: { value: "1" } });
    unmount();

    // Wait past the debounce window; the POST must never have fired.
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toHaveLength(0);
  });
});
