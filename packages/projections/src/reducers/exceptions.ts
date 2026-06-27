import type { Severity } from "@mm/domain";
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * SNS-04/05 read model: the OPEN exceptions feed + a false-positive-rate KPI.
 *
 * The detector (`detector.ts`) is the sole producer of `WrongTrailerDetected` /
 * `MissedUnloadDetected`; this reducer folds those — and ONLY those — into the
 * queryable exceptions read model. Every other event is a no-op (the same state
 * reference is returned), so the feed surfaces exclusively planned-vs-observed
 * disagreements, never absence (the anti-P6 keystone holds end-to-end: a package
 * with no read produces no detection event, hence no exception row here).
 *
 * ## Identity / idempotency
 * Each exception is keyed by a STABLE `exceptionId` derived deterministically
 * from its discriminating fields (kind + package + trailer + hub). Re-applying
 * the same detection event upserts the same row — an idempotent no-double-count
 * fold that matches the inline `last_seq` checkpoint guard (P5a) and keeps the
 * feed from flooding when detection re-runs (T-03-16).
 *
 * ## False-positive-rate KPI (the demo credibility metric)
 * The MVP FP-rate is a REAL ratio, not a placeholder: `lowConfidenceExceptions
 * / totalExceptions`, where an exception is "low-confidence" when its `severity`
 * is `info` — the LOWEST rung, which the detector's calibrated `severityFor`
 * assigns to the marginal, near-the-gate disagreements most likely to be false
 * positives. Tying the KPI to `severity` (not a raw-confidence magic number)
 * keeps ONE calibration source — the detection config — and is robust to the
 * fusion engine's bounded-confidence range (anti-P5b caps zone mass well below
 * 1.0, so an absolute confidence band would be brittle). `warning`/`critical`
 * exceptions are the credible signal; a low FP-rate proves the feed is trusted.
 *
 * ## Purity (P3)
 * Time comes only from `occurredAt`; no wall clock, no RNG. Identical event
 * sequence -> identical state (auditable, replayable, rebuildable).
 */

/**
 * The exception kinds surfaced in the feed. `wrong-trailer` / `missed-unload` are
 * the detector's planned-vs-observed disagreements; `coordination-rejected`
 * (Phase-25 COORD-03) is a coordinator suggestion the target agent honestly
 * declined against its own binding feasibility (the "won't divert: HOS/fuel" demo
 * moment) — an honest operational ALERT, never a low-confidence detection fault.
 */
export type ExceptionKind = "wrong-trailer" | "missed-unload" | "coordination-rejected";

/** The closed coordination reject reasons (mirrors `SuggestionRejected.reasonCode`). */
export type CoordinationRejectReason = "hos" | "fuel" | "dock" | "infeasible";

/**
 * Human-readable label per reject reason — the operator-facing "won't …" string the
 * COORD-03 alert surfaces. A closed, pure map (no clock, no RNG) so the rebuild-from-
 * log fold produces the same label as the live fold (FND-04).
 */
export const COORDINATION_REJECT_LABELS: Readonly<
  Record<CoordinationRejectReason, string>
> = {
  hos: "won't divert: HOS",
  fuel: "won't divert: fuel",
  dock: "won't dispatch: dock full",
  infeasible: "declined: infeasible",
};

/**
 * The severity the detector's calibrated `severityFor` assigns to the marginal,
 * just-cleared-the-gate disagreements — the ones most likely to be false
 * positives. The FP-rate KPI is the share of opened exceptions at THIS rung.
 * Using `severity` (a calibrated output) instead of a raw-confidence band keeps
 * the KPI coherent with detection and robust to the fusion engine's bounded
 * (anti-P5b) confidence range.
 */
export const FALSE_POSITIVE_SEVERITY: Severity = "info";

