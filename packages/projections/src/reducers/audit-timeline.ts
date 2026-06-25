import type { DomainEvent } from "@mm/domain";

/**
 * FND-08 read model (catch-up / async): a package's OR a trailer's full ordered
 * audit timeline.
 *
 * "What happened to package X, in order?" OR "What decisions were made for
 * trailer T, in order?" — answered by the ordered sequence of every event that
 * names the entity, in strict `global_seq` order — the same total order the
 * event store assigns. Each entry carries the event's identity (`globalSeq`),
 * its `eventType`, the domain `occurredAt`, the hub it concerns (where
 * applicable), any scan detail, and the captured system recommendation (for
 * plan-lifecycle events).
 *
 * UI-02 (Plan 05-04): the timeline is extended to index TRAILER streams too.
 * `PlanGenerated`/`PlanAccepted` events produce trailer-keyed entries with the
 * captured recommendation text (the optimizer's rationale at that decision).
 * This persists the recommendation in the audit projection, satisfying the
 * anti-repudiation requirement (T-05-09): each decision is attributable and
 * replayable without re-running the optimizer.
 *
 * This is a CATCH-UP projection (ARCHITECTURE Pattern 2): unlike the operational
 * twin it does not need read-your-writes latency, so it is folded by a poller
 * advancing from a `projection_checkpoints` row. The reducer here is still a
 * PURE function of the stored event — it derives nothing from a wall clock or
 * RNG, so the rebuild-from-`global_seq=0` fold is byte-identical to the live one
 * (P3 / FND-04 discipline carried forward from Plan 04).
 *
 * Idempotency (P5a): each timeline row's identity is the event's `globalSeq`
 * (one log position -> exactly one row). Re-applying the same stored event is a
 * keyed upsert onto the SAME row — a strict no-op. There is therefore no
 * per-entity mutable state to fold; the reducer maps ONE stored event to AT
 * MOST ONE timeline row (`null` for events that name no package or trailer).
 */

/** The minimal stored-event shape the catch-up reducers read. */
export interface StoredEventLike {
  /** Total-order position in the log; the timeline row's identity + sort key. */
  readonly globalSeq: bigint;
  readonly event: DomainEvent;
  /** Domain time of the event (ISO-8601), recorded by the store. */
  readonly occurredAt: string;
}

/**
 * One ordered entry in a package's OR a trailer's audit timeline (FND-08 /
 * UI-02). Exactly one of `packageId` / `trailerId` is non-null per row —
 * package events set `packageId`, trailer / plan-lifecycle events set
 * `trailerId`. The `recommendation` field carries the captured system
 * recommendation for plan-lifecycle events (anti-repudiation, T-05-09).
 */
export interface AuditTimelineEntry {
  /** Owning package (for package-keyed events), or `null` for trailer events. */
  readonly packageId: string | null;
  /**
   * Owning trailer (for trailer-keyed events — TrailerDeparted/ArrivedAtHub/
   * Docked, PlanGenerated/PlanAccepted), or `null` for package events.
   */
  readonly trailerId: string | null;
  /** The event's total-order position (the strict timeline order, no gaps). */
  readonly globalSeq: bigint;
  /** The domain event type that produced this entry. */
  readonly eventType: DomainEvent["type"];
  /** Domain time of the event (ISO-8601). */
  readonly occurredAt: string;
  /** The hub the event concerns, when applicable (else `null`). */
  readonly hubId: string | null;
  /** The scan type for a `PackageScanned` event, when applicable (else `null`). */
  readonly scanType: string | null;
  /**
   * The captured system recommendation at the time of this decision event
   * (`PlanGenerated` / `PlanAccepted`). `null` for all other event types.
   *
   * Anti-repudiation (T-05-09): persisting the recommendation in the audit
   * projection makes each optimizer decision attributable + replayable without
   * re-running the optimizer.
   */
  readonly recommendation: string | null;
}

/**
 * Pure reducer for FND-08 (extended). Maps one stored event to its audit-
 * timeline entry, or `null` if the event does not name a package or trailer.
 * Deterministic: derives every field from the stored event (`globalSeq`,
 * `occurredAt`, payload) — never the wall clock.
 *
 * Extension (Plan 05-04 / UI-02):
 *  - Trailer-naming events (TrailerDeparted/ArrivedAtHub/Docked) produce
 *    trailer-keyed entries.
 *  - Plan-lifecycle events (PlanGenerated/PlanAccepted) produce trailer-keyed
 *    entries with the captured recommendation/rationale text.
 */
