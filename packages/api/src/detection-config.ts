import type { Severity } from "@mm/domain";
import type { DetectionConfig, SlaImpact } from "@mm/projections";
import type { RfidSimConfig } from "@mm/simulation";

/**
 * The ONE production detection calibration band (resolves the Plan-06 carried
 * risk: "standardize ONE production detection+fusion calibration band").
 *
 * The anti-P5b fusion engine (likelihood cap 0.85 + 2% entropy floor + Markov
 * prior) SATURATES the argmax zone mass near ~0.40 — it can never approach 1.0.
 * So the Plan-04 DEFAULT `confidenceThreshold` of 0.6 is UNREACHABLE by this
 * engine: a real disagreement would never clear the gate. Detection must be
 * calibrated to the OBSERVED-confidence distribution. We sit the threshold just
 * above the ~0.33 uniform floor: a confident, corroborated estimate clears it;
 * near-uniform single-read noise does not.
 *
 * ## Why the DEFAULT `severityFor` cannot be reused (calibration coherence)
 * `defaultSeverityFor` keys its base rung off RAW confidence bands (info < 0.7,
 * warning < 0.85, else critical) — bands the saturated engine NEVER reaches. So
 * every real exception would land at `info`, and the false-positive-rate KPI
 * (the share at `info`) would read 1.0 by construction — meaningless. The KPI
 * must measure the share of MARGINAL, just-cleared-the-gate disagreements, so
 * severity has to be keyed off the SAME calibrated gate the detector already
 * uses to decide SLA impact.
 *
 * Empirically (the seeded noisy int run), this engine produces a TIGHT band:
 * single-read disagreements land at the floor (~0.365) while reads CORROBORATED
 * across the dwell window lift to ~0.381..0.395. So the calibrated split sits
 * just above the single-read floor:
 *
 *   - `slaImpact = "high"`  ⇔ confidence > highConfidenceThreshold (0.366): a
 *     CORROBORATED disagreement ⇒ `warning` (the credible signal). Only the very
 *     top of the band escalates to `critical`.
 *   - `slaImpact = "medium"` ⇔ a single-read, floor-confidence disagreement ⇒
 *     `info` (the false-positive rung the KPI counts — the marginal blips most
 *     likely to be noise).
 *
 * This keeps ONE calibration source (the two thresholds) and makes the FP-rate a
 * meaningful, queryable ratio that DISCRIMINATES credible from marginal (it is
 * never 1.0 on a credible run). The pure predicates are unchanged.
 *
 * Centralized here (DRY) so the sim driver, the demo entrypoint, and any future
 * detector caller share ONE calibration source.
 */
const HIGH_CONFIDENCE_THRESHOLD = 0.366;
/** The top of the saturated engine's range — above this a disagreement is acute. */
const CRITICAL_CONFIDENCE = 0.45;

/**
 * Calibrated severity for the saturated fusion range. Keyed off the detector's
 * own SLA impact (derived from `highConfidenceThreshold`) so `info` means
 * "marginal / near-the-gate" (the FP rung) and `warning`/`critical` mean a
 * credible, confident disagreement. Pure: no clock, no RNG.
 */
function calibratedSeverityFor(confidence: number, slaImpact: SlaImpact): Severity {
  if (slaImpact === "high") {
    return confidence >= CRITICAL_CONFIDENCE ? "critical" : "warning";
  }
  // medium / low SLA impact ⇒ a marginal, just-cleared-the-gate disagreement.
  return "info";
}

export const PRODUCTION_DETECTION_CONFIG: DetectionConfig = {
  confidenceThreshold: 0.34,
  highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
  severityFor: calibratedSeverityFor,
};

