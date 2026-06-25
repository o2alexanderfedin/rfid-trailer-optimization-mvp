/**
 * `@mm/api` — PURE accumulator pacing helpers (spec §4).
 *
 * The fixed-cadence accumulator decouples wall-clock frame rate from sim speed:
 * each frame advances a `simClock` by `wallDelta × rate × multiplier` and drains
 * every pre-baked tick whose `occurredAt ≤ simClock`, bounded by a per-frame
 * budget. These two functions are the MATH of that — nothing else.
 *
 * DETERMINISM CONTRACT: these are PURE functions of their numeric inputs. They
 * hold NO state, do NO I/O, and NEVER read `Date.now()` / `performance.now()` —
 * the wall-clock delta is MEASURED by the caller and passed in. Pacing therefore
 * cannot perturb the deterministic event stream (it never reaches `simulate`).
 *
 * Speed-math identity: `rate = msPerTick / defaultIntervalMs = 60000/500 = 120`
 * sim-ms per wall-ms at 1×; so at multiplier `m`, the clock advances
 * `wallDeltaMs × 120 × m`.
 */

/** Default clamp for the measured wall delta (guards huge post-stall/GC jumps). */
const DEFAULT_MAX_WALL_DELTA_MS = 1000;

/** Arguments for {@link computeSimAdvanceMs}. */
export interface ComputeSimAdvanceArgs {
  /** Measured wall-clock ms elapsed since the last frame (>= 0; negatives → 0). */
  readonly wallDeltaMs: number;
  /** Speed multiplier (0 = paused ⇒ no advance). */
  readonly multiplier: number;
  /** Sim-ms advanced per tick (= the engine's MS_PER_TICK, 60_000). */
  readonly msPerTick: number;
  /** The 1× wall-clock baseline interval (500). */
  readonly defaultIntervalMs: number;
  /** Clamp huge wall gaps (default 1000ms). */
  readonly maxWallDeltaMs?: number;
}

/**
 * Sim-ms to advance this frame. PURE.
 *
 * `= clampedWallDelta × (msPerTick / defaultIntervalMs) × multiplier`, where
 * `clampedWallDelta = clamp(wallDeltaMs, 0, maxWallDeltaMs)`. A paused
 * (`multiplier === 0`) or non-positive wall delta yields 0 — the clock freezes.
 */
export function computeSimAdvanceMs(args: ComputeSimAdvanceArgs): number {
  const maxWallDeltaMs = args.maxWallDeltaMs ?? DEFAULT_MAX_WALL_DELTA_MS;
  // Clamp to [0, max]: never advance backwards; never leap after a stall.
  const clampedWall =
    args.wallDeltaMs < 0
      ? 0
      : args.wallDeltaMs > maxWallDeltaMs
        ? maxWallDeltaMs
        : args.wallDeltaMs;
  const ratePerMs = args.msPerTick / args.defaultIntervalMs;
  return clampedWall * ratePerMs * args.multiplier;
}

/** Arguments for {@link selectDrain}. */
export interface SelectDrainArgs {
  /** `occurredAt`(ms) of `ticks[i]` (first event of each tick), ascending. */
  readonly tickTimesMs: readonly number[];
  /** Index of the first undrained tick (carry position across frames). */
  readonly nextIndex: number;
  /** The current sim-clock (ms). */
  readonly simClock: number;
  /** Per-frame drain budget (>= 1). */
  readonly maxTicks: number;
}

/** The outcome of {@link selectDrain}: how many ticks drain + the (maybe clamped) clock. */
export interface SelectDrainResult {
  /** Ticks to drain this frame, in `[0, maxTicks]`. */
  readonly count: number;
  /**
   * `simClock` clamped to the last drained tick's time WHEN the budget cut off
   * still-due ticks (carry the remainder to the next frame); otherwise the input
   * `simClock` unchanged.
   */
  readonly clampSimClock: number;
}

/**
 * Which pre-baked ticks drain this frame, honoring the budget. PURE.
 *
 * Counts the run of ticks from `nextIndex` whose time is `≤ simClock`, capped at
 * `maxTicks`. When the cap truncates ticks that would otherwise be due, the
 * `simClock` is clamped to the last drained tick's time so the remainder carries
 * to the next frame (and the reported sim time stays consistent with what was
 * actually applied). When nothing is over-budget, the input `simClock` is kept.
 */
export function selectDrain(args: SelectDrainArgs): SelectDrainResult {
  const { tickTimesMs, nextIndex, simClock, maxTicks } = args;
  let count = 0;
  let i = nextIndex;
  // Count due ticks up to the budget.
  while (i < tickTimesMs.length && count < maxTicks && tickTimesMs[i]! <= simClock) {
    count += 1;
    i += 1;
  }
  // Budget-capped iff we stopped on the budget AND the next tick is still due.
  const budgetCapped =
    count === maxTicks && i < tickTimesMs.length && tickTimesMs[i]! <= simClock;
  if (budgetCapped && count > 0) {
    // Clamp to the last drained tick's time; carry the rest to the next frame.
    return { count, clampSimClock: tickTimesMs[nextIndex + count - 1]! };
  }
  return { count, clampSimClock: simClock };
}
