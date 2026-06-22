/**
 * Shared timing contract (the SINGLE source of truth for hub-dwell and
 * leg-transit distributions). Lives in `@mm/domain` — the zero-(workspace-)dep
 * leaf both `@mm/simulation` and `@mm/optimizer` import — so the simulator's
 * RANDOM draw and the optimizer's DETERMINISTIC planning estimate read the same
 * config without a circular dependency (DRY; v1.1 OPT-10 / TIME-01 foundation).
 *
 *  - `@mm/simulation` draws random minutes via `sampleLogNormal(rng, params)`.
 *  - `@mm/optimizer` (Phase 7) plans against `expectedMinutes(params)` — the
 *    closed-form MEAN of the same distribution.
 *
 * All values are MINUTES (1 sim tick = 1 minute). This module is PURE: no clock,
 * no RNG, no I/O.
 */

/**
 * Parameters of a clamped log-normal draw, in MINUTES.
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
 * Injectable (DIP) timing configuration. Tests may pass an override to pin or
 * widen the distributions; the engine uses {@link DEFAULT_TIMING_CONFIG} when
 * none is supplied.
 *
 * Dwell is split by HUB ROLE: a center hub (cross-dock, reload, contention) sits
 * longer than a spoke. Transit is a single distribution around a typical leg
 * (per-leg medians are derived from real road distance in TIME-01).
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

/**
 * The deterministic planning estimate (in minutes) for a log-normal timing
 * distribution: its **mean**, `clamp(median · exp(σ² / 2), min, max)`.
 *
 * Why the mean (not the median, not a percentile)? For a log-normal,
 * `median = exp(μ)` but `mean = exp(μ + σ²/2) = median · exp(σ²/2) ≥ median`.
 * The mean is the long-run average the simulator actually produces, so a planner
 * using it is UNBIASED w.r.t. realized throughput — the median would make plans
 * systematically optimistic (it ignores the right tail), a high percentile
 * over-conservative. (v1.1 design decision, OPT-10; see `.planning/research`.)
 *
 * Pure and deterministic: identical `params` ⇒ identical result. The clamp keeps
 * the estimate inside the same operational band as the sampler's draws.
 *
 * @param params Median / sigma / clamp band (minutes).
 * @returns The clamped distribution mean, in minutes.
 */
export function expectedMinutes(params: LogNormalParams): number {
  const { median, sigma, min, max } = params;
  const mean = median * Math.exp((sigma * sigma) / 2);
  return Math.min(max, Math.max(min, mean));
}
