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
  const simSpeed = opts.simSpeed ?? 1;
  const maxNudgeMs = opts.maxNudgeMs ?? 500;

  /** true once we have at least one anchor. */
  let anchored = false;
  /** Wall-clock ms at the last resync. */
  let anchorWallMs = 0;
  /** Sim-clock ms at the last resync. */
  let anchorSimMs = 0;
  /** The last sim time we returned — guards monotonicity. */
  let lastSimMs = 0;

  function fromFrameTime(wallMs: number): number {
    if (!anchored) return 0;
    const elapsed = wallMs - anchorWallMs;
    const computed = anchorSimMs + elapsed * simSpeed;
    // Monotonic: never return a value less than the last reading.
    const result = computed > lastSimMs ? computed : lastSimMs;
    lastSimMs = result;
    return result;
  }

  function resync(wallMs: number, serverSimMs: number): void {
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

    // Clamp the correction (both directions) to avoid lurching.
    const clamped =
      rawCorrection > maxNudgeMs
        ? maxNudgeMs
        : rawCorrection < -maxNudgeMs
          ? -maxNudgeMs
          : rawCorrection;

    // Apply nudge: re-anchor at the current wall time with the nudged sim value.
    const nudgedSimMs = localSimMs + clamped;
    anchorWallMs = wallMs;
    anchorSimMs = nudgedSimMs;

    // Monotonic guard: if the nudge pushed us backward, hold the last value.
    if (nudgedSimMs < lastSimMs) {
      anchorSimMs = lastSimMs;
    }
  }

  return { fromFrameTime, resync };
}
