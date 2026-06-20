/**
 * `@mm/sensor-fusion/detection` — the PURE planned-vs-observed detection
 * predicates (SNS-04 wrong-trailer, SNS-05 missed-unload), and the home of the
 * anti-P6 keystone.
 *
 * ## Two layers (anti-P6)
 * Detection compares two EXPLICIT layers:
 *   - PLANNED/KNOWN — `PlannedAssignment[]`, the authoritative plan/assignment
 *     (from the Phase-2 plan + scans; assembled by Plan 06, typed here so the
 *     predicate stays pure and testable).
 *   - OBSERVED — `ZoneEstimate[]`, the confidence-scored RFID estimate from the
 *     fusion engine (`fuse.ts`). This module imports those types ONE-WAY only;
 *     it NEVER writes back into the likelihood engine (detection/fusion
 *     separation, per the Phase-3 consult). The plan is the source of truth; the
 *     observation is probabilistic EVIDENCE — never coordinates, never truth.
 *
 * ## Observation-driven (the anti-P6 keystone)
 * Both predicates iterate the OBSERVED layer and consult the plan by id. A
 * package that simply has no read NEVER appears in the output — absence of
 * evidence is not evidence of absence, so no package is ever flagged
 * "missing"/"vanished". A candidate fires ONLY on a POSITIVE observation that
 * disagrees with the plan ABOVE `confidenceThreshold`.
 *
 * ## Pure
 * No wall clock, no RNG; outputs are sorted by `packageId`, so the same input
 * always yields the same output (auditable, replayable).
 */

import type { Severity } from "@mm/domain";
import type { ZoneEstimate } from "./fuse.js";

/**
 * The PLANNED/KNOWN layer entry for one package — the authoritative assignment
 * the detector disagrees against. Plan 06 derives this from the Phase-2 plan +
 * trailer-state assignment; it is typed LOCALLY so the predicate is pure.
 */
export interface PlannedAssignment {
  readonly packageId: string;
  /** The trailer the plan put the package on; `null` = not assigned to any. */
  readonly plannedTrailerId: string | null;
  /** The hub the package is destined for (its unload stop). */
  readonly destHubId: string;
}

/** How badly a disagreement threatens the SLA — folds into severity. */
export type SlaImpact = "low" | "medium" | "high";

/**
 * Detection configuration — the threshold gate + the severity/action mapping.
 * Composed alongside `FusionConfig` (separate concern: fusion produces the
 * estimate; detection decides whether a disagreement is worth an alert).
 */
export interface DetectionConfig {
  /**
   * The minimum OBSERVED confidence (STRICTLY exceeded) for a disagreement to
   * raise a candidate. Below/at the threshold ⇒ noise, suppressed (anti-flood,
   * T-03-10). Default 0.6 — conservative, per the spec Risk-1 guidance.
   */
  readonly confidenceThreshold: number;
  /**
   * The confidence (STRICTLY exceeded) above which a wrong-trailer candidate is
   * treated as high-certainty: severity escalates to `critical` and the
   * recommended action becomes `block_departure`. Default 0.8.
   */
  readonly highConfidenceThreshold: number;
  /** Map (confidence × SLA impact) → severity for the exception feed. */
  readonly severityFor: (confidence: number, slaImpact: SlaImpact) => Severity;
}

/**
 * A candidate WrongTrailerDetected (SNS-04) — the `WrongTrailerDetected` payload
 * MINUS the event envelope. Plan 06 wraps this into the domain event.
 */
export interface WrongTrailerCandidate {
  readonly packageId: string;
  readonly observedTrailerId: string;
  readonly plannedTrailerId: string;
  readonly confidence: number;
  readonly severity: Severity;
  readonly recommendedAction: string;
}

/**
 * A candidate MissedUnloadDetected (SNS-05) — the `MissedUnloadDetected` payload
 * MINUS the event envelope. Plan 06 wraps this into the domain event.
 */
export interface MissedUnloadCandidate {
  readonly packageId: string;
  readonly trailerId: string;
  readonly hubId: string;
  readonly confidence: number;
  readonly severity: Severity;
  readonly recommendedAction: string;
}

/**
 * The default severity mapping: severity rises with confidence, and a `high` SLA
 * impact bumps it up one rung. Pure lookup, no thresholds buried in code beyond
 * the documented bands.
 */
function defaultSeverityFor(confidence: number, slaImpact: SlaImpact): Severity {
  const base: Severity =
    confidence >= 0.85 ? "critical" : confidence >= 0.7 ? "warning" : "info";
  if (slaImpact === "high") return bump(base);
  if (slaImpact === "low") return base;
  return base;
}

/** Raise a severity one rung (saturating at `critical`). */
function bump(s: Severity): Severity {
  return s === "info" ? "warning" : "critical";
}

