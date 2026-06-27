import type { EpochResult, TwinRoute, TwinSnapshot, TwinStop, TwinTrailer } from "@mm/optimizer";

import type { CoordinatorSuggestion } from "./coordinator.js";

/**
 * Phase-26 COORD-06 (Plan 01) — the PURE in-fold adapter between one center's
 * engine fold state and the proven `@mm/optimizer` core.
 *
 * Two pure functions:
 *  - {@link buildCenterTwinFromFold} projects ONE center's partitioned fold slice
 *    into a small `@mm/optimizer` `TwinSnapshot` scoped to that center — mirroring
 *    the existing full-scan `buildTwinSnapshot` OUTPUT shape but built from a fold
 *    slice, NEVER a full event-log scan / Postgres read.
 *  - `epochResultToRerouteSuggestions` (Task 2) translates an `EpochResult` into
 *    reroute-only `CoordinatorSuggestion[]`.
 *
 * DETERMINISM keystone (T-26-01/02 — DET-03): both functions are PURE — a function
 * of their inputs only. NO `Date.now()`, NO `Math.random()`, NO async, NO DB. Every
 * collection is sorted by a stable key, so the same inputs ⇒ deep-equal AND
 * byte-identical (`JSON.stringify`) outputs (replay-safe for Plan 02's in-fold call;
 * the coordinator/** ESLint guard structurally enforces the no-clock/no-RNG rule).
 *
 * NET-05 scope thesis: the builder receives the ALREADY-partitioned per-center slice
 * (`partitionScopeByCenter`, wired live in Plan 02). Its output is therefore bounded
 * by THAT center's hubs/trailers — independent of total network size. The
 * scope-size-invariance test proves the twin scales with the slice, not the network.
 */

/**
 * One in-region trailer's plain-data fold slice. Integer/string only (no live refs,
 * no float geometry) — the SAME plain-data family as `ObservedTruck`. Plan 02 fills
 * this from the in-engine fold maps; this builder only projects it.
 */
export interface CenterFoldTrailer {
  /** Stable trailer id (also the deterministic tie-break key). */
  readonly trailerId: string;
  /** Hub the trailer currently sits at / departs from. */
  readonly currentHubId: string;
  /**
   * Scheduled-departure offset in WHOLE minutes from the epoch's `nowMin`. The
   * builder derives `departureMin = nowMin + departureOffsetMin` — an integer
   * derivation off sim/event time, NEVER `Date.now()` (anti-P3).
   */
  readonly departureOffsetMin: number;
  /** Integer freight capacity (utilization denominator + the capacity gate). */
  readonly capacity: number;
  /** The trailer's remaining route stops (drives unload order). */
  readonly routeStops: readonly { readonly hubId: string; readonly stopIndex: number }[];
  /** The load blocks currently assigned to this trailer. */
  readonly blocks: readonly {
    readonly blockId: string;
    readonly nextUnloadHubId: string;
    readonly volume: number;
  }[];
}

/** One in-scope route leg's plain-data fold slice (a single `from → to` linehaul). */
export interface CenterFoldRouteLeg {
  readonly routeId: string;
  readonly fromHubId: string;
  readonly toHubId: string;
  /** Travel time along the leg, whole minutes. */
  readonly travelMin: number;
  /** Per-trip integer freight capacity. */
  readonly capacity: number;
  /** OPTIONAL leg road distance in miles (fuel-aware epoch input; additive). */
  readonly distanceMiles?: number;
}

/**
 * ONE center's partitioned, plain-data fold slice: its center id, its OWN spoke hub
 * ids, the in-region trailers (+ their remaining route stops + load blocks), and the
 * in-scope route legs. Bounded to this center's scope (NET-05) — never names another
 * center's hubs/trailers.
 */
export interface CenterFoldSlice {
  readonly centerId: string;
  readonly spokeHubIds: readonly string[];
  readonly trailers: readonly CenterFoldTrailer[];
  readonly routeLegs: readonly CenterFoldRouteLeg[];
}

/**
 * Project ONE center's fold slice into a small per-center {@link TwinSnapshot}.
 *
 * PURE + deterministic:
 *  - `hubs` = the sorted UNIQUE union of the center id, its spokes, and every hub id
 *    named on a route leg, a trailer's stops, or a block's unload target (so the twin
 *    is self-consistent — every referenced hub is in `hubs`).
 *  - `centerHubId` = the slice's `centerId` (so the epoch applies the center-role
 *    dwell, OPT-09 parity).
 *  - `routes` mirror the slice legs 1:1 (slice order preserved — the caller supplies a
 *    deterministically ordered partition).
 *  - each trailer's `route` is its stops sorted by `stopIndex` (stable); `departureMin`
 *    is `nowMin + departureOffsetMin` (integer; NEVER `Date.now`); `blocks` are carried
 *    through unchanged.
 *
 * No recomputation beyond the documented integer derivations. The source slice is
 * never mutated (all reads, fresh outputs).
 *
 * @param slice  the ALREADY-partitioned per-center fold slice (NET-05)
 * @param nowMin the epoch clock in minutes from sim/event time (NEVER `Date.now`)
 */
