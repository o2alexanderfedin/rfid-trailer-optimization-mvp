/**
 * Sim clock: monotonic wall→sim time mapping (VIZ-02 / Q2).
 *
 * The sim clock maintains an authoritative anchor: a (wallMs, simMs) pair
 * derived from the server's `simMs` field on each envelope. Between resyncs
 * the clock advances locally at `simSpeed` × wall time elapsed.
 *
 * Resync discipline (per 05-RESEARCH.md Q2):
 *  - The server's authoritative `simMs` nudges the local anchor rather than
 *    lurching: the correction is clamped to MAX_NUDGE_MS so the visual
 *    position never snaps.
 *  - The clock is monotonic: it never returns a value less than the previous
 *    reading (prevents backward animation on a stale server anchor).
 *
 * Pure: no OL imports, no browser APIs — fully unit-testable in Node.
 */

/** Options passed to `makeSimClock`. */
export interface SimClockOptions {
  /**
   * Sim-to-wall playback ratio. Default: 1 (1ms sim per 1ms wall).
   * Set to e.g. 60 for a 60× speed demo (1 sim-hour per 1 wall-second).
   */
  readonly simSpeed?: number;
  /**
   * Maximum single-resync correction (ms). Corrections larger than this are
   * clamped so the visual tween never lurches. Default: 500ms.
   */
  readonly maxNudgeMs?: number;
}

/** The sim clock interface returned by `makeSimClock`. */
export interface SimClock {
  /**
   * Convert an OL `frameState.time` (wall-clock milliseconds, monotonic) to
   * sim-time milliseconds. Returns 0 before the first `resync` call.
   */
  fromFrameTime(wallMs: number): number;

  /**
   * Resync the clock to the server's authoritative sim time.
   *
   * @param wallMs  The wall-clock time at which the server's `simMs` was
   *                observed (e.g. `Date.now()` or `frameState.time` at receive).
   * @param simMs   The authoritative sim-clock milliseconds from the envelope.
   */
  resync(wallMs: number, simMs: number): void;

  /**
   * Set the local playback rate (sim-ms per wall-ms).
   *
   * Driven from each envelope's `speed.simSpeed` so the local tween advances at
   * the SAME rate the server jumps `simMs` per tick (= MS_PER_TICK /
   * tickIntervalMs). A simSpeed of 0 (paused) freezes the tween: `fromFrameTime`
   * returns a constant value while wall time elapses.
   *
   * Negative speeds are clamped to 0 (the clock never runs backward — it is
   * monotonic by contract). Changing the speed does NOT re-anchor; the rate
   * change takes effect from the current frame forward.
   */
  setSpeed(simSpeed: number): void;
}

/**
 * Create a new sim clock.
 *
 * Usage:
 * ```ts
 * const clock = makeSimClock({ simSpeed: 60 });
 * // On each ws envelope:
 * clock.resync(Date.now(), envelope.simMs);
 * // In the postrender loop:
 * const simNow = clock.fromFrameTime(frameState.time);
 * ```
 */
export function makeSimClock(opts: SimClockOptions = {}): SimClock {
  // Mutable so `setSpeed` can retune the playback rate live from the envelope.
  // Clamp to >= 0 — the clock is monotonic and never runs backward.
  let simSpeed = Math.max(0, opts.simSpeed ?? 1);
  const maxNudgeMs = opts.maxNudgeMs ?? 500;

  /** true once we have at least one anchor. */
  let anchored = false;
  /** Wall-clock ms at the last resync. */
  let anchorWallMs = 0;
  /** Sim-clock ms at the last resync. */
  let anchorSimMs = 0;
  /** The last sim time we returned — guards monotonicity. */
  let lastSimMs = 0;
  /** The last wall time observed (frame time or resync) — used to re-anchor on setSpeed. */
  let lastWallMs = 0;

  function fromFrameTime(wallMs: number): number {
    lastWallMs = wallMs;
    if (!anchored) return 0;
    const elapsed = wallMs - anchorWallMs;
    const computed = anchorSimMs + elapsed * simSpeed;
    // Monotonic: never return a value less than the last reading.
    const result = computed > lastSimMs ? computed : lastSimMs;
    lastSimMs = result;
    return result;
  }

  function resync(wallMs: number, serverSimMs: number): void {
    lastWallMs = wallMs;
    if (!anchored) {
      // First anchor: accept unconditionally.
      anchorWallMs = wallMs;
      anchorSimMs = serverSimMs;
      anchored = true;
      lastSimMs = serverSimMs;
      return;
    }

    // Compute what we THINK sim time is right now.
    const localSimMs = anchorSimMs + (wallMs - anchorWallMs) * simSpeed;
    // Correction = server says − we think.
    const rawCorrection = serverSimMs - localSimMs;

    // A correction LARGER than the anti-lurch tolerance is genuine sim progress
    // (or a wrong / zero initial anchor) — NOT sub-second jitter — so we SNAP to
    // the server's authoritative value and track it. The realistic time model's
    // tick stream is absolute-epoch with large, irregular gaps (a tick can jump
    // many sim-minutes), and the initial snapshot anchors at simMs:0; clamping
    // such corrections to maxNudge/tick (the old behaviour) left the clock
    // crawling forever — freezing every trailer at its route origin. Within the
    // tolerance the delta is small and applied in full (no visible lurch). Either
    // branch converges to serverSimMs; the threshold documents the two regimes.
    const beyondTolerance =
      rawCorrection > maxNudgeMs || rawCorrection < -maxNudgeMs;
    const nudgedSimMs = beyondTolerance ? serverSimMs : localSimMs + rawCorrection;

    // Re-anchor at the current wall time. Monotonic guard: never anchor below the
    // last reading (no backward animation on a stale server anchor).
    anchorWallMs = wallMs;
    anchorSimMs = nudgedSimMs < lastSimMs ? lastSimMs : nudgedSimMs;
  }

  function setSpeed(nextSpeed: number): void {
    // Re-anchor at the CURRENT projected sim value BEFORE changing the rate,
    // so the new rate applies going forward without a discontinuity. We can
    // only do this once anchored; before the first resync the speed is just
    // stored for when the anchor arrives.
    if (anchored) {
      const projected = anchorSimMs + (lastWallMs - anchorWallMs) * simSpeed;
      anchorSimMs = projected > lastSimMs ? projected : lastSimMs;
      anchorWallMs = lastWallMs;
    }
    simSpeed = Math.max(0, nextSpeed);
  }

  return { fromFrameTime, resync, setSpeed };
}
