import { describe, expect, it } from "vitest";
import { makeRng } from "../src/rng.js";
import {
  DEFAULT_TIMING_CONFIG,
  sampleLogNormal,
  type LogNormalParams,
} from "../src/timing.js";

/**
 * SIM-02 timing — the seeded log-normal sampler.
 *
 * `sampleLogNormal(rng, {median, sigma, min, max})` must be pure + deterministic
 * (same seed ⇒ same sequence), centred near `median`, genuinely spread (a real
 * right-skewed tail), clamped to `[min, max]`, and finite even on the `u1 === 0`
 * draw. These are the properties the engine's determinism contract relies on.
 */

const TRANSIT: LogNormalParams = DEFAULT_TIMING_CONFIG.transit; // median 30, sigma 0.3, [10,120]

describe("sampleLogNormal", () => {
  it("is deterministic: same seed ⇒ byte-identical sequence of draws", () => {
    const a = makeRng(2026);
    const b = makeRng(2026);
    const seqA = Array.from({ length: 100 }, () => sampleLogNormal(a, TRANSIT));
    const seqB = Array.from({ length: 100 }, () => sampleLogNormal(b, TRANSIT));
    expect(seqA).toEqual(seqB);
  });

  it("different seeds ⇒ different sequences", () => {
    const a = makeRng(1);
    const b = makeRng(2);
    const seqA = Array.from({ length: 50 }, () => sampleLogNormal(a, TRANSIT));
    const seqB = Array.from({ length: 50 }, () => sampleLogNormal(b, TRANSIT));
    expect(seqA).not.toEqual(seqB);
  });

  it("over N≥2000 draws the sample median ≈ target median (within ~10%) with real spread", () => {
    const rng = makeRng(777);
    const N = 5000;
    const draws = Array.from({ length: N }, () => sampleLogNormal(rng, TRANSIT)).sort(
      (x, y) => x - y,
    );

    const median = draws[Math.floor(N / 2)]!;
    const p90 = draws[Math.floor(N * 0.9)]!;
    const p10 = draws[Math.floor(N * 0.1)]!;

    // Median lands within ~10% of the target (30).
    expect(median).toBeGreaterThan(TRANSIT.median * 0.9);
    expect(median).toBeLessThan(TRANSIT.median * 1.1);

    // Real, right-skewed spread: p90 well above the median, p10 below it, and
    // the upper tail stretches further from the median than the lower (skew).
    expect(p90).toBeGreaterThan(median);
    expect(p10).toBeLessThan(median);
    expect(p90 - median).toBeGreaterThan(median - p10);
  });

  it("clamps every draw to [min, max] (tight band forces the clamp to bite)", () => {
    const rng = makeRng(12345);
    const tight: LogNormalParams = { median: 30, sigma: 2, min: 20, max: 40 };
    let sawMin = false;
    let sawMax = false;
    for (let i = 0; i < 5000; i += 1) {
      const v = sampleLogNormal(rng, tight);
      expect(v).toBeGreaterThanOrEqual(tight.min);
      expect(v).toBeLessThanOrEqual(tight.max);
      if (v === tight.min) sawMin = true;
      if (v === tight.max) sawMax = true;
    }
    // A wide sigma against a tight band must hit both clamp rails.
    expect(sawMin).toBe(true);
    expect(sawMax).toBe(true);
  });

  it("u1 === 0 guard: a degenerate rng returning 0 yields a finite clamped value", () => {
    // An rng whose next() always returns 0 would make ln(u1) = -Infinity without
    // the guard; with the floor it must produce a finite, in-band result.
    const zeroRng = { next: () => 0, int: () => 0, pick: <T>(xs: readonly T[]) => xs[0]! };
    const v = sampleLogNormal(zeroRng, TRANSIT);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(TRANSIT.min);
    expect(v).toBeLessThanOrEqual(TRANSIT.max);
  });

  it("center dwell (median 60) sits above spoke dwell (median 25) on average", () => {
    const rng = makeRng(99);
    const N = 4000;
    let spokeSum = 0;
    let centerSum = 0;
    for (let i = 0; i < N; i += 1) {
      spokeSum += sampleLogNormal(rng, DEFAULT_TIMING_CONFIG.dwellSpoke);
      centerSum += sampleLogNormal(rng, DEFAULT_TIMING_CONFIG.dwellCenter);
    }
    expect(centerSum / N).toBeGreaterThan(spokeSum / N);
  });
});