export function buildCenterTwinFromFold(slice: CenterFoldSlice, nowMin: number): TwinSnapshot {
  // Collect every hub the twin must self-describe: center + spokes + leg endpoints +
  // trailer stop hubs + block unload hubs. A Set dedups; a sort makes it byte-stable.
  const hubSet = new Set<string>();
  hubSet.add(slice.centerId);
  for (const spoke of slice.spokeHubIds) hubSet.add(spoke);
  for (const leg of slice.routeLegs) {
    hubSet.add(leg.fromHubId);
    hubSet.add(leg.toHubId);
  }
  for (const trailer of slice.trailers) {
    hubSet.add(trailer.currentHubId);
    for (const stop of trailer.routeStops) hubSet.add(stop.hubId);
    for (const block of trailer.blocks) hubSet.add(block.nextUnloadHubId);
  }
  const hubs: readonly string[] = [...hubSet].sort();

  // Route legs map 1:1 (preserve slice order; the partition is deterministically built).
  const routes: readonly TwinRoute[] = slice.routeLegs.map((leg) => ({
    routeId: leg.routeId,
    fromHubId: leg.fromHubId,
    toHubId: leg.toHubId,
    travelMin: leg.travelMin,
    capacity: leg.capacity,
    ...(leg.distanceMiles !== undefined ? { distanceMiles: leg.distanceMiles } : {}),
  }));

  const trailers: readonly TwinTrailer[] = slice.trailers.map((trailer) => {
    // Sort the remaining route by unload order (stopIndex asc), copying — never mutate
    // the source array. stopIndex is the stable key.
    const route: readonly TwinStop[] = [...trailer.routeStops]
      .sort((a, b) => a.stopIndex - b.stopIndex)
      .map((stop) => ({ hubId: stop.hubId, stopIndex: stop.stopIndex }));

    return {
      trailerId: trailer.trailerId,
      currentHubId: trailer.currentHubId,
      // Integer derivation off the epoch clock — NEVER Date.now (anti-P3).
      departureMin: nowMin + trailer.departureOffsetMin,
      capacity: trailer.capacity,
      route,
      blocks: trailer.blocks.map((block) => ({
        blockId: block.blockId,
        nextUnloadHubId: block.nextUnloadHubId,
        volume: block.volume,
      })),
    };
  });

  return { hubs, centerHubId: slice.centerId, routes, trailers };
}

/**
 * Translate one epoch's pure `EpochResult` into reroute-only
 * {@link CoordinatorSuggestion}s — the optimizer-backed generation that REPLACES
 * the rule-based REROUTE kind under `coordinatorUsesOptimizer` (Plan 02). The other
 * three kinds (hold/consolidate/dispatch) stay rule-based — this translator emits
 * ONLY `reroute`.
 *
 * DERIVATION (deterministic, documented per CONTEXT's discretion grant): the
 * `EpochResult` payload carries only ids/cost/feasibility/frozen flags — it has NO
 * route geometry. The optimizer's CHOSEN next hub for a trailer is therefore read
 * from the SAME `twin` the epoch planned over: each trailer's route HEAD — the first
 * stop by unload order (`route[0].hubId`, which `buildCenterTwinFromFold` already
 * sorted by `stopIndex`). A reroute is emitted for a trailer iff ALL hold:
 *  1. the epoch produced an ACTIONABLE recommendation for it — `feasible === true`
 *     AND `frozen === false` (the optimizer endorsed it proceeding; a frozen or
 *     infeasible trailer is left untouched — anti-P7 thrash),
 *  2. the trailer HAS a current next hub in `currentNextHubByTrailer` (it is mid-trip
 *     — there is a status-quo to differ from; a between-legs trailer yields none), and
 *  3. the optimizer next hub DIFFERS from that current next hub (no churn on a
 *     no-change plan).
 *
 * The reroute's `toHubId` is the optimizer next hub; `targetAgentId` is the trailer.
 * The output is sorted by `targetAgentId` (byte-stable) and is a PURE function of
 * `(result, twin, currentNextHubByTrailer)` — no `Date.now`/`Math.random`/async, so
 * the same inputs ⇒ deep-equal + byte-identical list (DET-03).
 *
 * @param result                   the pure epoch result (recommendations drive the gate)
 * @param twin                     the twin the epoch planned over (source of route heads)
 * @param currentNextHubByTrailer  each in-region trailer's CURRENT next hub (the status quo)
 */
export function epochResultToRerouteSuggestions(
  result: EpochResult,
  twin: TwinSnapshot,
  currentNextHubByTrailer: ReadonlyMap<string, string>,
): readonly CoordinatorSuggestion[] {
  // Index each trailer's optimizer-implied next hub = its twin route head (stopIndex
  // 0). `buildCenterTwinFromFold` already sorted the route, so route[0] is the head.
  const optimizerNextHubByTrailer = new Map<string, string>();
  for (const trailer of twin.trailers) {
    const head = trailer.route[0];
    if (head !== undefined) optimizerNextHubByTrailer.set(trailer.trailerId, head.hubId);
  }

  const suggestions: CoordinatorSuggestion[] = [];

  for (const recommendation of result.recommendations) {
    // Gate 1 — only ACTIONABLE recommendations (feasible + not frozen) reroute.
    if (recommendation.frozen || !recommendation.feasible) continue;

    const trailerId = recommendation.trailerId;
    const optimizerNextHub = optimizerNextHubByTrailer.get(trailerId);
    // No planned next hub (e.g. a single-stop / empty route) ⇒ nothing to reroute to.
    if (optimizerNextHub === undefined) continue;

    // Gate 2 — the trailer must be mid-trip (have a current next hub to differ from).
    const currentNextHub = currentNextHubByTrailer.get(trailerId);
    if (currentNextHub === undefined) continue;

    // Gate 3 — only a CHANGE reroutes (no churn on a no-change plan — anti-P7).
    if (optimizerNextHub === currentNextHub) continue;

    suggestions.push({ kind: "reroute", targetAgentId: trailerId, toHubId: optimizerNextHub });
  }

  // Byte-stable output order (the golden hash is JSON.stringify, order-sensitive).
  suggestions.sort((a, b) => (a.targetAgentId < b.targetAgentId ? -1 : a.targetAgentId > b.targetAgentId ? 1 : 0));
  return suggestions;
}
