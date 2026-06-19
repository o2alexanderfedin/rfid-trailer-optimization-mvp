import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUSION_CONFIG,
  type FusionConfig,
  type Zone,
  type ZoneDistribution,
  ZONES,
} from "../src/config.js";
import { fuseZone, type ZoneEstimate } from "../src/fuse.js";
import type { WindowedObservation } from "../src/window.js";

/**
 * Task 2 — `fuseZone` (SNS-03): rule-based Bayesian zone posterior with a Markov
 * transition prior and an entropy floor. This is the OBSERVED engine and the
 * anti-P5b boundary (the dedicated keystone lives in
 * `confidence-cap.keystone.test.ts`; the bounded-confidence invariants are also
 * exercised here).
 */

/** A reader-zone-evidence config: rdr-rear ⇒ rear, rdr-mid ⇒ middle, rdr-nose ⇒ nose. */
const cfg: FusionConfig = {
  ...DEFAULT_FUSION_CONFIG,
  readerZoneEvidence: {
    "rdr-rear": "rear",
    "rdr-mid": "middle",
    "rdr-nose": "nose",
  },
};

function obs(over: Partial<WindowedObservation> & Pick<WindowedObservation, "readerId">): WindowedObservation {
  return {
    tagId: "tag-A",
    readerId: over.readerId,
    dwellWindowId: "dw-1",
    antennaId: "ant-1",
    trailerId: "trl-1",
    hubId: "hub-1",
    readerType: "trailer-antenna",
    aggregatedRssi: -50,
    readCount: 20,
    lastObservedAt: "2026-06-19T10:00:00.000Z",
    ...over,
  };
}

function sum(d: ZoneDistribution): number {
  return ZONES.reduce((s, z) => s + d[z], 0);
}

describe("fuseZone", () => {
  it("returns a §8.4 ZoneEstimate with packageId/trailerId/estimatedZone/confidence", () => {
    const est: ZoneEstimate = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      [obs({ readerId: "rdr-rear" })],
      cfg,
    );
    expect(est.packageId).toBe("pkg-1");
    expect(est.trailerId).toBe("trl-1");
    expect(ZONES).toContain(est.estimatedZone);
    expect(est.confidence).toBeGreaterThan(0);
    expect(est.confidence).toBeLessThan(1);
    expect(est.lastObservedAt).toBe("2026-06-19T10:00:00.000Z");
  });

  it("a single strong rear observation ⇒ estimatedZone = 'rear', confidence ≤ ceiling", () => {
    const est = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      [obs({ readerId: "rdr-rear", aggregatedRssi: -46, readCount: 30 })],
      cfg,
    );
    expect(est.estimatedZone).toBe("rear");
    expect(est.confidence).toBeLessThanOrEqual(cfg.confidenceCeiling);
    expect(est.confidence).toBeLessThan(1);
  });

  it("Markov prior blocks an impossible rear→nose jump in one step", () => {
    // Start CERTAIN-ish at rear, then feed a single nose observation. The Markov
    // transition prior gives rear→nose only `transitionFloor` mass, so one step
    // cannot teleport the posterior to nose.
    const rearHeavy: ZoneDistribution = { rear: 0.96, middle: 0.02, nose: 0.02 };
    const est = fuseZone(
      { packageId: "pkg-1", prior: rearHeavy },
      [obs({ readerId: "rdr-nose", aggregatedRssi: -46, readCount: 30 })],
      cfg,
    );
    expect(est.estimatedZone).not.toBe("nose");
    // nose posterior stays small after a single impossible-jump step
    expect(est.posterior.nose).toBeLessThan(0.5);
  });

  it("entropy floor keeps every zone probability strictly < 1.0 after many updates", () => {
    const many: WindowedObservation[] = Array.from({ length: 50 }, (_, i) =>
      obs({ readerId: "rdr-rear", dwellWindowId: `dw-${i}`, aggregatedRssi: -46, readCount: 40 }),
    );
    const est = fuseZone({ packageId: "pkg-1", prior: cfg.defaultPrior }, many, cfg);
    for (const z of ZONES) {
      expect(est.posterior[z]).toBeLessThan(1);
      expect(est.posterior[z]).toBeGreaterThan(0);
    }
    expect(est.confidence).toBeLessThanOrEqual(cfg.confidenceCeiling);
  });

  it("posterior is always a normalized distribution (sums to ~1)", () => {
    const est = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      [obs({ readerId: "rdr-mid" }), obs({ readerId: "rdr-mid", dwellWindowId: "dw-2" })],
      cfg,
    );
    expect(sum(est.posterior)).toBeCloseTo(1, 6);
  });

  it("empty observations ⇒ returns the prior-derived estimate unchanged", () => {
    const prior: ZoneDistribution = { rear: 0.5, middle: 0.3, nose: 0.2 };
    const est = fuseZone(
      { packageId: "pkg-1", prior, trailerId: "trl-9", lastObservedAt: "2026-06-19T09:00:00.000Z" },
      [],
      cfg,
    );
    // estimate reflects the prior argmax, no observation movement
    expect(est.estimatedZone).toBe("rear");
    expect(est.posterior).toEqual(prior);
    expect(est.confidence).toBe(0.5);
    expect(est.trailerId).toBe("trl-9");
    expect(est.lastObservedAt).toBe("2026-06-19T09:00:00.000Z");
  });

  it("is pure: same input ⇒ same output", () => {
    const args = (): readonly [{ packageId: string; prior: ZoneDistribution }, WindowedObservation[], FusionConfig] => [
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      [obs({ readerId: "rdr-rear" })],
      cfg,
    ];
    const a = fuseZone(...args());
    const b = fuseZone(...args());
    expect(a).toEqual(b);
  });

  it("estimatedZone is the argmax of the posterior", () => {
    const est = fuseZone(
      { packageId: "pkg-1", prior: cfg.defaultPrior },
      [obs({ readerId: "rdr-nose", aggregatedRssi: -46, readCount: 30 }),
       obs({ readerId: "rdr-nose", dwellWindowId: "dw-2", aggregatedRssi: -46, readCount: 30 })],
      cfg,
    );
    const argmax = ZONES.reduce<Zone>(
      (best, z) => (est.posterior[z] > est.posterior[best] ? z : best),
      "rear",
    );
    expect(est.estimatedZone).toBe(argmax);
  });
});
