/**
 * wsClient (useWsEnvelope) tests (TDD RED→GREEN).
 *
 * Tests the pure envelope parsing, upsert/delete logic, and seq-gap detection.
 * The React hook wiring (WebSocket lifecycle) is tested separately via e2e.
 *
 * We test the exported pure functions (`parseEnvelope`, `applySnapshot`,
 * `applyTick`) rather than the hook, to keep these tests node-friendly
 * (no DOM / WebSocket constructor needed).
 */
import { describe, expect, it } from "vitest";
import {
  parseEnvelope,
  applySnapshot,
  applyTick,
  makeEntityMaps,
} from "./wsClient.js";
import type {
  WsEnvelope,
  SnapshotPayload,
  TickPayload,
  TrailerKeyframe,
  HubState,
  RouteState,
  SimSpeedState,
} from "@mm/api";

/** Default speed state stamped on every envelope (1× / 120 sim-ms per wall-ms). */
const DEFAULT_SPEED: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeSnapshot(overrides?: Partial<SnapshotPayload>): SnapshotPayload {
  return {
    trailers: [],
    hubs: [],
    routes: [],
    kpis: ZERO_KPIS,
    exceptionsOpen: [],
    ...overrides,
  };
}

function makeEnvelope(
  type: "snapshot",
  seq: number,
  payload: SnapshotPayload,
  simMs?: number,
): WsEnvelope;
function makeEnvelope(
  type: "tick",
  seq: number,
  payload: TickPayload,
  simMs?: number,
): WsEnvelope;
function makeEnvelope(
  type: "snapshot" | "tick",
  seq: number,
  payload: SnapshotPayload | TickPayload,
  simMs = 0,
): WsEnvelope {
  if (type === "snapshot") {
    return { v: 1, type, seq, simMs, speed: DEFAULT_SPEED, payload: payload as SnapshotPayload };
  }
  return { v: 1, type, seq, simMs, speed: DEFAULT_SPEED, payload };
}

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
const HUB_A: HubState = {
  id: "MEM",
  volumeBucket: 2,
  slaRiskBucket: 1,
  congestionBucket: 0,
};
const ROUTE_A: RouteState = {
  id: "MEM-ORD",
  loadBucket: 3,
  slaRiskBucket: 1,
};

// ---------------------------------------------------------------------------
// parseEnvelope
// ---------------------------------------------------------------------------

describe("parseEnvelope", () => {
  it("returns null for non-object input", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("string")).toBeNull();
    expect(parseEnvelope(42)).toBeNull();
  });

  it("returns null for unknown version", () => {
    expect(parseEnvelope({ v: 2, type: "snapshot", seq: 1, simMs: 0, payload: {} })).toBeNull();
    expect(parseEnvelope({ v: 0, type: "snapshot", seq: 1, simMs: 0, payload: {} })).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseEnvelope({ v: 1, type: "unknown", seq: 1, simMs: 0, payload: {} })).toBeNull();
  });

  it("parses a valid snapshot envelope", () => {
    const raw = makeEnvelope("snapshot", 1, makeSnapshot());
    const result = parseEnvelope(raw);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("snapshot");
    expect(result?.seq).toBe(1);
    expect(result?.simMs).toBe(0);
  });

  it("parses a valid tick envelope", () => {
    const raw = makeEnvelope("tick", 2, { trailers: [TRAILER_A] });
    const result = parseEnvelope(raw);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tick");
    expect(result?.seq).toBe(2);
  });

  it("returns null for missing seq field", () => {
    expect(parseEnvelope({ v: 1, type: "snapshot", simMs: 0, payload: {} })).toBeNull();
  });

  it("returns null for missing simMs field", () => {
    expect(parseEnvelope({ v: 1, type: "snapshot", seq: 1, payload: {} })).toBeNull();
  });

  it("returns null when the envelope-level speed field is missing or malformed", () => {
    // No speed at all.
    expect(
      parseEnvelope({ v: 1, type: "snapshot", seq: 1, simMs: 0, payload: {} }),
    ).toBeNull();
    // speed present but incomplete (no `paused`).
    expect(
      parseEnvelope({
        v: 1,
        type: "tick",
        seq: 1,
        simMs: 0,
        speed: { multiplier: 1, tickIntervalMs: 500, simSpeed: 120 },
        payload: {},
      }),
    ).toBeNull();
  });

  it("exposes the envelope-level speed (simSpeed drives the local clock)", () => {
    const env = parseEnvelope(makeEnvelope("tick", 5, { trailers: [TRAILER_A] }, 60_000));
    expect(env).not.toBeNull();
    expect(env?.speed.simSpeed).toBe(120);
    expect(env?.speed.paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applySnapshot
// ---------------------------------------------------------------------------

describe("applySnapshot", () => {
  it("populates trailer map from snapshot payload", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A, TRAILER_B] }));
    expect(maps.trailers.size).toBe(2);
    expect(maps.trailers.get("T-1")).toBe(TRAILER_A);
    expect(maps.trailers.get("T-2")).toBe(TRAILER_B);
  });

  it("populates hub map from snapshot payload", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ hubs: [HUB_A] }));
    expect(maps.hubs.size).toBe(1);
    expect(maps.hubs.get("MEM")).toBe(HUB_A);
  });

  it("populates route map from snapshot payload", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ routes: [ROUTE_A] }));
    expect(maps.routes.size).toBe(1);
    expect(maps.routes.get("MEM-ORD")).toBe(ROUTE_A);
  });

  it("replaces previous maps entirely on resync", () => {
    const maps = makeEntityMaps();
    // First snapshot with T-1.
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A] }));
    // Second snapshot (resync) with only T-2 — T-1 must be gone.
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_B] }));
    expect(maps.trailers.size).toBe(1);
    expect(maps.trailers.get("T-1")).toBeUndefined();
    expect(maps.trailers.get("T-2")).toBe(TRAILER_B);
  });
});

