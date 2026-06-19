import type { Severity } from "@mm/domain";
import type { DetectionConfig, SlaImpact } from "@mm/projections";

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
