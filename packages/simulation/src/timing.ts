/**
 * SIM-02 timing: seeded log-normal draws for hub-dwell and leg-transit minutes.
 *
 * Real middle-mile dwell and transit times are right-skewed (a long thin tail of
 * slow legs / congested hubs), which a fixed constant cannot model. We draw them
 * from a LOG-NORMAL distribution so the median is the typical value and the tail
 * stretches right, while staying fully DETERMINISTIC: every draw flows through a
 * seeded {@link Rng}, so the same seed yields the same minutes on every platform.
 *
 * The engine feeds these draws from a DEDICATED timing substream (a seed-derived
 * Rng) so adding timing variance never perturbs the operational / RFID / over-carry
 * draws — the determinism contract (threat T-01-15) is preserved.
 *
 * v1.1: the distribution config ({@link LogNormalParams}, {@link TimingConfig},
 * {@link DEFAULT_TIMING_CONFIG}) and the deterministic mean estimator
 * ({@link expectedMinutes}) now live in `@mm/domain` — the shared leaf the
 * optimizer also reads — so the simulator's random draw and the planner's
 * estimate use ONE source of truth (DRY). This module keeps the seeded SAMPLER
 * and re-exports the config for back-compat.
 */

import type { LogNormalParams } from "@mm/domain";
import type { Rng } from "./rng.js";

// Re-export the shared timing contract so existing `./timing.js` importers
// (engine.ts, the package index) keep working unchanged.
export type { LogNormalParams, TimingConfig } from "@mm/domain";
export { DEFAULT_TIMING_CONFIG, expectedMinutes } from "@mm/domain";

/**
 * Draw one clamped log-normal value (minutes) from the seeded `rng`.
 *
 * Box–Muller transform: two uniforms `u1, u2` in `[0, 1)` map to a standard
 * normal `z = sqrt(-2 ln u1) * cos(2π u2)`; the log-normal value is then
 * `median * exp(sigma * z)`, clamped to `[min, max]`.
 *
 * `u1` is floored at {@link Number.MIN_VALUE} before `ln` so the log is always
 * finite even on the (measure-zero but reachable) `u1 === 0` draw — guaranteeing
 * a finite, well-defined result for every seed.
 *
 * Pure and deterministic: identical `rng` state ⇒ identical sequence of draws.
 *
 * @param rng    Seeded random source — advanced by exactly two `next()` calls.
 * @param params Median / sigma / clamp band (minutes).
 * @returns A finite value in `[min, max]` (minutes).
 */
export function sampleLogNormal(rng: Rng, params: LogNormalParams): number {
  const { median, sigma, min, max } = params;

  // Box–Muller needs ln(u1); guard u1 === 0 so ln is finite (u1 ∈ (0, 1)).
  const u1Raw = rng.next();
  const u1 = u1Raw <= 0 ? Number.MIN_VALUE : u1Raw;
  const u2 = rng.next();

  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = median * Math.exp(sigma * z);

  // Clamp to the operational band (handles the long right tail + any underflow).
  return Math.min(max, Math.max(min, value));
}
