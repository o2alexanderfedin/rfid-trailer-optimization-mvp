import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUSION_CONFIG,
  type FusionConfig,
  ZONES,
} from "../src/config.js";
import { fuseZone } from "../src/fuse.js";
import { type RfidRead, windowObservations } from "../src/window.js";

/**
 * THE ANTI-P5b KEYSTONE — the single most important test of Plan 03-02.
 *
 * RFID RSSI badly violates the Bayesian independence assumption: a burst of N
 * reads of the SAME tag at the SAME reader in ONE dwell are NOT N independent
 * observations (multipath/interference correlate them). Treating them as N
 * independent updates causes overconfident lock-on (pitfall P5b) — confidence
 * asymptoting to 1.0 from mere repetition.
 *
 * This keystone proves the two-layer defense holds:
 *   1. DWELL COLLAPSE — `windowObservations` turns N identical reads into
 *      exactly ONE observation packet (not N updates).
 *   2. BOUNDED CONFIDENCE — the likelihood cap (0.85) + the entropy floor make
 *      the fused confidence STRICTLY < 1.0 and ≤ the configured ceiling, no
 *      matter how large N grows. Monotonic but bounded; NEVER asymptotic to 1.0.
 */
describe("anti-P5b confidence cap (keystone)", () => {
  const cfg: FusionConfig = {
    ...DEFAULT_FUSION_CONFIG,
    readerZoneEvidence: { "rdr-rear": "rear" },
  };

  /** N strong, identical same-tag/same-dwell rear reads. */
  function strongRearReads(n: number): RfidRead[] {
    return Array.from({ length: n }, () => ({
      tagId: "tag-A",
      readerId: "rdr-rear",
      antennaId: "ant-1",
      trailerId: "trl-1",
      hubId: "hub-1",
      readerType: "dock-portal" as const,
      dwellWindowId: "dw-1",
      observedAt: "2026-06-19T10:00:00.000Z",
      perReadConfidence: 1,
      rssi: -45, // an absurdly strong, pinned signal
    }));
  }

  it("collapses N=100 identical same-dwell reads into ONE observation packet", () => {
    const windowed = windowObservations(strongRearReads(100), cfg);
    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.readCount).toBe(100);
  });

  it("N=100 strong identical reads ⇒ confidence STRICTLY < 1.0 and ≤ ceiling", () => {
    const windowed = windowObservations(strongRearReads(100), cfg);
    const est = fuseZone({ packageId: "pkg-1", prior: cfg.defaultPrior }, windowed, cfg);

    expect(est.estimatedZone).toBe("rear");
    // the two non-negotiable bounds
    expect(est.confidence).toBeLessThan(1.0);
    expect(est.confidence).toBeLessThanOrEqual(cfg.confidenceCeiling);
    // and no zone is ever certain
    for (const z of ZONES) {
      expect(est.posterior[z]).toBeLessThan(1.0);
      expect(est.posterior[z]).toBeGreaterThan(0);
    }
  });

  it("is NOT asymptotic to 1.0 — confidence is bounded as N grows 1 → 10 → 100 → 100000", () => {
    const confidences = [1, 10, 100, 100_000].map((n) => {
      const windowed = windowObservations(strongRearReads(n), cfg);
      return fuseZone({ packageId: "pkg-1", prior: cfg.defaultPrior }, windowed, cfg)
        .confidence;
    });
    // every confidence stays under the ceiling, regardless of N
    for (const c of confidences) {
      expect(c).toBeLessThanOrEqual(cfg.confidenceCeiling);
      expect(c).toBeLessThan(1.0);
    }
    // and the confidence does NOT keep climbing toward 1.0 with N: the N=100000
    // confidence equals the N=100 confidence (both are ONE collapsed packet).
    const cHundred = confidences[2];
    const cHuge = confidences[3];
    expect(cHundred).toBeDefined();
    expect(cHuge).toBeDefined();
    expect(cHuge).toBeCloseTo(cHundred as number, 10);
  });

  it("one collapsed window moves the posterior LESS than 100 independent updates would", () => {
    // The collapse is load-bearing: feeding the SAME 100 reads as 100 SEPARATE
    // windows (the naive, wrong, double-counting path) drives confidence higher
    // than the correct single-window collapse — yet BOTH stay under the ceiling.
    const collapsed = windowObservations(strongRearReads(100), cfg); // 1 window
    const collapsedConf = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      collapsed,
      cfg,
    ).confidence;

    // 100 reads forced into 100 DISTINCT windows (the double-counting we forbid)
    const splitReads: RfidRead[] = strongRearReads(100).map((r, i) => ({
      ...r,
      dwellWindowId: `dw-${i}`,
    }));
    const split = windowObservations(splitReads, cfg); // 100 windows
    expect(split).toHaveLength(100);
    const splitConf = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      split,
      cfg,
    ).confidence;

    // the correct collapse yields LESS confidence than the naive double-count
    expect(collapsedConf).toBeLessThan(splitConf);
    // yet EVEN the double-counted path is bounded by the entropy-floor ceiling —
    // belt and suspenders: the cap holds even if windowing were bypassed.
    expect(splitConf).toBeLessThanOrEqual(cfg.confidenceCeiling);
    expect(splitConf).toBeLessThan(1.0);
  });
});
