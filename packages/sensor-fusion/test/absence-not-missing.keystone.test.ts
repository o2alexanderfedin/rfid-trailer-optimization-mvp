import { describe, expect, it } from "vitest";
import { fuseZone, type ZoneEstimate } from "../src/fuse.js";
import { type RfidRead, windowObservations } from "../src/window.js";
import { DEFAULT_FUSION_CONFIG, type FusionConfig } from "../src/config.js";
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

  it("REAL fusion→detection: a package WITH reads fires; a package with ZERO reads appears NOWHERE", () => {
    // The discriminating invariant (not a string-grep): drive detection off
    // ACTUAL fused estimates produced by the REAL `windowObservations` + `fuseZone`
    // pipeline. pkg-1 gets a strong burst of reads on the WRONG trailer ⇒ a real
    // ZoneEstimate above threshold ⇒ it fires. pkg-2 and pkg-3 get NO reads at all
    // ⇒ no ZoneEstimate is produced for them ⇒ they can never enter detection.
    const fusionCfg: FusionConfig = {
      ...DEFAULT_FUSION_CONFIG,
      readerZoneEvidence: { "rdr-rear": "rear" },
    };

    function strongReads(tagId: string, trailerId: string): RfidRead[] {
      return Array.from({ length: 20 }, () => ({
        tagId,
        readerId: "rdr-rear",
        antennaId: "ant-1",
        trailerId,
        hubId: "hub-1",
        readerType: "dock-portal" as const,
        dwellWindowId: "dw-1",
        observedAt: "2026-06-19T10:00:00.000Z",
        perReadConfidence: 1,
        rssi: -45,
      }));
    }

    // ONLY pkg-1 is read (on the wrong trailer). pkg-2 / pkg-3: ZERO reads.
    const windowed = windowObservations(strongReads("tag-1", "trl-WRONG"), fusionCfg);
    const est1 = fuseZone(
      { packageId: "pkg-1", prior: fusionCfg.defaultPrior, trailerId: "trl-WRONG" },
      windowed,
      fusionCfg,
    );
    // The real engine produced a credible, ABOVE-THRESHOLD, bounded estimate.
    expect(est1.confidence).toBeGreaterThan(cfg.confidenceThreshold);
    expect(est1.confidence).toBeLessThan(1.0); // anti-P5b still holds end-to-end

    // The OBSERVED layer contains EXACTLY the read package — never the unread ones.
    const observedLayer: ZoneEstimate[] = [est1];

    const fired = detectWrongTrailer(plan, observedLayer, cfg);

    // PRESENCE: the read-and-disagreeing package DOES appear (the test can fire).
    expect(fired.map((c) => c.packageId)).toContain("pkg-1");
    // ABSENCE: the unread packages appear NOWHERE — absence is never "missing".
    const flagged = new Set(fired.map((c) => c.packageId));
    expect(flagged.has("pkg-2")).toBe(false);
    expect(flagged.has("pkg-3")).toBe(false);
    // Output size is bounded by the OBSERVED layer (1), not the plan (3).
    expect(fired.length).toBeLessThanOrEqual(observedLayer.length);

    // CONTROL (proves the test discriminates): feed the SAME plan an EMPTY
    // observed layer (every package unread) ⇒ ZERO candidates. If detection ever
    // treated planned-but-absent as "missing", this would be non-empty.
    expect(detectWrongTrailer(plan, [], cfg)).toEqual([]);
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
