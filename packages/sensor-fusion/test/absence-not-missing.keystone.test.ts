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
 * THE ANTI-P6 KEYSTONE — the single most important test of Phase 3.
 *
 * P6 (RFID-as-truth) is the cardinal Phase-3 risk: the naive implementation
 * treats a MISSING read as "the package vanished." RFID's normal failure mode is
 * a dropped read, so absence-as-signal would flood the feed with false
 * "missing" exceptions and collapse the validation story.
 *
 * The structural defense is two-layer (PLANNED vs OBSERVED) + observation-driven
 * detection: the predicates iterate the OBSERVED layer, NEVER the planned set.
 * A package with no observation simply contributes nothing.
 *
 * This keystone LOCKS that guarantee permanently:
 *   - empty observed ⇒ empty output (no candidate type for "missing" even exists)
 *   - partially-observed planned set ⇒ ONLY the observed-and-disagreeing fire
 *   - absence is monotonic: removing all observations ⇒ empty output for ANY plan
 */

const cfg: DetectionConfig = DEFAULT_DETECTION_CONFIG;

function observed(
  packageId: string,
  trailerId: string,
  confidence: number,
): ZoneEstimate {
  return {
    packageId,
    trailerId,
    confidence,
    estimatedZone: "rear",
    posterior: { rear: confidence, middle: (1 - confidence) / 2, nose: (1 - confidence) / 2 },
    lastReliableCheckpoint: null,
    lastObservedAt: "2026-06-19T10:00:00.000Z",
  };
}

describe("anti-P6 keystone — absence of reads ⇒ ZERO exceptions, never 'missing'", () => {
  // A real plan: packages assigned to trailers and hubs.
  const plan: PlannedAssignment[] = [
    { packageId: "pkg-1", plannedTrailerId: "trl-A", destHubId: "hub-9" },
    { packageId: "pkg-2", plannedTrailerId: "trl-A", destHubId: "hub-9" },
    { packageId: "pkg-3", plannedTrailerId: "trl-B", destHubId: "hub-9" },
  ];
  const departedHub = "hub-9";

  it("EMPTY observed array ⇒ detectWrongTrailer returns EMPTY (never 'missing')", () => {
    expect(detectWrongTrailer(plan, [], cfg)).toEqual([]);
  });

  it("EMPTY observed array ⇒ detectMissedUnload returns EMPTY (absence ≠ aboard)", () => {
    expect(detectMissedUnload(plan, [], departedHub, cfg)).toEqual([]);
  });

  it("a candidate's shape NEVER contains a 'missing'/'vanished' marker", () => {
    // Even when a candidate DOES fire (positive disagreement), nothing in it
    // encodes "missing". The only candidate kinds are wrong-trailer / missed-unload,
    // both driven by a POSITIVE observation.
    const wrong = detectWrongTrailer(
      plan,
      [observed("pkg-1", "trl-WRONG", 0.9)],
      cfg,
    );
    const serialized = JSON.stringify(wrong).toLowerCase();
    expect(serialized).not.toContain("missing");
    expect(serialized).not.toContain("vanished");
    expect(serialized).not.toContain("gone");
  });

  it("PARTIALLY observed plan ⇒ only the OBSERVED-and-disagreeing package fires; unobserved produce NOTHING", () => {
    // pkg-1 is observed in the WRONG trailer (fires). pkg-2 and pkg-3 have NO
    // observation at all — they must NOT be flagged missing/vanished.
    const obs = [observed("pkg-1", "trl-WRONG", 0.9)];

    const out = detectWrongTrailer(plan, obs, cfg);

    expect(out).toHaveLength(1);
    expect(out[0]?.packageId).toBe("pkg-1");
    // pkg-2 and pkg-3 (unobserved) appear NOWHERE in the output
    const flaggedIds = out.map((c) => c.packageId);
    expect(flaggedIds).not.toContain("pkg-2");
    expect(flaggedIds).not.toContain("pkg-3");
  });

  it("package planned FOR the departed hub with NO post-departure observation ⇒ no missed-unload", () => {
    // pkg-1 is for the departed hub but is NOT observed ⇒ absence does NOT imply
    // it is still aboard. pkg-2 IS observed (still aboard) ⇒ fires.
    const obs = [observed("pkg-2", "trl-A", 0.85)];

    const out = detectMissedUnload(plan, obs, departedHub, cfg);

    expect(out).toHaveLength(1);
    expect(out[0]?.packageId).toBe("pkg-2");
    expect(out.map((c) => c.packageId)).not.toContain("pkg-1");
  });

  it("PROPERTY: removing all observations ⇒ empty output for any plan (absence is monotonic)", () => {
    const plans: PlannedAssignment[][] = [
      [],
      [{ packageId: "x", plannedTrailerId: "t", destHubId: "h" }],
      plan,
      Array.from({ length: 50 }, (_, i) => ({
        packageId: `p${i}`,
        plannedTrailerId: i % 2 === 0 ? `t${i}` : null,
        destHubId: "hub-9",
      })),
    ];
    for (const p of plans) {
      expect(detectWrongTrailer(p, [], cfg)).toEqual([]);
      expect(detectMissedUnload(p, [], "hub-9", cfg)).toEqual([]);
    }
  });

  it("PROPERTY: candidate count never exceeds the number of OBSERVATIONS (observation-driven, not plan-driven)", () => {
    // A huge plan with a single observation can produce AT MOST one candidate.
    const bigPlan: PlannedAssignment[] = Array.from({ length: 1000 }, (_, i) => ({
      packageId: `pkg-${i}`,
      plannedTrailerId: "trl-A",
      destHubId: "hub-9",
    }));
    const obs = [observed("pkg-7", "trl-WRONG", 0.9)];

    expect(detectWrongTrailer(bigPlan, obs, cfg).length).toBeLessThanOrEqual(obs.length);
    expect(detectMissedUnload(bigPlan, obs, "hub-9", cfg).length).toBeLessThanOrEqual(obs.length);
  });
});
