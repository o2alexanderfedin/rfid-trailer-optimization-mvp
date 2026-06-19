import { describe, expect, it } from "vitest";
import type { ZoneEstimate } from "../src/fuse.js";
import {
  DEFAULT_DETECTION_CONFIG,
  type DetectionConfig,
  detectMissedUnload,
  detectWrongTrailer,
  type PlannedAssignment,
} from "../src/detection.js";

/**
 * Plan 03-04 — the PURE detection predicates (SNS-04 wrong-trailer, SNS-05
 * missed-unload). These are TRUTH TABLES over the two explicit layers:
 *
 *   PLANNED/KNOWN   — `PlannedAssignment[]` (from the Phase-2 plan + scans;
 *                     assembled by Plan 06, typed here so the predicate is pure).
 *   OBSERVED        — `ZoneEstimate[]` (the confidence-scored RFID estimate from
 *                     Plan 02's fusion — consumed ONE-WAY).
 *
 * A candidate exception fires ONLY on positive disagreement ABOVE the confidence
 * threshold. The anti-P6 keystone (absence ⇒ nothing) lives in its own file.
 */

const cfg: DetectionConfig = DEFAULT_DETECTION_CONFIG;

/** A minimal OBSERVED estimate — the fusion output the detector reads one-way. */
function observed(
  over: Pick<ZoneEstimate, "packageId" | "trailerId" | "confidence"> &
    Partial<ZoneEstimate>,
): ZoneEstimate {
  return {
    estimatedZone: "rear",
    posterior: { rear: over.confidence, middle: (1 - over.confidence) / 2, nose: (1 - over.confidence) / 2 },
    lastReliableCheckpoint: null,
    lastObservedAt: "2026-06-19T10:00:00.000Z",
    ...over,
  };
}

function planned(over: Partial<PlannedAssignment> & Pick<PlannedAssignment, "packageId">): PlannedAssignment {
  return {
    plannedTrailerId: "trl-PLANNED",
    destHubId: "hub-1",
    ...over,
  };
}

