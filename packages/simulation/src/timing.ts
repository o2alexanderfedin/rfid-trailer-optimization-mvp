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
 */

import type { Rng } from "./rng.js";

/**
 * Parameters of a clamped log-normal draw, in MINUTES (1 tick = 1 minute).
 *
 *  - `median` is the geometric median (the `exp(mu)` scale): half the mass falls
 *    below it. It is the typical, unskewed value.
 *  - `sigma` is the log-space standard deviation; larger ⇒ heavier right tail.
 *  - `min` / `max` clamp the result to a sane operational band.
 */
export interface LogNormalParams {
  /** Geometric median in minutes (`exp(mu)`). Must be > 0. */
  readonly median: number;
  /** Log-space standard deviation (spread / skew). Must be >= 0. */
  readonly sigma: number;
  /** Lower clamp in minutes (inclusive). */
  readonly min: number;
  /** Upper clamp in minutes (inclusive). */
  readonly max: number;
}

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

/**
 * Injectable (DIP) timing configuration the engine draws from. Tests may pass an
 * override to pin or widen the distributions; the engine uses
 * {@link DEFAULT_TIMING_CONFIG} when none is supplied.
 *
 * Dwell is split by HUB ROLE: a center hub (cross-dock, reload, contention) sits
 * longer than a spoke. Transit is a single distribution around a typical leg.
 */
export interface TimingConfig {
  /** Hub-dwell distribution at a SPOKE hub (minutes). */
  readonly dwellSpoke: LogNormalParams;
  /** Hub-dwell distribution at the CENTER hub (minutes). */
  readonly dwellCenter: LogNormalParams;
  /** Leg-transit distribution (minutes). */
  readonly transit: LogNormalParams;
}

/**
 * Default timing distributions (minutes). Spoke dwell ~25, center dwell ~60
 * (longer cross-dock), transit ~30 — matching the prior fixed constants at the
 * median while adding realistic right-skewed spread.
 */
export const DEFAULT_TIMING_CONFIG: TimingConfig = {
  dwellSpoke: { median: 25, sigma: 0.4, min: 10, max: 180 },
  dwellCenter: { median: 60, sigma: 0.4, min: 10, max: 180 },
  transit: { median: 30, sigma: 0.3, min: 10, max: 120 },
};
