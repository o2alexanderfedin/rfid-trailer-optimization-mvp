/**
 * WsProvider / shared ws subscription tests (FIX 16).
 *
 * FIX 16 fixes three independent `useWsEnvelope` calls (MapView, App, KpiDashboard)
 * that each open a separate WebSocket to `/api/ws`. This opens 3 sockets that share
 * the same server seq counter — causing seq-gap churn and unnecessary connections.
 *
 * The fix: a `WsProvider` React context opens ONE socket and fans out parsed
 * envelopes to all subscribers registered via `useWsEnvelope`.
 *
 * These tests verify the pure subscription fanout logic (no DOM / WebSocket
 * constructor needed) by testing the exported subscriber registry helpers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  makeSubscriberRegistry,
  type SubscriberRegistry,
} from "./WsProvider.js";
import type { WsEnvelope, SnapshotPayload, SimSpeedState } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Default speed state stamped on every envelope. */
const DEFAULT_SPEED: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

const ZERO_KPIS = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 0,
  onTimeArrival: 0,
  baseline: {
    utilization: 0,
    rehandleCount: 0,
    rehandleMinutes: 0,
    wrongTrailerCount: 0,
    missedUnloadCount: 0,
    slaViolationRate: 0,
    onTimeDeparture: 0,
    onTimeArrival: 0,
  },
} as const;

function makeSnapshotPayload(
  overrides?: Partial<SnapshotPayload>,
): SnapshotPayload {
  return {
    trailers: [],
    hubs: [],
    routes: [],
    kpis: ZERO_KPIS,
    exceptionsOpen: [],
    ...overrides,
  };
}

function makeSnapshotEnvelope(seq: number, simMs = 0): WsEnvelope {
  return {
    v: 1,
    type: "snapshot",
    seq,
    simMs,
    speed: DEFAULT_SPEED,
    payload: makeSnapshotPayload(),
  };
}

function makeTickEnvelope(seq: number, simMs = 0): WsEnvelope {
  return {
    v: 1,
    type: "tick",
    seq,
    simMs,
    speed: DEFAULT_SPEED,
    payload: {},
  };
}

// ---------------------------------------------------------------------------
// makeSubscriberRegistry
// ---------------------------------------------------------------------------

describe("makeSubscriberRegistry", () => {
  it("starts empty (zero subscribers)", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    expect(registry.size()).toBe(0);
  });

  it("subscribe() adds a handler and returns an unsubscribe function", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    const handler = vi.fn();
    const unsub = registry.subscribe(handler);
    expect(registry.size()).toBe(1);
    unsub();
    expect(registry.size()).toBe(0);
  });

  it("dispatch() calls all registered handlers with the envelope", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();
    registry.subscribe(h1);
    registry.subscribe(h2);

    const env = makeSnapshotEnvelope(1);
    registry.dispatch(env);

    expect(h1).toHaveBeenCalledOnce();
    expect(h1).toHaveBeenCalledWith(env);
    expect(h2).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledWith(env);
  });

  it("dispatch() does not call unsubscribed handlers", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = registry.subscribe(h1);
    registry.subscribe(h2);
    unsub1();

    registry.dispatch(makeTickEnvelope(1));
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("multiple subscribe/unsubscribe cycles leave registry empty", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    // Use two distinct handler functions (matching the real usage where each
    // useWsEnvelope call wraps its own unique closure via handlerRef).
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = registry.subscribe(h1);
    const unsub2 = registry.subscribe(h2);
    expect(registry.size()).toBe(2);
    unsub1();
    unsub2();
    expect(registry.size()).toBe(0);
  });

  it("dispatch() with no subscribers is a no-op (does not throw)", () => {
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    expect(() => registry.dispatch(makeSnapshotEnvelope(1))).not.toThrow();
  });

  it("dispatch() fans out to THREE subscribers (the MapView / App / KpiDashboard pattern)", () => {
    // This directly pins the FIX 16 requirement: one shared dispatch fans out
    // to all three consumers that previously each opened their own WebSocket.
    const registry: SubscriberRegistry = makeSubscriberRegistry();
    const mapHandler = vi.fn();
    const alertHandler = vi.fn();
    const kpiHandler = vi.fn();

    registry.subscribe(mapHandler);
    registry.subscribe(alertHandler);
    registry.subscribe(kpiHandler);

    const env = makeSnapshotEnvelope(1, 12345);
    registry.dispatch(env);

    // All three receive the SAME envelope object (single parse, single dispatch).
    expect(mapHandler).toHaveBeenCalledWith(env);
    expect(alertHandler).toHaveBeenCalledWith(env);
    expect(kpiHandler).toHaveBeenCalledWith(env);
  });
});