describe("detectWrongTrailer (SNS-04) — truth table", () => {
  it("positive obs in an UNASSIGNED (wrong) trailer ABOVE threshold ⇒ exactly ONE candidate", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.8 })];

    const out = detectWrongTrailer(plan, obs, cfg);

    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.packageId).toBe("pkg-1");
    expect(c?.observedTrailerId).toBe("trl-B");
    expect(c?.plannedTrailerId).toBe("trl-A");
    expect(c?.confidence).toBe(0.8);
  });

  it("each candidate carries a severity AND a non-empty recommendedAction", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.8 })];

    const c = detectWrongTrailer(plan, obs, cfg)[0];

    expect(["info", "warning", "critical"]).toContain(c?.severity);
    expect(typeof c?.recommendedAction).toBe("string");
    expect((c?.recommendedAction ?? "").length).toBeGreaterThan(0);
  });

  it("positive obs in the CORRECT (planned) trailer ⇒ ZERO candidates", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-A", confidence: 0.95 })];

    expect(detectWrongTrailer(plan, obs, cfg)).toEqual([]);
  });

  it("obs in a WRONG trailer but BELOW threshold ⇒ ZERO candidates (noise suppressed)", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: cfg.confidenceThreshold - 0.01 })];

    expect(detectWrongTrailer(plan, obs, cfg)).toEqual([]);
  });

  it("obs in a WRONG trailer EXACTLY AT threshold ⇒ ZERO candidates (strict >)", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: cfg.confidenceThreshold })];

    expect(detectWrongTrailer(plan, obs, cfg)).toEqual([]);
  });

  it("observed package with NO planned assignment (plannedTrailerId null) ⇒ ZERO candidates", () => {
    // Cannot disagree with a plan that does not exist — log-worthy, not an exception.
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: null })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.95 })];

    expect(detectWrongTrailer(plan, obs, cfg)).toEqual([]);
  });

  it("observed package with NO planned record at all ⇒ ZERO candidates", () => {
    const obs = [observed({ packageId: "pkg-unknown", trailerId: "trl-B", confidence: 0.95 })];

    expect(detectWrongTrailer([], obs, cfg)).toEqual([]);
  });

  it("escalates recommendedAction to block_departure when confidence is HIGH", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const lowish = detectWrongTrailer(
      plan,
      [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.65 })],
      cfg,
    )[0];
    const high = detectWrongTrailer(
      plan,
      [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.84 })],
      cfg,
    )[0];

    expect(lowish?.recommendedAction).toBe("recheck_before_departure");
    expect(high?.recommendedAction).toBe("block_departure");
    expect(high?.severity).toBe("critical");
  });

  it("output is deterministically ordered by packageId (independent of input order)", () => {
    const plan = [
      planned({ packageId: "pkg-3", plannedTrailerId: "trl-A" }),
      planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" }),
      planned({ packageId: "pkg-2", plannedTrailerId: "trl-A" }),
    ];
    const obs = [
      observed({ packageId: "pkg-3", trailerId: "trl-X", confidence: 0.8 }),
      observed({ packageId: "pkg-1", trailerId: "trl-X", confidence: 0.8 }),
      observed({ packageId: "pkg-2", trailerId: "trl-X", confidence: 0.8 }),
    ];

    const ids = detectWrongTrailer(plan, obs, cfg).map((c) => c.packageId);
    expect(ids).toEqual(["pkg-1", "pkg-2", "pkg-3"]);
  });

  it("is PURE: same input ⇒ deeply-equal output", () => {
    const plan = [planned({ packageId: "pkg-1", plannedTrailerId: "trl-A" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-B", confidence: 0.8 })];
    expect(detectWrongTrailer(plan, obs, cfg)).toEqual(detectWrongTrailer(plan, obs, cfg));
  });
});

describe("detectMissedUnload (SNS-05) — truth table", () => {
  const departedHub = "hub-9";

  it("package FOR the departed hub still observed ABOVE threshold post-departure ⇒ ONE candidate", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: departedHub })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: 0.8 })];

    const out = detectMissedUnload(plan, obs, departedHub, cfg);

    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.packageId).toBe("pkg-1");
    expect(c?.trailerId).toBe("trl-1");
    expect(c?.hubId).toBe(departedHub);
    expect(c?.confidence).toBe(0.8);
    expect(["info", "warning", "critical"]).toContain(c?.severity);
    expect((c?.recommendedAction ?? "").length).toBeGreaterThan(0);
  });

  it("package unloaded (NO LONGER observed) ⇒ ZERO candidates (absence ≠ aboard)", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: departedHub })];
    // it WAS for this hub, but there is no post-departure observation of it
    expect(detectMissedUnload(plan, [], departedHub, cfg)).toEqual([]);
  });

  it("package NOT destined for the departed hub ⇒ ZERO candidates", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: "hub-OTHER" })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: 0.95 })];

    expect(detectMissedUnload(plan, obs, departedHub, cfg)).toEqual([]);
  });

  it("package for the departed hub observed BELOW threshold ⇒ ZERO candidates", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: departedHub })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: cfg.confidenceThreshold - 0.01 })];

    expect(detectMissedUnload(plan, obs, departedHub, cfg)).toEqual([]);
  });

  it("recommendedAction is one of the over-carry recovery actions", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: departedHub })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: 0.8 })];

    const action = detectMissedUnload(plan, obs, departedHub, cfg)[0]?.recommendedAction;
    expect(["return_to_hub", "cross_dock", "over_carry", "transfer"]).toContain(action);
  });

  it("output is deterministically ordered by packageId", () => {
    const plan = [
      planned({ packageId: "pkg-3", destHubId: departedHub }),
      planned({ packageId: "pkg-1", destHubId: departedHub }),
      planned({ packageId: "pkg-2", destHubId: departedHub }),
    ];
    const obs = [
      observed({ packageId: "pkg-3", trailerId: "trl-1", confidence: 0.8 }),
      observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: 0.8 }),
      observed({ packageId: "pkg-2", trailerId: "trl-1", confidence: 0.8 }),
    ];

    const ids = detectMissedUnload(plan, obs, departedHub, cfg).map((c) => c.packageId);
    expect(ids).toEqual(["pkg-1", "pkg-2", "pkg-3"]);
  });

  it("is PURE: same input ⇒ deeply-equal output", () => {
    const plan = [planned({ packageId: "pkg-1", destHubId: departedHub })];
    const obs = [observed({ packageId: "pkg-1", trailerId: "trl-1", confidence: 0.8 })];
    expect(detectMissedUnload(plan, obs, departedHub, cfg)).toEqual(
      detectMissedUnload(plan, obs, departedHub, cfg),
    );
  });
});

describe("DetectionConfig", () => {
  it("default confidenceThreshold is a conservative gate in (0, 1)", () => {
    expect(cfg.confidenceThreshold).toBeGreaterThan(0);
    expect(cfg.confidenceThreshold).toBeLessThan(1);
  });

  it("severityFor maps higher confidence × SLA impact to higher severity", () => {
    const low = cfg.severityFor(0.65, "low");
    const high = cfg.severityFor(0.95, "high");
    const rank = { info: 0, warning: 1, critical: 2 } as const;
    expect(rank[high]).toBeGreaterThanOrEqual(rank[low]);
  });
});
