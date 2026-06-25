/**
 * WsProvider.tsx jsdom RENDER test (the `ui` lane).
 *
 * The sibling `WsProvider.test.ts` (node `unit` lane) pins the PURE subscriber
 * registry fanout. This file is the complementary RENDER proof: it mounts the
 * real `<WsProvider>` (which opens ONE WebSocket to `/api/ws`), drives a
 * snapshot + tick over an MSW v2 WebSocket link, and asserts the wiring that the
 * pure test cannot reach:
 *
 *  - a child using `useWsEnvelope` actually receives the parsed snapshot + tick
 *    envelopes the provider fans out (incl. the envelope-level `speed` field);
 *  - the provider opens EXACTLY ONE socket even with multiple subscribers (the
 *    FIX 16 "one socket, one seq counter" invariant) — proven via a per-test
 *    connection counter plus both subscribers receiving the same seq sequence;
 *  - the shared entity maps are applied BEFORE dispatch (subscribers read the
 *    provider's SHARED `WsContext.maps`), exercising `wsClient.ts`'s
 *    `applySnapshot` / `applyTick` via the socket-open → JSON.parse →
 *    parseEnvelope path (lifts wsClient.ts coverage);
 *  - malformed / wrong-version frames are dropped (parseEnvelope null branch);
 *  - unmount closes the socket (captured instance's `readyState` → CLOSING/CLOSED)
 *    and removes the subscriber (shared registry drained, no post-unmount delivery);
 *  - re-renders that change the child closure do NOT reopen the socket.
 *
 * The ws envelopes are emitted from a PER-TEST ws override on the shared `/api/ws`
 * link installed via `server.resetHandlers(api.addEventListener("connection", …))`
 * — reset (not `use`) so OUR emitter is the SOLE connection listener (the shared
 * default handler also auto-sends on this link, which would double-deliver). The
 * shared handlers file is never edited; the jsdom setup restores defaults after
 * each test.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useContext, useState } from "react";
import { server } from "../../test/msw/server.js";
import { api } from "../../test/msw/handlers.js";
import {
  WsProvider,
  WsContext,
  useWsEnvelope,
  type SubscriberRegistry,
} from "./WsProvider.js";
import { makeEntityMaps, type EntityMaps } from "./wsClient.js";
import type { WsEnvelope, SimSpeedState } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures — a snapshot (seq 1) + a contiguous tick (seq 2), both carrying the
// envelope-level `speed` field so `parseEnvelope`'s `isSimSpeedState` guard
// passes (a missing/invalid speed would make the provider drop the envelope).
// ---------------------------------------------------------------------------

const SPEED: SimSpeedState = {
  multiplier: 2,
  tickIntervalMs: 250,
  simSpeed: 240,
  paused: false,
};

/** A snapshot introducing one trailer, two hubs, and one route. */
const SNAPSHOT: WsEnvelope = {
  v: 1,
  type: "snapshot",
  seq: 1,
  simMs: 1_000,
  simDay: 0,
  speed: SPEED,
  payload: {
    trailers: [
      {
        id: "T-RENDER",
        routeId: "R-A-B",
        departMs: 0,
        etaMs: 10_000,
        state: "onTime",
        util: 0.5,
      },
    ],
    hubs: [
      { id: "A", volumeBucket: 1, slaRiskBucket: 0, congestionBucket: 0 },
      { id: "B", volumeBucket: 2, slaRiskBucket: 1, congestionBucket: 1 },
    ],
    routes: [{ id: "R-A-B", loadBucket: 2, slaRiskBucket: 0 }],
    exceptionsOpen: [],
  },
};