export function auditTimelineReducer(
  stored: StoredEventLike,
): AuditTimelineEntry | null {
  const { event, globalSeq, occurredAt } = stored;
  switch (event.type) {
    // -------------------------------------------------------------------------
    // Package-keyed events (FND-08 original)
    // -------------------------------------------------------------------------
    case "PackageCreated":
      return {
        packageId: event.payload.packageId,
        trailerId: null,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.originHubId,
        scanType: null,
        recommendation: null,
      };
    case "PackageScanned":
      return {
        packageId: event.payload.packageId,
        trailerId: null,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: event.payload.scanType,
        recommendation: null,
      };
    case "PackageArrivedAtHub":
      return {
        packageId: event.payload.packageId,
        trailerId: null,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: null,
        recommendation: null,
      };

    // -------------------------------------------------------------------------
    // Trailer-keyed events (UI-02 extension — Plan 05-04)
    // -------------------------------------------------------------------------
    case "TrailerDeparted":
      return {
        packageId: null,
        trailerId: event.payload.trailerId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.fromHubId,
        scanType: null,
        recommendation: null,
      };
    case "TrailerArrivedAtHub":
      return {
        packageId: null,
        trailerId: event.payload.trailerId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: null,
        recommendation: null,
      };
    case "TrailerDocked":
      return {
        packageId: null,
        trailerId: event.payload.trailerId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: null,
        recommendation: null,
      };

    // -------------------------------------------------------------------------
    // Plan-lifecycle events — trailer-keyed with captured recommendation
    // (UI-02 extension — Plan 05-04, anti-repudiation T-05-09)
    // -------------------------------------------------------------------------
    case "PlanGenerated":
      return {
        packageId: null,
        trailerId: event.payload.trailerId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: null,
        scanType: null,
        recommendation: renderPlanGeneratedRecommendation(event.payload),
      };
    case "PlanAccepted":
      return {
        packageId: null,
        trailerId: event.payload.trailerId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: null,
        scanType: null,
        recommendation: renderPlanAcceptedRecommendation(event.payload),
      };

    // -------------------------------------------------------------------------
    // Non-entity events — no timeline row (no package or trailer named).
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events add no
    // audit-timeline row in this phase (no behavior added); later phases may
    // surface driver duty transitions here.
    // -------------------------------------------------------------------------
    case "HubRegistered":
    case "RouteRegistered":
    case "RfidObserved":
    case "WrongTrailerDetected":
    case "MissedUnloadDetected":
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
      return null;
    default:
      return assertNeverAudit(event);
  }
}

/**
 * Render the captured recommendation for a `PlanGenerated` event.
 * Pure — derived entirely from the event payload (no clock, no RNG).
 * The text is stable and deterministic so the rebuild-from-log produces
 * the same string as the live fold (FND-04).
 */
function renderPlanGeneratedRecommendation(
  payload: {
    readonly planId: string;
    readonly trailerId: string;
    readonly objectiveCost: number;
    readonly feasible: boolean;
    readonly epochId: string;
    readonly scopeHash: string;
  },
): string {
  const feasibilityLabel = payload.feasible ? "FEASIBLE" : "INFEASIBLE";
  return (
    `Plan ${payload.planId} generated for trailer ${payload.trailerId}: ` +
    `${feasibilityLabel}, objective cost ${payload.objectiveCost} ` +
    `(epoch ${payload.epochId}, scope ${payload.scopeHash.slice(0, 8)}).`
  );
}

/**
 * Render the captured recommendation for a `PlanAccepted` event.
 * Pure — derived entirely from the event payload (no clock, no RNG).
 */
function renderPlanAcceptedRecommendation(
  payload: {
    readonly planId: string;
    readonly trailerId: string;
    readonly epochId: string;
    readonly scopeHash: string;
  },
): string {
  return (
    `Plan ${payload.planId} accepted for trailer ${payload.trailerId} ` +
    `(epoch ${payload.epochId}, scope ${payload.scopeHash.slice(0, 8)}).`
  );
}

function assertNeverAudit(event: never): never {
  throw new Error(
    `Unhandled DomainEvent in auditTimelineReducer: ${JSON.stringify(event)}`,
  );
}
