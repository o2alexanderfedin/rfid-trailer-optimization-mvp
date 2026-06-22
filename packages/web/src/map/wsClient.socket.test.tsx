/**
 * wsClient `useWsEnvelope` SOCKET-PATH tests (QA-01, jsdom `ui` lane).
 *
 * The sibling `wsClient.test.ts` (node `unit` lane) pins the PURE functions
 * (`parseEnvelope`, `applySnapshot`, `applyTick`) and the HRD-01 speed fallback.
 * This file drives the RAW-SOCKET React hook in `wsClient.ts` — the
 * `useWsEnvelope` that opens its own `new WebSocket(...)` (the ~56%-covered
 * connect → onmessage → seq-gap-resync → onclose path) — through a fully
 * controllable MOCK WebSocket (no real network), asserting BEHAVIOR, not lines
 * (PITFALLS P8):
 *
 *  - the socket opens EXACTLY ONCE per mount and is NOT reopened when the
 *    `onEnvelope` closure identity changes (the ref pattern);
 *  - a `snapshot` REPLACES the entity maps (full baseline);
 *  - a contiguous `tick` applies a DELTA (upsert/delete in place);
 *  - a `seq` GAP triggers a client `{ v:1, type:"resync" }` send;
 *  - non-JSON frames and malformed envelopes are dropped (no handler call);
 *  - unmount detaches `onmessage` and CLOSES the socket (no post-unmount calls).
 *
 * We stub the global `WebSocket` with a deterministic fake we can drive
 * synchronously (`emit(...)`), so there are no timers/async races — the hook's
 * branches run inline on `act(() => fake.emit(...))`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { useWsEnvelope, makeEntityMaps, type EntityMaps } from "./wsClient.js";
import type {
  WsEnvelope,
  SnapshotPayload,
  TickPayload,
  TrailerKeyframe,
  SimSpeedState,
} from "@mm/api";

// ---------------------------------------------------------------------------
// Deterministic mock WebSocket
// ---------------------------------------------------------------------------

const SPEED: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

/** A controllable fake WebSocket — records sends/closes, drives onmessage. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every instance the hook constructs, in order, for single-open assertions. */
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState: number = FakeWebSocket.OPEN;
  /** Frames the hook sent back to the server (e.g. the resync request). */
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Deliver a server frame to the hook's `onmessage`. */
  emit(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.({ data: payload } as MessageEvent<string>);
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static only(): FakeWebSocket {
    const s = FakeWebSocket.instances[0];
    if (s === undefined) throw new Error("no WebSocket was constructed");
    return s;
  }
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRAILER_A: TrailerKeyframe = {
  id: "T-1",
  routeId: "MEM-ORD",
  departMs: 0,
  etaMs: 1000,
  state: "onTime",
};
const TRAILER_B: TrailerKeyframe = {
  id: "T-2",
  routeId: "ORD-MEM",
  departMs: 500,
  etaMs: 1500,
  state: "slaRisk",
};

function snapshotEnvelope(
  seq: number,
  trailers: readonly TrailerKeyframe[],
): WsEnvelope {
  const payload: SnapshotPayload = { trailers, hubs: [], routes: [], exceptionsOpen: [] };
  return { v: 1, type: "snapshot", seq, simMs: seq * 100, speed: SPEED, payload };
}

function tickEnvelope(seq: number, payload: TickPayload): WsEnvelope {
  return { v: 1, type: "tick", seq, simMs: seq * 100, speed: SPEED, payload };
}

/** A receipt the harness records on each delivered envelope. */
interface Receipt {
  readonly seq: number;
  readonly type: string;
  /** The trailer-map state at receipt (proves apply* ran before the handler). */
  readonly trailerIds: readonly string[];
}

/**
 * A harness component driving the raw-socket `useWsEnvelope`. It records each
 * received envelope and the entity-map state at receipt, and exposes a button to
 * force a re-render with a NEW `onEnvelope` closure (to prove no socket reopen).
 */
function Harness({
  received,
  maps,
}: {
  readonly received: Receipt[];
  readonly maps: EntityMaps;
}): React.JSX.Element {
  const [n, setN] = useState(0);
  // New closure identity every render (depends on `n`) — the ref pattern must
  // keep the socket open despite this changing.
  useWsEnvelope((envelope, m) => {
    void n;
    received.push({
      seq: envelope.seq,
      type: envelope.type,
      trailerIds: [...m.trailers.keys()],
    });
  }, maps);
  return (
    <button type="button" data-testid="rerender" onClick={() => setN((v) => v + 1)}>
      {n}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWsEnvelope (raw socket path, jsdom)", () => {
  it("opens EXACTLY ONE socket per mount, to the same-origin /api/ws URL", () => {
    const maps = makeEntityMaps();
    render(<Harness received={[]} maps={maps} />);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.only().url).toMatch(/\/api\/ws$/);
    // jsdom default origin is http → ws (not wss).
    expect(FakeWebSocket.only().url.startsWith("ws://")).toBe(true);
  });

  it("does NOT reopen the socket when the onEnvelope closure changes (ref pattern)", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    const view = render(<Harness received={received} maps={maps} />);

    expect(FakeWebSocket.instances).toHaveLength(1);

    // Force re-renders → a brand-new onEnvelope closure each time.
    const btn = view.getByTestId("rerender");
    act(() => btn.click());
    act(() => btn.click());

    // Still exactly one socket — the handler lives in a ref, not a dep.
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The latest closure still receives envelopes through the SAME socket.
    act(() => FakeWebSocket.only().emit(snapshotEnvelope(1, [TRAILER_A])));
    expect(received).toHaveLength(1);
    expect(received[0]?.seq).toBe(1);
  });

  it("a snapshot REPLACES the entity maps", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    render(<Harness received={received} maps={maps} />);
    const socket = FakeWebSocket.only();

    // First snapshot: T-1 only.
    act(() => socket.emit(snapshotEnvelope(1, [TRAILER_A])));
    expect([...maps.trailers.keys()]).toEqual(["T-1"]);

    // Second snapshot (resync): T-2 only — T-1 must be purged (replace, not merge).
    act(() => socket.emit(snapshotEnvelope(2, [TRAILER_B])));
    expect([...maps.trailers.keys()]).toEqual(["T-2"]);
    expect(received.at(-1)?.trailerIds).toEqual(["T-2"]);
  });

  it("a contiguous tick applies a DELTA (upsert + delete) in place", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    render(<Harness received={received} maps={maps} />);
    const socket = FakeWebSocket.only();

    act(() => socket.emit(snapshotEnvelope(1, [TRAILER_A])));
    // Tick seq 2 (contiguous): add T-2, remove T-1.
    act(() =>
      socket.emit(tickEnvelope(2, { trailers: [TRAILER_B], trailersGone: ["T-1"] })),
    );

    expect([...maps.trailers.keys()]).toEqual(["T-2"]);
    // No resync was sent — seq was contiguous (1 → 2).
    expect(socket.sent).toHaveLength(0);
  });

  it("a seq GAP triggers a client {v:1,type:\"resync\"} send", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    render(<Harness received={received} maps={maps} />);
    const socket = FakeWebSocket.only();

    act(() => socket.emit(snapshotEnvelope(1, [TRAILER_A]))); // lastSeq = 1
    expect(socket.sent).toHaveLength(0);

    // Jump to seq 5 (3,4 missing) → gap → resync request.
    act(() => socket.emit(tickEnvelope(5, { trailers: [TRAILER_B] })));
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ v: 1, type: "resync" });

    // The gapped envelope is STILL applied (bounded recovery, not dropped).
    expect(maps.trailers.get("T-2")).toEqual(TRAILER_B);
  });

  it("drops non-JSON frames and malformed envelopes (no handler call, no apply)", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    render(<Harness received={received} maps={maps} />);
    const socket = FakeWebSocket.only();

    act(() => socket.emit("this is not json")); // JSON.parse throws → ignored
    act(() => socket.emit({ v: 2, type: "snapshot", seq: 1 })); // bad version → null
    act(() => socket.emit({ v: 1, type: "nope", seq: 1, simMs: 0, payload: {} })); // bad type

    expect(received).toHaveLength(0);
    expect(maps.trailers.size).toBe(0);

    // A well-formed snapshot afterwards is applied normally.
    act(() => socket.emit(snapshotEnvelope(1, [TRAILER_A])));
    expect(received).toHaveLength(1);
    expect(maps.trailers.get("T-1")).toEqual(TRAILER_A);
  });

  it("unmount detaches onmessage and closes the socket (no post-unmount delivery)", () => {
    const received: Receipt[] = [];
    const maps = makeEntityMaps();
    const view = render(<Harness received={received} maps={maps} />);
    const socket = FakeWebSocket.only();

    act(() => socket.emit(snapshotEnvelope(1, [TRAILER_A])));
    expect(received).toHaveLength(1);

    view.unmount();

    // Cleanup ran: handler detached and socket closed.
    expect(socket.onmessage).toBeNull();
    expect(socket.closed).toBe(true);

    // A late frame after unmount must not reach the handler (onmessage is null).
    socket.emit(snapshotEnvelope(2, [TRAILER_B]));
    expect(received).toHaveLength(1);
  });
});
