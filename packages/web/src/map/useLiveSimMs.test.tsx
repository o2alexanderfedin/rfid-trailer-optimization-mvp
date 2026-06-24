/**
 * useLiveSimMs tests (the `ui` lane — jsdom + RTL + fake timers).
 *
 * `useLiveSimMs` exposes a LIVE-ticking sim-clock millisecond reading for panels
 * (the Hub Detail dwell counter). It subscribes to the shared ws bus (via
 * `useWsEnvelope`) to resync to the server-authoritative `simMs` and `simSpeed`,
 * and re-renders on a fixed wall-clock interval so a consumer's elapsed dwell
 * (`simMs − arrivedAtMs`) advances on screen without a ws tick.
 *
 * We drive it through a test `WsContext.Provider` (synchronous dispatch, no real
 * socket) and Vitest fake timers, mirroring the MapView browser-test dispatch
 * pattern. The clock math itself is covered by simClock.test.ts; here we assert
 * the HOOK contract: resync-on-envelope + interval-driven re-render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { SimSpeedState, WsEnvelope } from "@mm/api";
import { useLiveSimMs } from "./useLiveSimMs.js";
import { WsContext, makeSubscriberRegistry } from "./WsProvider.js";
import { makeEntityMaps } from "./wsClient.js";

function makeCtx() {
  return { registry: makeSubscriberRegistry(), maps: makeEntityMaps() };
}

const SPEED_PAUSED: SimSpeedState = {
  multiplier: 0,
  tickIntervalMs: 500,
  simSpeed: 0,
  paused: true,
};

const SPEED_RUNNING: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

function snapshotAt(simMs: number, speed: SimSpeedState = SPEED_PAUSED): WsEnvelope {
  return {
    v: 1,
    type: "snapshot",
    seq: 1,
    simMs,
    simDay: 0,
    speed,
    payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: [] },
  };
}

/** A tiny probe component that renders the live sim-ms. */
function Probe(): React.JSX.Element {
  const simMs = useLiveSimMs();
  return <div data-testid="sim-ms">{Math.round(simMs)}</div>;
}

describe("useLiveSimMs (jsdom ui lane)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("reports 0 before any envelope (no anchor yet)", () => {
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <Probe />
      </WsContext.Provider>,
    );
    expect(screen.getByTestId("sim-ms")).toHaveTextContent("0");
  });

  it("resyncs to the server simMs on a ws snapshot", () => {
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <Probe />
      </WsContext.Provider>,
    );

    act(() => {
      ctx.registry.dispatch(snapshotAt(60_000));
    });
    // Paused snapshot → the clock holds at the server value.
    expect(screen.getByTestId("sim-ms")).toHaveTextContent("60000");
  });

  it("advances on the wall-clock interval while running (live dwell ticks)", () => {
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <Probe />
      </WsContext.Provider>,
    );

    // Anchor at simMs=0 with simSpeed=120 (120 sim-ms per wall-ms).
    act(() => {
      ctx.registry.dispatch(snapshotAt(0, SPEED_RUNNING));
    });
    expect(screen.getByTestId("sim-ms")).toHaveTextContent("0");

    // Advance wall time 1000ms → the interval fires, re-render reads the clock:
    // 1000 wall-ms × 120 = 120000 sim-ms elapsed.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const shown = Number(screen.getByTestId("sim-ms").textContent);
    expect(shown).toBeGreaterThan(0);
  });

  it("freezes when paused (simSpeed 0): no advance between ticks", () => {
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <Probe />
      </WsContext.Provider>,
    );

    act(() => {
      ctx.registry.dispatch(snapshotAt(5_000, SPEED_PAUSED));
    });
    expect(screen.getByTestId("sim-ms")).toHaveTextContent("5000");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Paused → still 5000 (monotonic, no forward motion).
    expect(screen.getByTestId("sim-ms")).toHaveTextContent("5000");
  });
});