/** One open exception row surfaced in the feed (SNS-04/05 + COORD-03). */
export interface OpenException {
  /** Stable, deterministic identity (kind + package + trailer + hub, or suggestionId). */
  readonly exceptionId: string;
  readonly kind: ExceptionKind;
  /** Package id for a detection row; `""` for a coordination-rejected alert. */
  readonly packageId: string;
  /** The trailer the package was OBSERVED aboard; `""` for a coordination alert. */
  readonly trailerId: string;
  /** The hub the package should have unloaded at (missed-unload only). */
  readonly hubId: string | null;
  readonly severity: Severity;
  readonly recommendedAction: string;
  /** Bounded observed confidence that triggered the exception (< 1.0). */
  readonly confidence: number;
  /** Domain time the exception was detected (`occurredAt`), ISO-8601. */
  readonly occurredAt: string;
  // --- Phase-25 COORD-03 (coordination-rejected rows only; null otherwise) -----
  /** The closed reject reasonCode (`hos|fuel|dock|infeasible`), else null. */
  readonly reasonCode: CoordinationRejectReason | null;
  /** The rejected suggestion's correlation id, else null. */
  readonly suggestionId: string | null;
  /** The operator-facing "won't …" label for the reject, else null. */
  readonly label: string | null;
}

/**
 * The exceptions read model: the open-exceptions map (keyed by `exceptionId`)
 * plus the false-positive KPI counters. The map is a container only —
 * correctness never depends on its iteration order (the read side sorts).
 */
export interface ExceptionsState {
  readonly open: ReadonlyMap<string, OpenException>;
  /** Distinct exceptions ever opened (idempotent: re-applying does not bump). */
  readonly totalExceptions: number;
  /** Of those, how many were at `FALSE_POSITIVE_SEVERITY` (the KPI numerator). */
  readonly lowConfidenceExceptions: number;
}

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyExceptionsState: ExceptionsState = {
  open: new Map(),
  totalExceptions: 0,
  lowConfidenceExceptions: 0,
};

/** Deterministic, collision-resistant identity for a DETECTION exception row. */
export function exceptionId(
  kind: ExceptionKind,
  packageId: string,
  trailerId: string,
  hubId: string | null,
): string {
  return `${kind}:${packageId}:${trailerId}:${hubId ?? ""}`;
}

/**
 * Deterministic identity for a COORD-03 coordination-rejected row. Keyed by the
 * unique `suggestionId` (one reject per suggestion), so re-applying the same
 * `SuggestionRejected` is an idempotent upsert onto the same row.
 */
export function coordinationRejectId(suggestionId: string): string {
  return `coordination-rejected:${suggestionId}`;
}

/**
 * The false-positive-rate KPI: the share of opened exceptions at
 * `FALSE_POSITIVE_SEVERITY` (`info`). A genuine queryable ratio in [0, 1]; `0`
 * when nothing has been opened (no divide-by-zero).
 */
export function falsePositiveRate(state: ExceptionsState): number {
  return state.totalExceptions === 0
    ? 0
    : state.lowConfidenceExceptions / state.totalExceptions;
}

/**
 * The current OPEN exceptions, deterministically ordered by `occurredAt` then
 * `exceptionId` (the stable feed order the API surfaces).
 */
export function openExceptions(state: ExceptionsState): readonly OpenException[] {
  return [...state.open.values()].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    return a.exceptionId < b.exceptionId ? -1 : a.exceptionId > b.exceptionId ? 1 : 0;
  });
}

/** Fold one opened exception into the state (idempotent on `exceptionId`). */
function open(state: ExceptionsState, row: OpenException): ExceptionsState {
  // Already-seen exceptionId ⇒ idempotent upsert (no counter bump, no flood).
  if (state.open.has(row.exceptionId)) {
    const next = new Map(state.open);
    next.set(row.exceptionId, row);
    return { ...state, open: next };
  }
  const next = new Map(state.open);
  next.set(row.exceptionId, row);
  const low = row.severity === FALSE_POSITIVE_SEVERITY ? 1 : 0;
  return {
    open: next,
    totalExceptions: state.totalExceptions + 1,
    lowConfidenceExceptions: state.lowConfidenceExceptions + low,
  };
}