/** A contiguous tick (seq 2 — no gap) that upserts the trailer's state. */
const TICK: WsEnvelope = {
  v: 1,
  type: "tick",
  seq: 2,
  simMs: 1_500,
  simDay: 0,
  speed: SPEED,
  payload: {
    trailers: [
      {
        id: "T-RENDER",
        routeId: "R-A-B",
        departMs: 0,
        etaMs: 10_000,
        state: "slaRisk",
        util: 0.55,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Install a per-test ws override on the shared `/api/ws` link that, on each
 * client connection, sends the provided envelopes in order. Returns a counter
 * object whose `connections` field increments once per accepted socket — the
 * single-socket invariant probe.
 *
 * We `resetHandlers(handler)` rather than `use(handler)` so OUR emitter is the
 * SOLE `/api/ws` connection listener: the shared default handler (handlers.ts)
 * also listens on this link and auto-sends WS_SNAPSHOT + WS_TICK on connection,
 * which would double-deliver and make receipt counts non-deterministic. Reset
 * makes ours authoritative; the jsdom setup's `afterEach` restores the defaults.
 */
function emitOnConnect(...envelopes: readonly WsEnvelope[]): { connections: number } {
  const counter = { connections: 0 };
  server.resetHandlers(
    api.addEventListener("connection", ({ client }) => {
      counter.connections += 1;
      for (const env of envelopes) {
        client.send(JSON.stringify(env));
      }
    }),
  );
  return counter;
}

/** One recorded receipt: the envelope identity + the SHARED-map state at receipt. */
interface Receipt {
  readonly seq: number;
  readonly type: string;
  readonly paused: boolean;
  readonly multiplier: number;
  /** The provider's SHARED-map trailer state at the moment the child was called. */
  readonly trailerState: string | null;
}

/**
 * A child that subscribes to the shared bus via `useWsEnvelope` and records the
 * envelopes it receives.
 *
 * The provider applies each envelope to its SHARED `WsContext.maps` BEFORE
 * dispatch, so we read those shared maps (via `useContext(WsContext)`) at receipt
 * time to prove `applySnapshot` / `applyTick` ran on the socket-open → parse path.
 *
 * `useWsEnvelope` still requires the consumer's own maps arg (as MapView passes
 * its private `entityMapsRef`); we give it a fresh one — but we deliberately read
 * the SHARED maps from context for the assertion, not that private arg.
 */
function Recorder({
  label,
  received,
}: {
  readonly label: string;
  readonly received: Receipt[];
}): React.JSX.Element {
  const ctx = useContext(WsContext);
  const [maps] = useState<EntityMaps>(() => makeEntityMaps());
  const [count, setCount] = useState(0);

  useWsEnvelope((envelope) => {
    received.push({
      seq: envelope.seq,
      type: envelope.type,
      paused: envelope.speed.paused,
      multiplier: envelope.speed.multiplier,
      trailerState: ctx.maps.trailers.get("T-RENDER")?.state ?? null,
    });
    setCount((c) => c + 1);
  }, maps);

  return (
    <div data-testid={`recorder-${label}`} data-count={count}>
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<WsProvider /> (jsdom ui lane)", () => {
  it("delivers the snapshot + tick envelopes (incl. the speed field) to a child via useWsEnvelope", async () => {
    const received: Receipt[] = [];
    emitOnConnect(SNAPSHOT, TICK);

    render(
      <WsProvider>
        <Recorder label="solo" received={received} />
      </WsProvider>,
    );

    // The provider opens the socket, parses both envelopes, applies them to the
    // shared maps, and fans out to the subscriber.
    await waitFor(() => {
      expect(received.map((r) => r.type)).toEqual(["snapshot", "tick"]);
    });

    // Snapshot: applySnapshot ran before dispatch → trailer present as "onTime".
    expect(received[0]).toMatchObject({
      seq: 1,
      type: "snapshot",
      paused: false,
      trailerState: "onTime",
    });
    // Tick: applyTick upserted the trailer state in place → "slaRisk".
    expect(received[1]).toMatchObject({
      seq: 2,
      type: "tick",
      trailerState: "slaRisk",
    });
    // The envelope-level `speed` field survived parse + dispatch on both
    // (multiplier 2, not paused — proving the SimSpeedState reached the child).
    expect(received.every((r) => r.paused === false && r.multiplier === 2)).toBe(true);
  });

  it("opens EXACTLY ONE socket shared by multiple subscribers (FIX 16 invariant)", async () => {
    const a: Receipt[] = [];
    const b: Receipt[] = [];
    const counter = emitOnConnect(SNAPSHOT, TICK);

    render(
      <WsProvider>
        <Recorder label="a" received={a} />
        <Recorder label="b" received={b} />
      </WsProvider>,
    );

    // Both subscribers receive both envelopes from the ONE shared socket.
    await waitFor(() => {
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
    });

    // The provider opened a SINGLE connection despite two subscribers — the core
    // FIX 16 invariant (one socket fanned out, not one socket per consumer).
    // (`api.clients` is a link-global polluted by async-close across the suite,
    // so the per-test connection counter is the reliable single-socket probe.)
    expect(counter.connections).toBe(1);

    // Both subscribers saw the SAME parsed envelope sequence (single parse/dispatch).
    expect(a.map((r) => r.seq)).toEqual([1, 2]);
    expect(b.map((r) => r.seq)).toEqual([1, 2]);
    expect(a[0]?.trailerState).toBe("onTime");
    expect(b[0]?.trailerState).toBe("onTime");
  });

  it("closes the socket and unsubscribes on unmount (no post-unmount dispatch)", async () => {
    const received: Receipt[] = [];
    emitOnConnect(SNAPSHOT);

    // Wrap the global WebSocket so we capture the exact instance the provider
    // opens — the MSW link-global `clients` set does not reliably drop closed
    // clients under jsdom, so inspecting the captured socket's `readyState` is
    // the honest teardown probe. The subclass only records the instance; it does
    // NOT touch `close` (jsdom IDL-brands the method), so interception/emission
    // through the MSW-patched global is unchanged.
    const RealWebSocket = globalThis.WebSocket;
    const sockets: WebSocket[] = [];
    class CapturingWebSocket extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    // `globalThis.WebSocket` is read-only under jsdom/MSW — `vi.stubGlobal`
    // installs the replacement and is undone in the `finally` below.
    vi.stubGlobal("WebSocket", CapturingWebSocket);

    // Capture the shared registry the provider creates so we can prove the
    // subscriber was removed (registry drained) AFTER unmount.
    const captured: { registry: SubscriberRegistry | null } = { registry: null };
    function Probe(): React.JSX.Element {
      const ctx = useContext(WsContext);
      captured.registry = ctx.registry;
      return <span data-testid="probe" />;
    }

    try {
      const view = render(
        <WsProvider>
          <Probe />
          <Recorder label="lifecycle" received={received} />
        </WsProvider>,
      );

      // Confirm the live subscription delivered the snapshot first.
      await waitFor(() => {
        expect(received).toHaveLength(1);
      });
      // The provider opened exactly one socket.
      expect(sockets).toHaveLength(1);
      const socket = sockets[0];
      if (socket === undefined) throw new Error("socket not captured");
      // The Recorder is registered on the shared bus while mounted.
      const registry = captured.registry;
      if (registry === null) throw new Error("registry not captured");
      expect(registry.size()).toBe(1);
      // Still open (or connecting) while live — not yet closing/closed.
      expect(socket.readyState).toBeLessThan(WebSocket.CLOSING);

      // Unmount — the provider's cleanup closes the socket; the subscriber's
      // useEffect cleanup removes it from the shared registry.
      view.unmount();

      // The subscriber was removed from the shared bus synchronously on unmount.
      expect(registry.size()).toBe(0);
      // The provider's teardown closed the socket it opened (CLOSING or CLOSED).
      expect(socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);

      // No further envelopes were delivered after unmount.
      expect(received).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores malformed frames and applies only well-formed envelopes (parse path)", async () => {
    const received: Receipt[] = [];
    const counter = { connections: 0 };
    server.resetHandlers(
      api.addEventListener("connection", ({ client }) => {
        counter.connections += 1;
        // Non-JSON frame → JSON.parse throws → silently ignored.
        client.send("this is not json");
        // Valid JSON but failing parseEnvelope (bad version) → null → ignored.
        client.send(JSON.stringify({ v: 2, type: "snapshot", seq: 9 }));
        // A well-formed snapshot → applied + dispatched.
        client.send(JSON.stringify(SNAPSHOT));
      }),
    );

    render(
      <WsProvider>
        <Recorder label="parse" received={received} />
      </WsProvider>,
    );

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });
    // Only the well-formed snapshot reached the subscriber.
    expect(received[0]).toMatchObject({ seq: 1, type: "snapshot", trailerState: "onTime" });
    expect(counter.connections).toBe(1);
  });

  it("re-renders that change the child closure do NOT reopen the socket", async () => {
    const received: Receipt[] = [];
    const counter = emitOnConnect(SNAPSHOT);
    const onChange = vi.fn();

    // A parent whose state changes force the provider subtree to re-render; the
    // socket must stay open (handler stored in a ref).
    function Harness(): React.JSX.Element {
      const [n, setN] = useState(0);
      return (
        <WsProvider>
          <button
            type="button"
            data-testid="bump"
            onClick={() => {
              setN((v) => v + 1);
              onChange();
            }}
          >
            bump {n}
          </button>
          <Recorder label="stable" received={received} />
        </WsProvider>
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });

    // Force several re-renders.
    const btn = screen.getByTestId("bump");
    btn.click();
    btn.click();
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    // Still exactly one connection — re-renders did not reopen the socket
    // (the onmessage handler lives in a ref, so changing closures never re-open).
    expect(counter.connections).toBe(1);
    // No duplicate envelope delivery from a phantom reconnect.
    expect(received).toHaveLength(1);
  });

  it("sends a {v:1,type:\"resync\"} request when a seq GAP is detected (T-05-14)", async () => {
    const received: Receipt[] = [];
    // Capture every frame the CLIENT sends back to the server (the resync probe).
    const clientFrames: string[] = [];

    // A gapped tick: seq 5 after the seq-1 snapshot (2,3,4 missing) → resync.
    const gappedTick: WsEnvelope = {
      v: 1,
      type: "tick",
      seq: 5,
      simMs: 2_000,
      simDay: 0,
      speed: SPEED,
      payload: {
        trailers: [
          {
            id: "T-RENDER",
            routeId: "R-A-B",
            departMs: 0,
            etaMs: 10_000,
            state: "late",
            util: 0.6,
          },
        ],
      },
    };

    server.resetHandlers(
      api.addEventListener("connection", ({ client }) => {
        client.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data === "string") clientFrames.push(event.data);
        });
        client.send(JSON.stringify(SNAPSHOT)); // seq 1 → lastSeq = 1
        client.send(JSON.stringify(gappedTick)); // seq 5 → gap → resync
      }),
    );

    render(
      <WsProvider>
        <Recorder label="gap" received={received} />
      </WsProvider>,
    );

    // Both envelopes are delivered (the gapped tick is applied, not dropped).
    await waitFor(() => {
      expect(received.map((r) => r.seq)).toEqual([1, 5]);
    });

    // The provider sent EXACTLY ONE resync request in response to the gap.
    await waitFor(() => {
      expect(clientFrames).toHaveLength(1);
    });
    expect(JSON.parse(clientFrames[0] as string)).toEqual({ v: 1, type: "resync" });
  });
});
