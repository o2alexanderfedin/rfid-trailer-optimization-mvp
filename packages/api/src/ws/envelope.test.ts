import { describe, expect, it } from "vitest";
import {
  type ExceptionItem,
  type HubState,
  type KpiSnapshot,
  type RouteState,
  type SnapshotPayload,
  type TrailerKeyframe,
  diffTick,
} from "./envelope.js";

// ---------------------------------------------------------------------------
// Helpers to build fixture objects
// ---------------------------------------------------------------------------

function trailer(
  id: string,
  routeId = "R1",
  departMs = 1000,
  etaMs = 2000,
  state: TrailerKeyframe["state"] = "onTime",
  util?: number,
): TrailerKeyframe {
  return util !== undefined
    ? { id, routeId, departMs, etaMs, state, util }
    : { id, routeId, departMs, etaMs, state };
}

function hub(
  id: string,
  volumeBucket = 0,
  slaRiskBucket = 0,
  congestionBucket = 0,
): HubState {
  return { id, volumeBucket, slaRiskBucket, congestionBucket };
}

function route(id: string, loadBucket = 0, slaRiskBucket = 0): RouteState {
  return { id, loadBucket, slaRiskBucket };
}

function exc(
  id: string,
  kind: ExceptionItem["kind"] = "wrongTrailer",
  severity: ExceptionItem["severity"] = "med",
  entityId = "T1",
  reason = "reason",
  recommendedAction = "action",
  simMs = 1000,
): ExceptionItem {
  return { id, kind, severity, entityId, reason, recommendedAction, simMs };
}

function zeroKpis(): KpiSnapshot {
  const base: Omit<KpiSnapshot, "baseline"> = {
    utilization: 0,
    rehandleCount: 0,
    rehandleMinutes: 0,
    wrongTrailerCount: 0,
    missedUnloadCount: 0,
    slaViolationRate: 0,
    onTimeDeparture: 1,
    onTimeArrival: 1,
  };
  return { ...base, baseline: { ...base } };
}

