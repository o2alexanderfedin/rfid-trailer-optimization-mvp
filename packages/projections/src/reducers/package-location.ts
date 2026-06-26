import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * FND-05 read model: a package's last-known location.
 *
 * "Where was package X last seen?" is answered by folding the package's
 * location-bearing events (`PackageScanned`, `PackageArrivedAtHub`) into a
 * single current row per package:
 *
 *   { packageId, hubId, confidence, lastSeenAt }
 *
 * `confidence` is part of the contract NOW (FND-05) even though Phase-1 only
 * has direct, deterministic scans: a direct scan is high-confidence by
 * definition. Probabilistic RFID confidence arrives in Phase 3 — the field
 * exists so that change is additive, not a schema break.
 *
 * Purity (PITFALLS P3): the reducer is a pure function of (state, event). The
 * only time value is `event.occurredAt` (the domain clock recorded by the
 * store); there is NO wall-clock read, no RNG, no ambient ordering.
 * Identical input always yields identical output, which is what makes the
 * golden-replay equivalence (FND-04) hold byte-for-byte.
 */

/**
 * Fixed confidence for a Phase-1 direct scan. A barcode/manual scan places the
 * package with certainty; RFID's sub-1.0 probabilistic confidence is Phase 3.
 */
export const DIRECT_SCAN_CONFIDENCE = 1 as const;

/** One package's last-known-location row (FND-05). */
export interface PackageLocation {
  readonly packageId: string;
  readonly hubId: string;
  /** Placement confidence in [0, 1]; 1.0 for a Phase-1 direct scan. */
  readonly confidence: number;
  /** Domain time of the sighting (`event.occurredAt`), ISO-8601 string. */
  readonly lastSeenAt: string;
}

/**
 * The package-location read model: a map keyed by `packageId`. A `Map` is used
 * only as a container; correctness never depends on its iteration order (the
 * serializer/DB sort by `packageId`), so this stays P3-safe.
 */
export type PackageLocationState = ReadonlyMap<string, PackageLocation>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyPackageLocationState: PackageLocationState = new Map();

/**
 * Pure reducer for FND-05. Folds one event into the package-location state and
 * returns the next state. Events that do not move a package are no-ops (the
 * same state reference is returned).
 *
 * Idempotency at the fold level is guaranteed upstream by the per-projection
 * `last_seq` checkpoint (P5a); this function is additionally idempotent for a
 * *terminal* sighting because re-applying the same (packageId, hubId,
 * occurredAt) writes the identical row.
 */
export function packageLocationReducer(
  state: PackageLocationState,
  { event, occurredAt }: OccurredEvent,
): PackageLocationState {
  switch (event.type) {
    case "PackageScanned":
    case "PackageArrivedAtHub": {
      const next = new Map(state);
      next.set(event.payload.packageId, {
        packageId: event.payload.packageId,
        hubId: event.payload.hubId,
        confidence: DIRECT_SCAN_CONFIDENCE,
        lastSeenAt: occurredAt,
      });
      return next;
    }
    case "PackageInducted": {
      // v2.0 IND-01: external induction places the package at its induction hub —
      // the first network-visible sighting (mirrors the PackageArrivedAtHub path,
      // but keyed off `inductionHubId`). A direct intake scan is high-confidence.
      const next = new Map(state);
      next.set(event.payload.packageId, {
        packageId: event.payload.packageId,
        hubId: event.payload.inductionHubId,
        confidence: DIRECT_SCAN_CONFIDENCE,
        lastSeenAt: occurredAt,
      });
      return next;
    }
    case "PackageDelivered": {
      // OUT-04 / D-22-1: hard DELETE — remove the row. `Map.delete()` returns
      // false on a missing key (never throws), so this is naturally idempotent
      // and crash-safe on re-apply/replay (no read-modify-write assuming the row).
      const next = new Map(state);
      next.delete(event.payload.packageId);
      return next;
    }
    // Phase-3 RFID/detection events do not change scan-derived package location
    // — the fused zone estimate is a separate read model (later Phase-3 plans).
    // Anti-P6: absence of an RFID read never changes a package's known location.
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) don't
    // move packages, so they no-op here. Phase-9 (v1.2) driver-lifecycle +
    // load/unload phase events likewise carry no package location (driver-status
    // is a separate read model added in a later phase), so they no-op too.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
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
    case "TruckRested":
    case "TruckRefueled":
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "TrailerDiverted": // Phase-24 OODA-01: a re-route does not relocate packages (no-op until 24-02 wires it)
    // Phase-25 COORD-02: advisory suggestion events do not relocate packages.
    case "ActionSuggested":
    case "SuggestionAccepted":
    case "SuggestionRejected":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
