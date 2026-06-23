import type { DomainEvent } from "@mm/domain";

import type { OptimizerScope } from "../graph/types.js";
import type { Epoch } from "./types.js";

/**
 * `@mm/optimizer` — `detectAffectedScope`: the OPT-05 scoped-epoch detector.
 *
 * A rolling epoch optimizes only the slice of the network the NEW events touch —
 * never the whole graph (anti-P9 explosion + the §11.1 rolling-horizon
 * discipline). This walks the event batch, collects every referenced hub +
 * trailer id, and bounds the horizon from the epoch clock (`nowMin`, from
 * sim/event time — NEVER `Date.now()`).
 *
 * Determinism (anti-P3 / anti-P7): the returned id arrays are SORTED + deduped,
 * so the same batch yields a byte-identical scope (which feeds `scopeHash`). The
 * horizon is `[nowMin, nowMin + DEFAULT_HORIZON_MIN)` stepped by
 * `DEFAULT_TIME_STEP_MIN` (coarse 15-min nodes, anti-P9).
 */

/** Default rolling horizon length, minutes (a few trailer round-trips). */
const DEFAULT_HORIZON_MIN = 240;
/** Coarse node granularity, minutes (anti-P9 graph-explosion guard). */
const DEFAULT_TIME_STEP_MIN = 15;

/** Pull the hub ids an event references (empty for hub-free events). */
function hubsOf(event: DomainEvent): readonly string[] {
  switch (event.type) {
    case "HubRegistered":
      return [event.payload.hubId];
    case "RouteRegistered":
      return [event.payload.fromHubId, event.payload.toHubId];
    case "PackageCreated":
      return [event.payload.originHubId, event.payload.destHubId];
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
      return [event.payload.hubId];
    case "TrailerDeparted":
      return [event.payload.fromHubId, event.payload.toHubId];
    // Phase-3 RFID/detection evidence that names a hub feeds the affected scope
    // so the rolling optimizer reacts to where the exception was observed.
    case "RfidObserved":
    case "MissedUnloadDetected":
      return [event.payload.hubId];
    // WrongTrailerDetected names no hub (trailer-vs-trailer disagreement); it
    // contributes via `trailersOf` only.
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events contribute no
    // hub to the affected scope in this phase (no optimizer HOS behavior yet —
    // sim emission + optimizer awareness land in later phases). Classifying them
    // as scope-neutral keeps the closed-union exhaustive + the rolling epoch
    // unchanged until those phases wire them in.
    case "WrongTrailerDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
      return [];
    default: {
      // Exhaustiveness guard — a new event type must be classified here.
      const _never: never = event;
      return _never;
    }
  }
}

/** Pull the trailer id an event references (empty for trailer-free events). */
function trailersOf(event: DomainEvent): readonly string[] {
  switch (event.type) {
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
      return [event.payload.trailerId];
    // Phase-3 RFID/detection evidence that names trailers feeds the affected
    // scope so the rolling optimizer reacts to the implicated trailer(s).
    case "RfidObserved":
    case "MissedUnloadDetected":
      return [event.payload.trailerId];
    case "WrongTrailerDetected":
      return [event.payload.observedTrailerId, event.payload.plannedTrailerId];
    default:
      return [];
  }
}

/** Sorted, deduped array — the deterministic id-set helper (anti-P7). */
function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Collect the hubs/trailers referenced by `events` into a scoped horizon. An
 * empty batch yields an empty scope (nothing affected ⇒ nothing to optimize).
 */
export function detectAffectedScope(
  events: readonly DomainEvent[],
  epoch: Epoch,
): OptimizerScope {
  const hubIds: string[] = [];
  const trailerIds: string[] = [];
  for (const event of events) {
    hubIds.push(...hubsOf(event));
    trailerIds.push(...trailersOf(event));
  }
  return {
    hubIds: sortedUnique(hubIds),
    trailerIds: sortedUnique(trailerIds),
    horizonStartMin: epoch.nowMin,
    horizonEndMin: epoch.nowMin + DEFAULT_HORIZON_MIN,
    timeStepMin: DEFAULT_TIME_STEP_MIN,
  };
}
