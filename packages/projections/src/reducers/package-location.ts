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
    // No package-location change. Plan-lifecycle events (PlanGenerated/
    // PlanAccepted, OPT-04) don't move packages, so they no-op here.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "PlanGenerated":
    case "PlanAccepted":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