// ---------------------------------------------------------------------------
// applyTick (upsert + delete)
// ---------------------------------------------------------------------------

describe("applyTick", () => {
  it("upserts changed trailers into the map", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A] }));
    const updated: TrailerKeyframe = { ...TRAILER_A, etaMs: 2000 };
    applyTick(maps, { trailers: [updated] });
    expect(maps.trailers.get("T-1")?.etaMs).toBe(2000);
  });

  it("adds a new trailer that was not in the snapshot", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A] }));
    applyTick(maps, { trailers: [TRAILER_B] });
    expect(maps.trailers.size).toBe(2);
    expect(maps.trailers.get("T-2")).toBe(TRAILER_B);
  });

  it("removes trailers listed in trailersGone", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A, TRAILER_B] }));
    applyTick(maps, { trailersGone: ["T-1"] });
    expect(maps.trailers.size).toBe(1);
    expect(maps.trailers.get("T-1")).toBeUndefined();
  });

  it("upserts changed hubs into the map", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ hubs: [HUB_A] }));
    const updated: HubState = { ...HUB_A, volumeBucket: 4 };
    applyTick(maps, { hubs: [updated] });
    expect(maps.hubs.get("MEM")?.volumeBucket).toBe(4);
  });

  it("upserts changed routes into the map", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ routes: [ROUTE_A] }));
    const updated: RouteState = { ...ROUTE_A, loadBucket: 1 };
    applyTick(maps, { routes: [updated] });
    expect(maps.routes.get("MEM-ORD")?.loadBucket).toBe(1);
  });

  it("handles empty tick payload gracefully", () => {
    const maps = makeEntityMaps();
    applySnapshot(maps, makeSnapshot({ trailers: [TRAILER_A] }));
    applyTick(maps, {});
    expect(maps.trailers.size).toBe(1); // no change
  });
});

// ---------------------------------------------------------------------------
// Seq-gap detection
// ---------------------------------------------------------------------------

describe("seq-gap detection", () => {
  it("detects a seq gap when ticks are received out of order", () => {
    const env1 = makeEnvelope("tick", 2, {});
    const env2 = makeEnvelope("tick", 5, {}); // gap: 3, 4 missing

    const parsed1 = parseEnvelope(env1);
    const parsed2 = parseEnvelope(env2);

    expect(parsed1?.seq).toBe(2);
    expect(parsed2?.seq).toBe(5);
    // Gap detection logic: if next.seq > prev.seq + 1 → resync needed.
    const gap = (parsed2?.seq ?? 0) - (parsed1?.seq ?? 0);
    expect(gap).toBeGreaterThan(1);
  });

  it("no gap for consecutive ticks", () => {
    const env1 = makeEnvelope("tick", 3, {});
    const env2 = makeEnvelope("tick", 4, {});
    const p1 = parseEnvelope(env1);
    const p2 = parseEnvelope(env2);
    expect((p2?.seq ?? 0) - (p1?.seq ?? 0)).toBe(1);
  });
});