/**
 * The default detection configuration. `confidenceThreshold` 0.6 is the
 * conservative gate from the Phase-3 research (keep the feed credible, not
 * flooded); `highConfidenceThreshold` 0.8 escalates the clearly-certain cases.
 */
export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  confidenceThreshold: 0.6,
  highConfidenceThreshold: 0.8,
  severityFor: defaultSeverityFor,
};

/** Index the PLANNED layer by packageId for O(1) lookup from an observation. */
function indexPlan(
  planned: readonly PlannedAssignment[],
): ReadonlyMap<string, PlannedAssignment> {
  const map = new Map<string, PlannedAssignment>();
  for (const p of planned) map.set(p.packageId, p);
  return map;
}

/** Stable, deterministic ordering of candidates by packageId. */
function byPackageId<T extends { readonly packageId: string }>(a: T, b: T): number {
  return a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0;
}

/**
 * `detectWrongTrailer` (SNS-04) — emit ONE candidate per OBSERVED package that
 * is positively seen (confidence STRICTLY above `confidenceThreshold`) in a
 * trailer the plan did NOT assign it to.
 *
 *   - Observed in the CORRECT (planned) trailer ⇒ no candidate.
 *   - Observed below/at threshold ⇒ no candidate (noise suppressed).
 *   - Observed but no planned assignment, or `plannedTrailerId` is `null` ⇒ no
 *     candidate (cannot disagree with a plan that does not exist — log-worthy,
 *     not an exception).
 *   - ABSENCE of an observation contributes NOTHING (anti-P6): the loop is over
 *     OBSERVATIONS, so an unobserved package can never be flagged.
 *
 * Pure: deterministic, sorted by packageId, no clock/RNG.
 */
export function detectWrongTrailer(
  planned: readonly PlannedAssignment[],
  observed: readonly ZoneEstimate[],
  config: DetectionConfig,
): WrongTrailerCandidate[] {
  const plan = indexPlan(planned);
  const out: WrongTrailerCandidate[] = [];

  for (const obs of observed) {
    if (obs.confidence <= config.confidenceThreshold) continue; // below-threshold noise

    const assignment = plan.get(obs.packageId);
    // No plan / not assigned to any trailer ⇒ nothing to disagree with.
    if (assignment === undefined || assignment.plannedTrailerId === null) continue;
    // Observed in the planned (correct) trailer ⇒ agreement, no exception.
    if (assignment.plannedTrailerId === obs.trailerId) continue;

    const high = obs.confidence > config.highConfidenceThreshold;
    out.push({
      packageId: obs.packageId,
      observedTrailerId: obs.trailerId,
      plannedTrailerId: assignment.plannedTrailerId,
      confidence: obs.confidence,
      severity: config.severityFor(obs.confidence, high ? "high" : "medium"),
      recommendedAction: high ? "block_departure" : "recheck_before_departure",
    });
  }

  return out.sort(byPackageId);
}

/**
 * `detectMissedUnload` (SNS-05) — emit ONE candidate per package whose
 * destination is `departedHub` that is STILL positively observed (confidence
 * STRICTLY above `confidenceThreshold`) aboard a trailer AFTER departure.
 *
 *   - Package no longer observed (it was unloaded) ⇒ no candidate. ABSENCE does
 *     NOT imply the package is still aboard (anti-P6): the loop is over
 *     OBSERVATIONS, so an unobserved package can never be flagged.
 *   - Package not destined for `departedHub` ⇒ no candidate.
 *   - Observed below/at threshold ⇒ no candidate.
 *
 * Called only post-departure (Plan 06 gates the timing). Pure, sorted by
 * packageId.
 */
export function detectMissedUnload(
  planned: readonly PlannedAssignment[],
  observed: readonly ZoneEstimate[],
  departedHub: string,
  config: DetectionConfig,
): MissedUnloadCandidate[] {
  const plan = indexPlan(planned);
  const out: MissedUnloadCandidate[] = [];

  for (const obs of observed) {
    if (obs.confidence <= config.confidenceThreshold) continue; // below-threshold noise

    const assignment = plan.get(obs.packageId);
    // Only packages destined for the just-departed hub can be a missed unload.
    if (assignment === undefined || assignment.destHubId !== departedHub) continue;

    out.push({
      packageId: obs.packageId,
      trailerId: obs.trailerId,
      hubId: departedHub,
      confidence: obs.confidence,
      severity: config.severityFor(obs.confidence, "high"),
      recommendedAction: recommendUnloadAction(obs.confidence, config),
    });
  }

  return out.sort(byPackageId);
}

/**
 * Choose an over-carry recovery action for a missed unload. High-confidence
 * misses warrant an immediate return; lower-confidence ones a cross-dock /
 * transfer. (Plan 06 may refine with route context; this is the pure default.)
 */
function recommendUnloadAction(
  confidence: number,
  config: DetectionConfig,
): string {
  return confidence > config.highConfidenceThreshold ? "return_to_hub" : "cross_dock";
}