/**
 * The RFID emission profile the LIVE demo entrypoint (`main.ts`) drives. Without
 * it the runnable app passes NO `rfid` option, the entire Phase-3 pipeline is
 * gated off (`driver.ts`: detection runs iff `rfid !== undefined`), and the
 * demo produces zero zone estimates and zero exceptions — the feature goes dark.
 *
 * ## Calibration (seed 4242, 120 ticks, {@link PRODUCTION_DETECTION_CONFIG})
 * `wrongZoneRate` is the corruption knob (per-read P(read tagged to the wrong
 * zone/trailer token)). The sim default 0.03 is too low for a reliable demo. An
 * empirical sweep over the EXACT live path (seed 4242 / 120 ticks / production
 * detection) produced the wrong-trailer exception counts:
 *
 *   wrongZoneRate  0.08 → 5    0.10 → 9    0.12 → 8    0.15 → 15    0.20 → 17
 *
 * 0.10 lands at 9 — squarely in the demo-credible 3–12 band, clearly visible yet
 * realistic (10% wrong-zone reads, NOT cranked to the 0.5 of the forced unit
 * tests). `missRate` 0.05 keeps reads dense enough to corroborate across the
 * dwell window; `antennaBurst` 6 exercises the fusion windowing. The other knobs
 * inherit the sim defaults (RSSI bases/noise, 0.85 confidence cap).
 *
 * NOTE: `missed-unload` is now WIRED on the live path (F-07 / SNS-05). The
 * simulator's opt-in {@link DEMO_OVER_CARRY_CONFIG} models a held-back package
 * that rides on past its spoke and emits a spoke-origin
 * `TrailerDeparted(fromHubId=spoke)` return leg; a corroborating portal read
 * positively observes it aboard, and the UNCHANGED detector fires through the
 * driver's `departedHubs` / `destHubIndex` plumbing. The wrong-trailer feed
 * remains the dense Phase-3 centerpiece; the missed-unload feed is now non-empty.
 */
export const DEMO_RFID_CONFIG: Partial<RfidSimConfig> = {
  wrongZoneRate: 0.1,
  missRate: 0.05,
  antennaBurst: 6,
};

/** The demo over-carry config the live entrypoint drives (F-07 / SNS-05). */
export interface OverCarryConfig {
  /**
   * Per-spoke-arrival probability of holding back ONE carried package (the
   * over-carry). Drawn against a SEPARATE seeded substream so it never perturbs
   * the operational / RFID streams (golden stays byte-identical when off).
   */
  readonly rate: number;
}

/**
 * F-07 / SNS-05: the LIVE over-carry profile (`main.ts` drives it alongside
 * {@link DEMO_RFID_CONFIG}). Without it the demo's missed-unload feed is empty —
 * every package unloads at its spoke, so the SNS-05 gate (`destHubId ==
 * departedHub`, still observed aboard) is never satisfiable.
 *
 * ## Calibration (seed 4242, 120 ticks, {@link PRODUCTION_DETECTION_CONFIG})
 * `rate` is the per-spoke-arrival P(hold back one package). An empirical sweep
 * over the EXACT live path (seed 4242 / 120 ticks / demo RFID / production
 * detection), reading the persisted exceptions feed, produced these LIVE
 * missed-unload exception counts:
 *
 *   rate  0.05 → 0    0.10 → 0    0.15 → 4    0.20 → 4
 *
 * Below ~0.15 the seeded over-carry draws at this seed never coincide with a
 * spoke arrival that still carries a package, so the feed stays empty. 0.15
 * lands at 4 — squarely in the demo-credible 1-5 band: clearly visible yet
 * realistic (a 15% over-carry probability per spoke arrival, not cranked). Each
 * fired missed-unload clears the calibrated ~0.34 fusion-confidence gate because
 * the over-carried package gets a corroborating STRONG-RSSI portal read on the
 * spoke-origin return leg (a single antenna read alone sits near the ~0.33
 * uniform floor and would NOT clear it). The over-carried package is unloaded at
 * the CENTER on return, so it does not skew spoke utilization/SLA, and the dense
 * wrong-trailer feed retains its ample margin (~9).
 */
export const DEMO_OVER_CARRY_CONFIG: OverCarryConfig = {
  rate: 0.15,
};
