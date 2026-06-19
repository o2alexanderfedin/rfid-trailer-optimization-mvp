import type { DomainEvent } from "@mm/domain";

/**
 * FND-08 read model (catch-up / async): a package's full ordered audit timeline.
 *
 * "What happened to package X, in order?" is answered by the ordered sequence of
 * every event that names the package, in strict `global_seq` order — the same
 * total order the event store assigns. Each entry carries the event's identity
 * (`globalSeq`), its `eventType`, the domain `occurredAt`, the hub it concerns
 * (where applicable), and any scan detail.
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
 * per-package mutable state to fold; the reducer maps ONE stored event to AT
 * MOST ONE timeline row (`null` for events that name no package).
 */

/** The minimal stored-event shape the catch-up reducers read. */
export interface StoredEventLike {
  /** Total-order position in the log; the timeline row's identity + sort key. */
  readonly globalSeq: bigint;
  readonly event: DomainEvent;
  /** Domain time of the event (ISO-8601), recorded by the store. */
  readonly occurredAt: string;
}

/** One ordered entry in a package's audit timeline (FND-08). */
export interface AuditTimelineEntry {
  /** Owning package — the timeline is queried by this id. */
  readonly packageId: string;
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
}

/**
 * Pure reducer for FND-08. Maps one stored event to its audit-timeline entry, or
 * `null` if the event does not name a package. Deterministic: derives every
 * field from the stored event (`globalSeq`, `occurredAt`, payload) — never the
 * wall clock.
 */
export function auditTimelineReducer(
  stored: StoredEventLike,
): AuditTimelineEntry | null {
  const { event, globalSeq, occurredAt } = stored;
  switch (event.type) {
    case "PackageCreated":
      return {
        packageId: event.payload.packageId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.originHubId,
        scanType: null,
      };
    case "PackageScanned":
      return {
        packageId: event.payload.packageId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: event.payload.scanType,
      };
    case "PackageArrivedAtHub":
      return {
        packageId: event.payload.packageId,
        globalSeq,
        eventType: event.type,
        occurredAt,
        hubId: event.payload.hubId,
        scanType: null,
      };
    case "HubRegistered":
    case "RouteRegistered":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
      return null;
    default:
      return assertNeverAudit(event);
  }
}

function assertNeverAudit(event: never): never {
  throw new Error(
    `Unhandled DomainEvent in auditTimelineReducer: ${JSON.stringify(event)}`,
  );
}
