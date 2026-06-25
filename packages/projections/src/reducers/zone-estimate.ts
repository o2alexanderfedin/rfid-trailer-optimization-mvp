import type { DomainEvent, RfidObserved } from "@mm/domain";
import {
  type FusionConfig,
  type ReaderType,
  type RfidRead,
  type ZoneEstimate,
  fuseZone,
  windowObservations,
} from "@mm/sensor-fusion";
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * SNS-02 / SNS-03 (consumed) read model: the latest fused ZONE ESTIMATE per
 * `(packageId, trailerId)`.
 *
 * This is the OBSERVED layer made queryable. It folds `RfidObserved` reads —
 * attributed tagId -> packageId via the tag registry — through the Plan-02
 * fusion engine: `windowObservations` (anti-P5b dwell collapse) then `fuseZone`
 * (capped-likelihood Bayesian posterior + Markov prior + entropy floor). The
 * persisted confidence is therefore STRICTLY < 1.0 (and <= `confidenceCeiling`)
 * regardless of how many identical same-dwell reads arrive — the anti-P5b
 * guarantee is INHERITED, not re-implemented.
 *
 * Detection (Plan 06) reads this read model; fusion stays one-way (detection is
 * separated from fusion, anti-P6).
 *
 * Purity (P3): a pure fold of `(state, event)`. Time comes only from
 * `occurredAt`; the registry resolver and the `FusionConfig` are INJECTED (a
 * closure) so the reducer reads no wall clock and no RNG. Identical events +
 * deps yield byte-identical state (FND-04).
 */

/** Resolve a `tagId` to its `packageId`, or `undefined` for an unknown tag. */
export type ResolveTag = (tagId: string) => string | undefined;

/** The injected dependencies that keep the reducer pure and deterministic. */
export interface ZoneEstimateDeps {
  /** tagId -> packageId attribution (from the tag registry, T-03-13). */
  readonly resolveTag: ResolveTag;
  /** The fusion tunables (cap 0.85, entropy floor, Markov prior, ...). */
  readonly config: FusionConfig;
  /**
   * The dwell-window bucket size in milliseconds (anti-P5b). Reads of one tag at
   * one reader within the SAME bucket collapse to ONE observation. The Phase-3
   * consult prescribes a 2-3s window; default 3000ms.
   */
  readonly dwellWindowMs?: number;
  /**
   * Per-reader reliability class. A reader absent here defaults to the noisier
   * `trailer-antenna` class (conservative for downstream confidence).
   */
  readonly readerTypes?: Readonly<Record<string, ReaderType>>;
}

/**
 * The zone-estimate read model: a map keyed by {@link zoneEstimateKey}, valued
 * by the latest fused §8.4 `ZoneEstimate` (what the read model serves and what
 * the inline applier persists). The estimate's own `posterior` is the carried-
 * forward belief — the Bayesian PRIOR for the next read of the same
 * `(packageId, trailerId)` — so the fold is incremental and needs no raw-read
 * retention (KISS; mirrors the persisted DB applier which loads only the row).
 */
export type ZoneEstimateState = ReadonlyMap<string, ZoneEstimate>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyZoneEstimateState: ZoneEstimateState = new Map();

/** The default dwell-window bucket (3s — the upper end of the 2-3s band). */
export const DEFAULT_DWELL_WINDOW_MS = 3000 as const;

/**
 * The stable composite key for the read model: `${packageId}|${trailerId}`. A
 * package can be observed in more than one trailer over its life (each is a
 * distinct estimate); the `|` separator is safe because ids never contain it.
 */
export function zoneEstimateKey(packageId: string, trailerId: string): string {
  return `${packageId}|${trailerId}`;
}

/**
 * Derive a DETERMINISTIC dwell-window id from the observation time, so a burst
 * of dependent reads in one 2-3s window shares one `dwellWindowId` and collapses
 * to a single observation (anti-P5b). Pure: floor(occurredAtMs / windowMs).
 */
