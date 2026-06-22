import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMING_CONFIG,
  expectedMinutes,
  type LogNormalParams,
} from "./timing.js";

/**
 * OPT-10 foundation: `expectedMinutes` is the single, pure, deterministic
 * estimator that maps a log-normal timing distribution to ONE planning value —
 * the distribution MEAN, `clamp(median · exp(σ²/2), min, max)`. The optimizer
 * (Phase 7) plans against this so the same `TimingConfig` drives both the
 * simulator's random draw (`sampleLogNormal`) and the planner's estimate (DRY).
 */
describe("expectedMinutes (log-normal mean estimator)", () => {
  it("returns the analytic mean median·exp(σ²/2) for the default transit dist", () => {
    // median 30, σ 0.3 → 30 · exp(0.045) ≈ 31.38, inside [10,120]
    expect(expectedMinutes(DEFAULT_TIMING_CONFIG.transit)).toBeCloseTo(
      30 * Math.exp(0.3 ** 2 / 2),
      6,
    );
    expect(expectedMinutes(DEFAULT_TIMING_CONFIG.transit)).toBeCloseTo(31.3808, 3);
  });

  it("computes spoke and center dwell means from the default config", () => {
    // spoke: 25·exp(0.08) ≈ 27.08 ; center: 60·exp(0.08) ≈ 64.99
    expect(expectedMinutes(DEFAULT_TIMING_CONFIG.dwellSpoke)).toBeCloseTo(27.082, 2);
    expect(expectedMinutes(DEFAULT_TIMING_CONFIG.dwellCenter)).toBeCloseTo(64.997, 2);
  });

  it("equals the median when σ = 0 (degenerate, no skew)", () => {
    const p: LogNormalParams = { median: 30, sigma: 0, min: 10, max: 120 };
    expect(expectedMinutes(p)).toBe(30);
  });

  it("is always >= the median for σ > 0 (mean of a log-normal ≥ its median)", () => {
    const p: LogNormalParams = { median: 42, sigma: 0.5, min: 1, max: 10_000 };
    expect(expectedMinutes(p)).toBeGreaterThan(42);
  });

  it("clamps to max when the mean exceeds the upper band", () => {
    // 100·exp(0.5) ≈ 164.9 → clamped to 120
    const p: LogNormalParams = { median: 100, sigma: 1.0, min: 10, max: 120 };
    expect(expectedMinutes(p)).toBe(120);
  });

  it("clamps to min when the mean falls below the lower band", () => {
    // σ 0 → mean 5, below min 10 → clamped to 10
    const p: LogNormalParams = { median: 5, sigma: 0, min: 10, max: 120 };
    expect(expectedMinutes(p)).toBe(10);
  });

  it("is pure/deterministic — identical input yields identical output", () => {
    const p: LogNormalParams = { median: 37, sigma: 0.33, min: 10, max: 200 };
    expect(expectedMinutes(p)).toBe(expectedMinutes(p));
  });

  it("DEFAULT_TIMING_CONFIG retains the v1.0 distribution constants (no behavior drift)", () => {
    expect(DEFAULT_TIMING_CONFIG).toEqual({
      dwellSpoke: { median: 25, sigma: 0.4, min: 10, max: 180 },
      dwellCenter: { median: 60, sigma: 0.4, min: 10, max: 180 },
      transit: { median: 30, sigma: 0.3, min: 10, max: 120 },
    });
  });
});
