import type { FusionConfig, ReaderType } from "./config.js";

/**
 * `rssiToLikelihood` (SNS-01) — the per-read RSSI→likelihood mapping.
 *
 * Maps a single read's signal strength to `P(RSSI | the reader's zone)` — the
 * likelihood the Bayesian update multiplies in. Three disciplines, all from the
 * Phase-3 research:
 *
 *  - **Monotonic.** A clamped linear ramp from `minLikelihood` at
 *    `rssiFloorDbm` up to the reader-type-weighted cap at `rssiCeilingDbm`.
 *    Stronger RSSI ⇒ a likelihood at least as large (never inverted).
 *  - **Reader-type weighted.** A high-reliability `dock-portal` reaches a higher
 *    ceiling than a zone-ish `trailer-antenna` for the SAME RSSI; the weight in
 *    (0, 1] scales the headroom above the floor.
 *  - **Capped (anti-P5b).** The output is clamped into
 *    `[minLikelihood, maxLikelihood]` (default `[0.05, 0.85]`). A single strong
 *    RSSI — even +1000 dBm — can never yield 1.0, so one outlier cannot hijack
 *    the posterior.
 *
 * Pure: depends only on its arguments; no clock, no RNG.
 *
 * @param rssi        the read's signal strength in dBm (more negative = weaker).
 * @param readerType  the reader/antenna type, selecting its reliability weight.
 * @param config      the {@link FusionConfig} supplying the cap, floor, and weights.
 * @returns a likelihood strictly within `(0, 1)`, `<= config.maxLikelihood`.
 */
export function rssiToLikelihood(
  rssi: number,
  readerType: ReaderType,
  config: FusionConfig,
): number {
  const {
    minLikelihood,
    maxLikelihood,
    rssiFloorDbm,
    rssiCeilingDbm,
    readerTypeWeights,
  } = config;

  // Normalize RSSI into [0, 1] across the configured dBm operating band.
  const span = rssiCeilingDbm - rssiFloorDbm;
  const rawFraction = span <= 0 ? 1 : (rssi - rssiFloorDbm) / span;
  const fraction = clamp(rawFraction, 0, 1);

  // Reader-type reliability scales how much of the [floor, cap] headroom this
  // reader can claim. A trailer-antenna (weight < 1) tops out below the cap.
  const weight = clamp(readerTypeWeights[readerType], 0, 1);
  const effectiveCap = minLikelihood + (maxLikelihood - minLikelihood) * weight;

  const likelihood = minLikelihood + (effectiveCap - minLikelihood) * fraction;

  // Final hard clamp — the cap is an invariant, never an approximation.
  return clamp(likelihood, minLikelihood, maxLikelihood);
}

/** Clamp `value` into the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