function dwellWindowIdFor(occurredAt: string, windowMs: number): string {
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms) || windowMs <= 0) return occurredAt;
  return String(Math.floor(ms / windowMs));
}

/** Map one `RfidObserved` + its `occurredAt` to a fusion-engine `RfidRead`. */
function toRead(
  observed: RfidObserved,
  occurredAt: string,
  windowMs: number,
  readerTypes: Readonly<Record<string, ReaderType>>,
): RfidRead {
  const p = observed.payload;
  return {
    tagId: p.tagId,
    readerId: p.readerId,
    antennaId: p.antennaId,
    rssi: p.rssi,
    trailerId: p.trailerId,
    hubId: p.hubId,
    readerType: readerTypes[p.readerId] ?? "trailer-antenna",
    dwellWindowId: dwellWindowIdFor(occurredAt, windowMs),
    observedAt: occurredAt,
    perReadConfidence: p.confidence,
  };
}

/**
 * Build the pure zone-estimate reducer bound to its injected deps (registry +
 * config). Returns a `Reducer<ZoneEstimateState>`.
 */
export function makeZoneEstimateReducer(
  deps: ZoneEstimateDeps,
): (state: ZoneEstimateState, occurred: OccurredEvent) => ZoneEstimateState {
  const windowMs = deps.dwellWindowMs ?? DEFAULT_DWELL_WINDOW_MS;
  const readerTypes = deps.readerTypes ?? {};

  return function zoneEstimateReducer(
    state: ZoneEstimateState,
    { event, occurredAt }: OccurredEvent,
  ): ZoneEstimateState {
    return applyEvent(state, event, occurredAt, deps, windowMs, readerTypes);
  };
}

function applyEvent(
  state: ZoneEstimateState,
  event: DomainEvent,
  occurredAt: string,
  deps: ZoneEstimateDeps,
  windowMs: number,
  readerTypes: Readonly<Record<string, ReaderType>>,
): ZoneEstimateState {
  switch (event.type) {
    case "RfidObserved": {
      const packageId = deps.resolveTag(event.payload.tagId);
      // T-03-13: an unknown tag is not a package — drop it (no estimate). The
      // caller treats this as a logged no-op, never an exception.
      if (packageId === undefined) return state;

      const key = zoneEstimateKey(packageId, event.payload.trailerId);
      const prior = state.get(key);

      // Anti-P5b: window THIS read (a same-dwell burst that arrives as repeated
      // RfidObserved events still collapses, because each event re-fuses against
      // the prior posterior under the per-read cap + entropy floor — confidence
      // can never reach 1.0). The carried-forward `posterior` is the Bayesian
      // prior; the first read starts from the uniform default prior.
      const read = toRead(event, occurredAt, windowMs, readerTypes);
      const windowed = windowObservations([read], deps.config);
      const estimate = fuseZone(
        {
          packageId,
          prior: prior?.posterior ?? deps.config.defaultPrior,
          trailerId: event.payload.trailerId,
          lastReliableCheckpoint: prior?.lastReliableCheckpoint ?? null,
          // Omit (not pass `undefined`) under exactOptionalPropertyTypes.
          ...(prior === undefined ? {} : { lastObservedAt: prior.lastObservedAt }),
        },
        windowed,
        deps.config,
      );

      const next = new Map(state);
      next.set(key, estimate);
      return next;
    }
    // Every non-observation event is a no-op for the zone estimate. Identity
    // (tag registry) and trailer/hub lifecycle are projected separately —
    // detection is downstream and one-way (anti-P6). Phase-4 plan-lifecycle
    // events (PlanGenerated/PlanAccepted, OPT-04) carry no observation, so they
    // no-op here too. Phase-9 (v1.2) driver-lifecycle + load/unload phase events
    // carry no zone evidence either, so they no-op as well.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
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
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-04: zone estimates are RFID-only; the
      // Phase-21 is_active filter already excludes delivered packages from detection
      // scope, and PackageDelivered carries no RFID data — so this is a no-op here.
      return state;
    default:
      return assertNeverEvent(event);
  }
}
