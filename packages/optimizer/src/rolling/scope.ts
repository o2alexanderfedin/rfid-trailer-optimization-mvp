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
    // v2.0 IND-03 (Pitfall 3): external induction re-scopes the optimizer to BOTH
    // the induction hub (new demand origin) AND the destination hub — same shape
    // as PackageCreated. Classifying it scope-neutral would silently defeat the
    // optimizer demand path (inducted freight never prioritized).
    case "PackageInducted":
      return [event.payload.inductionHubId, event.payload.destHubId];
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
    // FLOW-04 / D-21-1: PlanSuperseded is an optimizer-internal supersession marker
    // grouped here — it names no NEW demand hub (the superseding PlanAccepted + its
    // scope already cover the affected hubs), so it is SCOPE-NEUTRAL.
    case "WrongTrailerDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "PlanSuperseded":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
    case "PackageDelivered":
    case "TrailerDiverted":
    // Phase-25 COORD-02/Pitfall-11: the three advisory coordination events are
    // SCOPE-NEUTRAL — they must NOT re-trigger the suggesting coordinator (nor
    // the rolling optimizer), exactly mirroring PlanGenerated/PlanAccepted/
    // PlanSuperseded. Returning [] means a suggestion/accept/reject never adds a
    // hub to the affected scope, so an unchanged scope re-emits nothing — the
    // anti-feedback-storm guarantee the whole phase depends on.
    case "ActionSuggested":
    case "SuggestionAccepted":
    case "SuggestionRejected":
      // SP2 stop events (TruckRested/TruckRefueled) are SCOPE-NEUTRAL — a
      // rest/refuel never re-scopes the optimizer, so an absent-fuelConfig epoch
      // stays byte-identical to the pre-SP2 result.
      // Phase-22 OUT-01: PackageDelivered is the TERMINAL exit of freight — the
      // package is LEAVING the network, so it adds NO new demand hub to the
      // affected scope. SCOPE-NEUTRAL (the destination arrival that preceded it
      // already scoped the hub if needed).
      // Phase-24 OODA-01: TrailerDiverted is a truck re-route decision; the
      // optimizer re-scoping on diverts is deferred to 24-02+ — SCOPE-NEUTRAL here.
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

// --- NET-05 (Phase 23): the per-center SCOPE PARTITION -----------------------

/** Resolve a hub's owning center; an unmapped hub is its OWN center (defensive). */
function centerForHub(hubId: string, centerOf: ReadonlyMap<string, string>): string {
  return centerOf.get(hubId) ?? hubId;
}

/**
 * NET-05 — partition a flat {@link OptimizerScope} into per-center slices so a
 * single center's rolling epoch contains ONLY that center's hubs/trailers. Each
 * slice's size is independent of the rest of the continental network (the real
 * scaling fix — one center's epoch never pulls another center's trailers).
 *
 * ADDITIVE + non-mutating: the input `scope` is never changed (legacy
 * `detectAffectedScope` stays byte-identical), and the UNION of the per-center
 * hub sets reproduces `scope.hubIds` exactly (no hub lost).
 *
 * Hubs are bucketed by `centerOf(hubId)` (an unmapped hub is its own center).
 * Trailers are bucketed via the `events` — which re-supply the trailer↔hub
 * linkage the flat scope flattens away — so a trailer lands in the center(s) of
 * the hubs IT touched (never replicated into an unrelated center). Each slice's
 * id arrays are SORTED + deduped (anti-P7) and carry the flat scope's horizon
 * knobs unchanged. PURE: a deterministic function of its inputs.
 */
export function partitionScopeByCenter(
  scope: OptimizerScope,
  centerOf: ReadonlyMap<string, string>,
  events: readonly DomainEvent[],
): ReadonlyMap<string, OptimizerScope> {
  const hubsByCenter = new Map<string, Set<string>>();
  const trailersByCenter = new Map<string, Set<string>>();
  const ensure = (m: Map<string, Set<string>>, key: string): Set<string> => {
    const existing = m.get(key);
    if (existing !== undefined) return existing;
    const fresh = new Set<string>();
    m.set(key, fresh);
    return fresh;
  };

  const inScopeHubs = new Set(scope.hubIds);
  const inScopeTrailers = new Set(scope.trailerIds);

  // 1. Bucket every IN-SCOPE hub by its owning center (the union-preserving step —
  //    independent of the events, so no scope hub is ever dropped).
  for (const hubId of scope.hubIds) {
    ensure(hubsByCenter, centerForHub(hubId, centerOf)).add(hubId);
  }

  // 2. Bucket trailers via the event linkage: for each event, the center(s) of its
  //    hubs receive its in-scope hubs + its in-scope trailers. This keeps a trailer
  //    in the center(s) of the hubs it actually touched (one center never pulls
  //    another's trailers). A trailer-only event with no hub (WrongTrailerDetected)
  //    contributes no center bucket, matching the flat scope's hub-free handling.
  for (const event of events) {
    const eventHubs = hubsOf(event).filter((h) => inScopeHubs.has(h));
    const eventTrailers = trailersOf(event).filter((t) => inScopeTrailers.has(t));
    const eventCenters = new Set(eventHubs.map((h) => centerForHub(h, centerOf)));
    for (const c of eventCenters) {
      const hubSet = ensure(hubsByCenter, c);
      for (const h of eventHubs) hubSet.add(h);
      const trailerSet = ensure(trailersByCenter, c);
      for (const t of eventTrailers) trailerSet.add(t);
    }
  }

  // 3. Assemble each center's slice (sorted, deduped; horizon carried through).
  const out = new Map<string, OptimizerScope>();
  for (const [centerHubId, hubSet] of hubsByCenter) {
    out.set(centerHubId, {
      hubIds: sortedUnique([...hubSet]),
      trailerIds: sortedUnique([...(trailersByCenter.get(centerHubId) ?? new Set<string>())]),
      horizonStartMin: scope.horizonStartMin,
      horizonEndMin: scope.horizonEndMin,
      timeStepMin: scope.timeStepMin,
    });
  }
  return out;
}