/**
 * Pure reducer (SNS-04/05). Folds an exception event into the open-exceptions
 * read model + FP KPI; every other event is a no-op (same reference). Exhaustive
 * over the closed 11-member `DomainEvent` union — adding a member without a case
 * stops compilation (`assertNeverEvent`).
 */
export function exceptionsReducer(
  state: ExceptionsState,
  { event, occurredAt }: OccurredEvent,
): ExceptionsState {
  switch (event.type) {
    case "WrongTrailerDetected": {
      const p = event.payload;
      // Include plannedTrailerId in the identity: a re-plan onto a DIFFERENT
      // trailer while still observed on the same wrong trailer is a NEW
      // (escalated) disagreement, not a duplicate — it must get a distinct id.
      const id = exceptionId(
        "wrong-trailer",
        p.packageId,
        p.observedTrailerId,
        p.plannedTrailerId,
      );
      return open(state, {
        exceptionId: id,
        kind: "wrong-trailer",
        packageId: p.packageId,
        trailerId: p.observedTrailerId,
        hubId: null,
        severity: p.severity,
        recommendedAction: p.recommendedAction,
        confidence: p.confidence,
        occurredAt,
        reasonCode: null,
        suggestionId: null,
        label: null,
      });
    }
    case "MissedUnloadDetected": {
      const p = event.payload;
      const id = exceptionId("missed-unload", p.packageId, p.trailerId, p.hubId);
      return open(state, {
        exceptionId: id,
        kind: "missed-unload",
        packageId: p.packageId,
        trailerId: p.trailerId,
        hubId: p.hubId,
        severity: p.severity,
        recommendedAction: p.recommendedAction,
        confidence: p.confidence,
        occurredAt,
        reasonCode: null,
        suggestionId: null,
        label: null,
      });
    }
    // Phase-25 COORD-03: a coordinator suggestion the target agent DECLINED against
    // its own binding feasibility surfaces here as an honest operational ALERT (the
    // "won't divert: HOS/fuel" demo moment). Severity is `warning` — a reject is
    // honest, NOT a low-confidence detection fault — so it never inflates the
    // detection false-positive-rate numerator (`lowConfidenceExceptions` counts only
    // `info`-severity detections). It DOES appear in the feed (a real alert) and in
    // `totalExceptions`. The `targetAgentId` is carried by the event's stream
    // (the agent's own stream), not the payload, so it is not reconstructable here;
    // `suggestionId` + `reasonCode` + `label` are the surfaced fields.
    case "SuggestionRejected": {
      const p = event.payload;
      return open(state, {
        exceptionId: coordinationRejectId(p.suggestionId),
        kind: "coordination-rejected",
        packageId: "",
        trailerId: "",
        hubId: null,
        severity: "warning",
        recommendedAction: COORDINATION_REJECT_LABELS[p.reasonCode],
        confidence: 0,
        occurredAt,
        reasonCode: p.reasonCode,
        suggestionId: p.suggestionId,
        label: COORDINATION_REJECT_LABELS[p.reasonCode],
      });
    }
    // Every non-detection event is a no-op: the feed surfaces ONLY positive
    // planned-vs-observed disagreements, never absence (anti-P6 end-to-end).
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) are
    // optimizer concerns, not detection evidence, so they no-op here too.
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events raise no
    // exception in this phase, so they no-op as well.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "RfidObserved":
    case "PlanGenerated":
    case "PlanAccepted":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-01: terminal delivery opens no exception
    case "TrailerDiverted": // Phase-24 OODA-01: a re-route is a planned decision, not an exception
    case "ActionSuggested": // Phase-25 COORD-02: an advisory suggestion opens no exception (the ACCEPT/REJECT verdict is the alert)
    case "SuggestionAccepted": // Phase-25 COORD-03: an accept is the happy path — no alert (only a reject surfaces here)
      return state;
    default:
      return assertNeverEvent(event);
  }
}