function makeSnapshot(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    trailers: [],
    hubs: [],
    routes: [],
    kpis: zeroKpis(),
    exceptionsOpen: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// diffTick: trailer upsert/delete
// ---------------------------------------------------------------------------

describe("diffTick: trailer changes", () => {
  it("returns only trailers whose fields changed (upsert by id)", () => {
    const prev = makeSnapshot({
      trailers: [
        trailer("T1", "R1", 1000, 2000, "onTime"),
        trailer("T2", "R2", 1500, 2500, "late"),
      ],
    });
    const next = makeSnapshot({
      trailers: [
        trailer("T1", "R1", 1000, 2000, "onTime"), // unchanged
        trailer("T2", "R2", 1500, 3000, "late"), // etaMs changed
      ],
    });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
    expect(tick.trailers?.[0]?.id).toBe("T2");
    expect(tick.trailers?.[0]?.etaMs).toBe(3000);
  });

  it("detects routeId change as an upsert", () => {
    const prev = makeSnapshot({ trailers: [trailer("T1", "R1")] });
    const next = makeSnapshot({ trailers: [trailer("T1", "R2")] });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
    expect(tick.trailers?.[0]?.routeId).toBe("R2");
  });

  it("detects state change as an upsert", () => {
    const prev = makeSnapshot({ trailers: [trailer("T1", "R1", 1000, 2000, "onTime")] });
    const next = makeSnapshot({ trailers: [trailer("T1", "R1", 1000, 2000, "slaRisk")] });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
    expect(tick.trailers?.[0]?.state).toBe("slaRisk");
  });

  it("detects util change as an upsert", () => {
    const prev = makeSnapshot({ trailers: [trailer("T1", "R1", 1000, 2000, "onTime", 0.5)] });
    const next = makeSnapshot({ trailers: [trailer("T1", "R1", 1000, 2000, "onTime", 0.8)] });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
    expect(tick.trailers?.[0]?.util).toBe(0.8);
  });

  it("includes trailers present in next but absent in prev (new arrivals)", () => {
    const prev = makeSnapshot({ trailers: [] });
    const next = makeSnapshot({ trailers: [trailer("T1")] });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
  });

  it("trailers absent in next appear in trailersGone (delete by id)", () => {
    const prev = makeSnapshot({
      trailers: [trailer("T1"), trailer("T2")],
    });
    const next = makeSnapshot({
      trailers: [trailer("T1")],
    });
    const tick = diffTick(prev, next);
    expect(tick.trailersGone).toEqual(["T2"]);
    expect(tick.trailers).toBeUndefined();
  });

  it("when both changed and gone trailers exist both arrays are populated", () => {
    const prev = makeSnapshot({
      trailers: [trailer("T1", "R1"), trailer("T2", "R2")],
    });
    const next = makeSnapshot({
      trailers: [trailer("T1", "R1_new")],
    });
    const tick = diffTick(prev, next);
    expect(tick.trailers).toHaveLength(1);
    expect(tick.trailersGone).toEqual(["T2"]);
  });
});

// ---------------------------------------------------------------------------
// diffTick: hub / route bucket changes
// ---------------------------------------------------------------------------

describe("diffTick: hub changes", () => {
  it("returns hubs whose integer bucket changed; unchanged ones are omitted", () => {
    const prev = makeSnapshot({
      hubs: [hub("H1", 0, 0, 0), hub("H2", 1, 0, 0)],
    });
    const next = makeSnapshot({
      hubs: [hub("H1", 0, 0, 0), hub("H2", 2, 0, 0)], // H2 volumeBucket changed
    });
    const tick = diffTick(prev, next);
    expect(tick.hubs).toHaveLength(1);
    expect(tick.hubs?.[0]?.id).toBe("H2");
    expect(tick.hubs?.[0]?.volumeBucket).toBe(2);
  });

  it("omits hub section entirely when no buckets changed", () => {
    const prev = makeSnapshot({ hubs: [hub("H1", 0, 0, 0)] });
    const next = makeSnapshot({ hubs: [hub("H1", 0, 0, 0)] });
    const tick = diffTick(prev, next);
    expect(tick.hubs).toBeUndefined();
  });

  it("HUBQ-08: a changed driverCount is an upsert (driver bucket delta)", () => {
    const prev = makeSnapshot({
      hubs: [{ id: "H1", volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0, driverCount: 1, onBreakCount: 0, restingCount: 0 }],
    });
    const next = makeSnapshot({
      hubs: [{ id: "H1", volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0, driverCount: 2, onBreakCount: 0, restingCount: 0 }],
    });
    const tick = diffTick(prev, next);
    expect(tick.hubs).toHaveLength(1);
    expect(tick.hubs?.[0]?.driverCount).toBe(2);
  });

  it("HUBQ-08: a changed onBreakCount/restingCount is an upsert", () => {
    const base = { id: "H1", volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0, driverCount: 3 };
    const prev = makeSnapshot({ hubs: [{ ...base, onBreakCount: 0, restingCount: 0 }] });
    const next = makeSnapshot({ hubs: [{ ...base, onBreakCount: 1, restingCount: 2 }] });
    const tick = diffTick(prev, next);
    expect(tick.hubs).toHaveLength(1);
    expect(tick.hubs?.[0]?.onBreakCount).toBe(1);
    expect(tick.hubs?.[0]?.restingCount).toBe(2);
  });

  it("HUBQ-08 back-compat: absent driver buckets are treated as 0 (no spurious delta)", () => {
    // A v1 payload that predates the driver buckets must not flicker against one
    // that sets them to 0 — `?? 0` keeps them equivalent.
    const prev = makeSnapshot({ hubs: [hub("H1", 1, 0, 0)] }); // no driver fields
    const next = makeSnapshot({
      hubs: [{ id: "H1", volumeBucket: 1, slaRiskBucket: 0, congestionBucket: 0, driverCount: 0, onBreakCount: 0, restingCount: 0 }],
    });
    const tick = diffTick(prev, next);
    expect(tick.hubs).toBeUndefined();
  });
});

describe("diffTick: route changes", () => {
  it("returns routes whose loadBucket or slaRiskBucket changed", () => {
    const prev = makeSnapshot({
      routes: [route("RT1", 0, 0), route("RT2", 1, 0)],
    });
    const next = makeSnapshot({
      routes: [route("RT1", 0, 0), route("RT2", 1, 1)], // slaRiskBucket changed
    });
    const tick = diffTick(prev, next);
    expect(tick.routes).toHaveLength(1);
    expect(tick.routes?.[0]?.id).toBe("RT2");
  });

  it("omits routes section entirely when nothing changed", () => {
    const prev = makeSnapshot({ routes: [route("RT1", 0, 0)] });
    const next = makeSnapshot({ routes: [route("RT1", 0, 0)] });
    const tick = diffTick(prev, next);
    expect(tick.routes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diffTick: exceptions new / resolved
// ---------------------------------------------------------------------------

describe("diffTick: exceptions", () => {
  it("new exceptions in next appear in exceptionsNew", () => {
    const prev = makeSnapshot({ exceptionsOpen: [exc("E1")] });
    const next = makeSnapshot({ exceptionsOpen: [exc("E1"), exc("E2")] });
    const tick = diffTick(prev, next);
    expect(tick.exceptionsNew).toHaveLength(1);
    expect(tick.exceptionsNew?.[0]?.id).toBe("E2");
    expect(tick.exceptionsResolved).toBeUndefined();
  });

  it("exceptions cleared from open list appear in exceptionsResolved", () => {
    const prev = makeSnapshot({ exceptionsOpen: [exc("E1"), exc("E2")] });
    const next = makeSnapshot({ exceptionsOpen: [exc("E1")] });
    const tick = diffTick(prev, next);
    expect(tick.exceptionsResolved).toEqual(["E2"]);
    expect(tick.exceptionsNew).toBeUndefined();
  });

  it("omits exception sections when nothing changed", () => {
    const prev = makeSnapshot({ exceptionsOpen: [exc("E1")] });
    const next = makeSnapshot({ exceptionsOpen: [exc("E1")] });
    const tick = diffTick(prev, next);
    expect(tick.exceptionsNew).toBeUndefined();
    expect(tick.exceptionsResolved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diffTick: KPI partial diff
// ---------------------------------------------------------------------------

describe("diffTick: kpis", () => {
  it("returns a Partial<KpiSnapshot> containing only changed numeric fields", () => {
    const kPrev = zeroKpis();
    const kNext = { ...kPrev, rehandleCount: 3, onTimeDeparture: 0.9 };
    const prev = makeSnapshot({ kpis: kPrev });
    const next = makeSnapshot({ kpis: kNext });
    const tick = diffTick(prev, next);
    expect(tick.kpis).toBeDefined();
    // Changed fields present:
    expect(tick.kpis?.rehandleCount).toBe(3);
    expect(tick.kpis?.onTimeDeparture).toBe(0.9);
    // Unchanged fields absent:
    expect("utilization" in (tick.kpis ?? {})).toBe(false);
  });

  it("omits kpis section entirely when nothing changed", () => {
    const kpis = zeroKpis();
    const prev = makeSnapshot({ kpis });
    const next = makeSnapshot({ kpis: { ...kpis } });
    const tick = diffTick(prev, next);
    expect(tick.kpis).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diffTick: zero-noise invariant (nothing changed -> empty TickPayload)
// ---------------------------------------------------------------------------

describe("diffTick: zero-noise invariant", () => {
  it("returns an empty TickPayload (no keys) when nothing changed", () => {
    const snap = makeSnapshot({
      trailers: [trailer("T1")],
      hubs: [hub("H1")],
      routes: [route("RT1")],
      exceptionsOpen: [exc("E1")],
    });
    const tick = diffTick(snap, snap);
    expect(Object.keys(tick)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// diffTick: determinism (stable ordering by id for identical inputs — P3)
// ---------------------------------------------------------------------------

describe("diffTick: determinism (P3)", () => {
  it("trailer upserts are sorted by id regardless of input order", () => {
    const prev = makeSnapshot({ trailers: [] });
    const t1 = trailer("Z-trailer", "R1", 1000, 2000, "onTime");
    const t2 = trailer("A-trailer", "R2", 1500, 2500, "late");
    const next1 = makeSnapshot({ trailers: [t1, t2] });
    const next2 = makeSnapshot({ trailers: [t2, t1] });
    const tick1 = diffTick(prev, next1);
    const tick2 = diffTick(prev, next2);
    // Both orderings produce identical sorted output
    const ids1 = tick1.trailers?.map((t) => t.id) ?? [];
    const ids2 = tick2.trailers?.map((t) => t.id) ?? [];
    expect(ids1).toEqual(["A-trailer", "Z-trailer"]);
    expect(ids2).toEqual(["A-trailer", "Z-trailer"]);
  });

  it("hub changes are sorted by id for determinism", () => {
    const prev = makeSnapshot({ hubs: [] });
    const next = makeSnapshot({ hubs: [hub("H3"), hub("H1"), hub("H2")] });
    const tick = diffTick(prev, next);
    const ids = tick.hubs?.map((h) => h.id) ?? [];
    expect(ids).toEqual(["H1", "H2", "H3"]);
  });

  it("trailersGone is sorted by id for determinism", () => {
    const prev = makeSnapshot({
      trailers: [trailer("Z"), trailer("A"), trailer("M")],
    });
    const next = makeSnapshot({ trailers: [] });
    const tick = diffTick(prev, next);
    expect(tick.trailersGone).toEqual(["A", "M", "Z"]);
  });

  it("exceptionsResolved is sorted by id for determinism", () => {
    const prev = makeSnapshot({ exceptionsOpen: [exc("E3"), exc("E1"), exc("E2")] });
    const next = makeSnapshot({ exceptionsOpen: [] });
    const tick = diffTick(prev, next);
    expect(tick.exceptionsResolved).toEqual(["E1", "E2", "E3"]);
  });
});
