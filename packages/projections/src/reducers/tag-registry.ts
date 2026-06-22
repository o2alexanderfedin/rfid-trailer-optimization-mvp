import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * SNS-02 read model: the tag -> package REGISTRY.
 *
 * "Which package does this RFID tag belong to?" is answered by folding every
 * `PackageCreated.rfidTagId` into a single `tagId -> packageId` map. An
 * `RfidObserved` carries only a raw `tagId`; this registry is what turns that
 * tag into the `packageId` the evidence is ABOUT, so RFID reads can be
 * attributed (the OBSERVED layer's identity resolution).
 *
 * Anti-spoofing (T-03-13): an UNMAPPED tag resolves to `undefined` — it is NOT
 * a package and is never an exception. The caller logs the unknown tag and
 * drops it (it produces no zone estimate).
 *
 * Purity (P3): a pure fold of `(state, event)`. No wall clock, no RNG, no
 * Map-iteration-order dependence — `occurredAt` is unused here (the mapping is
 * time-independent), which is exactly what makes the live fold and the
 * rebuild-from-`global_seq=0` fold produce byte-identical state (FND-04).
 */

/**
 * The registry read model: a map keyed by `tagId`, valued by `packageId`.
 * Iteration order is never relied upon for correctness (the persisted form is
 * keyed by the `tag_id` primary key).
 */
export type TagRegistryState = ReadonlyMap<string, string>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyTagRegistryState: TagRegistryState = new Map();

/**
 * Resolve a `tagId` to its `packageId`, or `undefined` when the tag is unknown.
 * The total, exception-free resolver the fusion/attribution path depends on
 * (T-03-13: an unknown tag is not a package, not an error).
 */
export function resolveTag(
  state: TagRegistryState,
  tagId: string,
): string | undefined {
  return state.get(tagId);
}

/**
 * Pure reducer for SNS-02. Folds one event into the tag -> package registry.
 *
 * Only `PackageCreated` WITH an `rfidTagId` adds a mapping (last write wins, so
 * a re-bind is deterministic). All other 10 events — including `RfidObserved`,
 * which CONSUMES the registry but never mutates it — are no-ops and return the
 * SAME state reference (cheap idempotent re-apply).
 *
 * Exhaustive over the closed 11-member `DomainEvent` union: a new event member
 * without a `case` stops compiling (`assertNeverEvent`).
 */
export function tagRegistryReducer(
  state: TagRegistryState,
  { event }: OccurredEvent,
): TagRegistryState {
  switch (event.type) {
    case "PackageCreated": {
      const tagId = event.payload.rfidTagId;
      if (tagId === undefined) return state; // no tag bound -> no mapping
      const next = new Map(state);
      next.set(tagId, event.payload.packageId);
      return next;
    }
    // Every non-registration event leaves the mapping untouched. RfidObserved
    // is a READER of this registry, not a writer — keeping the registry the sole
    // authority for tag identity (anti-P6: observation never mutates identity).
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) carry
    // no tag identity, so they no-op here too. Phase-9 (v1.2) driver-lifecycle +
    // load/unload phase events bind no RFID tag either, so they no-op as well.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "RfidObserved":
    case "WrongTrailerDetected":
    case "MissedUnloadDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
