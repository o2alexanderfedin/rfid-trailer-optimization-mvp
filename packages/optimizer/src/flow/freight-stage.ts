import {
  buildTimeExpandedGraph,
  nodeId,
} from "../graph/time-expanded.js";
import {
  DEFAULT_GRAPH_CONFIG,
  type GraphConfig,
  type OptimizerNetwork,
  type OptimizerRoute,
  type OptimizerSchedule,
  type OptimizerScope,
  type ScheduledTrip,
} from "../graph/types.js";
import type { Epoch, TwinSnapshot, TwinTrailer } from "../rolling/types.js";
import { assignFreight, type FreightAssignment } from "./assign-freight.js";
import { minCostFlow } from "./min-cost-flow.js";
import type { Supply } from "./types.js";

/**
 * F-06 / OPT-02 — `assignFreightForEpoch`: run the min-cost-flow freight stage
 * over the IN-SCOPE planning twin for one rolling epoch.
 *
 * This is the live wiring of the (until now dead-on-the-live-path) MCF solver +
 * the Plan-02 time-expanded graph. It runs BEFORE / orthogonally to VRPTW
 * (`routeTrailers`): VRPTW *sequences* a trailer's pre-assigned stops; MCF
 * answers the separate OPT-02 question — which freight block flows over which
 * route leg at minimum total cost under shared edge/hub capacity.
 *
 * Construction (all derived from the already-scoped twin — anti-P9):
 *   (a) `OptimizerNetwork` — twin hubs + twin route legs.
 *   (b) `OptimizerSchedule` — one `ScheduledTrip` per (in-scope trailer, distinct
 *       block-unload hub) for which a route leg `currentHub → unloadHub` exists,
 *       departing at the trailer's `departureMin`.
 *   (c) `OptimizerScope` — the twin's hubs + trailers over the horizon
 *       `[nowMin, horizonEnd]` at a 15-min step. `horizonEnd` is the LARGER of
 *       the configured default (`nowMin + (horizonMin ?? 3·TRANSIT_MIN)`) and
 *       `max(trip arrival) + one step`, so every in-scope trip node fits inside
 *       the graph (else MCF silently assigns nothing — a documented hazard).
 *   (d) `buildTimeExpandedGraph(network, schedule, scope, cfg)`.
 *   (e) a BALANCED `Supply[]`: `+volume` at `currentHub@departTimestep`,
 *       `−volume` at `nextUnloadHub@arrivalTimestep`. A block is DROPPED (as a
 *       matched +/− pair) whenever its origin OR sink node is absent from the
 *       graph — preserving `Σ supplies = 0` (minCostFlow THROWS otherwise).
 *   (f) `assignFreight(graph, supplies)` + `minCostFlow(graph, supplies)`.
 *
 * PURE + deterministic (anti-P3): no clock, no RNG; every Map/Set is iterated in
 * id-sorted order so two identical epochs return a DEEP-EQUAL result (the OPT-06
 * keystone — including this new field).
 *
 * FAIL-SOFT: an empty scope, a graph with no trip edges, or any infeasible /
 * unroutable freight all yield `{ assignments: [], flowCost: 0, feasible: true }`
 * — the freight stage NEVER throws and NEVER blocks the epoch.
 */
export interface EpochFreightAssignment {
  /** Per-block leg assignments from the optimal flow decomposition. */
  readonly assignments: readonly FreightAssignment[];
  /** `Σ assignment.cost` — equals the {@link minCostFlow} optimum (0 if none). */
  readonly flowCost: number;
  /** Whether the requested freight could be routed (always true when empty). */
  readonly feasible: boolean;
}

/** A nominal one-leg transit time used to size the default horizon (minutes). */
const TRANSIT_MIN = 60;

/** The MCF graph node-time granularity (matches DEFAULT scope step). */
const TIME_STEP_MIN = 15;

/** The fail-soft empty result (no freight routed, feasible by definition). */
const EMPTY_RESULT: EpochFreightAssignment = {
  assignments: [],
  flowCost: 0,
  feasible: true,
};

/** Ascending string comparator for deterministic id-sorted iteration (anti-P3). */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Round a (possibly fractional) per-leg transit estimate to a NON-NEGATIVE
 * INTEGER minute count at the graph boundary (anti-P12). `TwinRoute.travelMin`
 * carries the deterministic expected-transit MEAN, which is fractional; the
 * time-expanded min-cost-flow graph only ever sees integers so the solver and
 * the glpk.js oracle agree to the last unit.
 */
function toNonNegIntMinutes(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
}

/** Round an absolute minute UP to the scope grid `start + k·step` (matches the graph builder). */
function ceilToStep(absoluteMin: number, startMin: number, stepMin: number): number {
  const steps = Math.ceil((absoluteMin - startMin) / stepMin);
  return startMin + steps * stepMin;
}

/**
 * Build the freight stage for one epoch over the IN-SCOPE twin.
 *
 * @param twin       the scoped planning twin (already `buildTwin`-filtered)
 * @param epoch      the epoch clock (supplies `nowMin` — never `Date.now`)
 * @param cfg        integer graph-config knobs (defaults to {@link DEFAULT_GRAPH_CONFIG})
 * @param horizonMin optional horizon length override in minutes
 * @returns a fail-soft {@link EpochFreightAssignment}
 */
export function assignFreightForEpoch(
  twin: TwinSnapshot,
  epoch: Epoch,
  cfg: GraphConfig = DEFAULT_GRAPH_CONFIG,
  horizonMin?: number,
): EpochFreightAssignment {
  // Fail-soft: nothing in scope ⇒ nothing to route.
  if (twin.trailers.length === 0 || twin.routes.length === 0) {
    return EMPTY_RESULT;
  }

  const startMin = epoch.nowMin;

  // (a) network — twin hubs + route legs (id-sorted for determinism).
  const network: OptimizerNetwork = {
    hubs: [...twin.hubs].sort(byString).map((hubId) => ({ hubId })),
    routes: [...twin.routes]
      .map(
        (r): OptimizerRoute => ({
          routeId: r.routeId,
          fromHubId: r.fromHubId,
          toHubId: r.toHubId,
          // OPT-09 / OPT-10: `TwinRoute.travelMin` is the deterministic per-leg
          // expected transit MEAN (the twin builder derives it from
          // `expectedTransitMinutes`). The time-expanded graph drives
          // `arriveTimestep = ceilToStep(departMin + travelMin)` and the integer
          // trip cost, so the (possibly fractional) mean is rounded to a
          // non-negative integer HERE, at the graph boundary (anti-P12), before
          // it reaches `buildTimeExpandedGraph`.
          travelMin: toNonNegIntMinutes(r.travelMin),
          capacity: r.capacity,
        }),
      )
      .sort((a, b) => byString(a.routeId, b.routeId)),
  };

  // Index route legs by `${from}->${to}` so a trip can be created per block hop.
  const legByPair = new Map<string, OptimizerRoute>();
  for (const r of network.routes) {
    // First write wins on duplicate legs (deterministic — routes are id-sorted).
    const key = `${r.fromHubId}->${r.toHubId}`;
    if (!legByPair.has(key)) legByPair.set(key, r);
  }

  // (b) schedule — one trip per (trailer, distinct next-unload hub) with a real
  //     `currentHub → unloadHub` leg. Plus the matched supply pairs (e).
  const trips: ScheduledTrip[] = [];
  // A supply pair candidate, recorded before we know if both nodes are in-graph.
  interface PairCandidate {
    readonly blockId: string;
    readonly originNodeId: string;
    readonly sinkNodeId: string;
    readonly volume: number;
  }
  const pairCandidates: PairCandidate[] = [];
  let maxArrivalMin = startMin;

  // Trailers id-sorted; blocks aggregated by unload hub id-sorted (determinism).
  const sortedTrailers = [...twin.trailers].sort((a, b) =>
    byString(a.trailerId, b.trailerId),
  );

  for (const trailer of sortedTrailers) {
    const departMin = trailer.departureMin;
    const volumeByHub = aggregateVolumeByUnloadHub(trailer);
    const unloadHubs = [...volumeByHub.keys()].sort(byString);

    for (const unloadHubId of unloadHubs) {
      const volume = volumeByHub.get(unloadHubId) ?? 0;
      if (volume <= 0) continue;

      const leg = legByPair.get(`${trailer.currentHubId}->${unloadHubId}`);
      if (leg === undefined) {
        // No direct leg from the trailer's current hub to this unload hub — the
        // block cannot be modelled as a single-hop trip; drop it (fail-soft).
        continue;
      }

      const arriveMin = departMin + leg.travelMin;
      const departTimestep = ceilToStep(departMin, startMin, TIME_STEP_MIN);
      const arriveTimestep = ceilToStep(arriveMin, startMin, TIME_STEP_MIN);
      if (arriveTimestep > maxArrivalMin) maxArrivalMin = arriveTimestep;

      trips.push({
        tripId: `${trailer.trailerId}:${leg.routeId}:${departMin}`,
        trailerId: trailer.trailerId,
        routeId: leg.routeId,
        departMin,
      });

      pairCandidates.push({
        blockId: `${trailer.trailerId}:${unloadHubId}`,
        originNodeId: nodeId(trailer.currentHubId, departTimestep),
        sinkNodeId: nodeId(unloadHubId, arriveTimestep),
        volume,
      });
    }
  }

  if (trips.length === 0) {
    // No modellable hops ⇒ no trip edges ⇒ nothing to assign (fail-soft).
    return EMPTY_RESULT;
  }

  const schedule: OptimizerSchedule = { trips };

  // (c) scope — derive horizonEnd so EVERY in-scope trip arrival fits inside the
  //     graph (else MCF silently routes nothing). Take the larger of the
  //     configured default and `maxArrival + one step` (end is exclusive).
  const defaultHorizonEnd = startMin + (horizonMin ?? 3 * TRANSIT_MIN);
  const horizonEndMin = Math.max(defaultHorizonEnd, maxArrivalMin + TIME_STEP_MIN);

  const scope: OptimizerScope = {
    hubIds: network.hubs.map((h) => h.hubId),
    trailerIds: sortedTrailers.map((t) => t.trailerId),
    horizonStartMin: startMin,
    horizonEndMin,
    timeStepMin: TIME_STEP_MIN,
  };

  // (d) graph.
  const graph = buildTimeExpandedGraph(network, schedule, scope, cfg);

  if (graph.edges.every((e) => e.kind !== "trip")) {
    // No trip edges survived (off-grid / out-of-scope) ⇒ nothing to route.
    return EMPTY_RESULT;
  }

  // (e) BALANCED supplies. Drop any candidate whose origin OR sink node is absent
  //     from the graph (keeps Σ = 0 — minCostFlow THROWS on imbalance). Aggregate
  //     by node so multiple blocks to the same origin/sink coalesce cleanly.
  const supplyByNode = new Map<string, number>();
  // id-sort candidates for deterministic supply construction.
  const sortedCandidates = [...pairCandidates].sort((a, b) =>
    byString(a.blockId, b.blockId),
  );
  for (const c of sortedCandidates) {
    if (!graph.nodeIndex.has(c.originNodeId)) continue;
    if (!graph.nodeIndex.has(c.sinkNodeId)) continue;
    supplyByNode.set(c.originNodeId, (supplyByNode.get(c.originNodeId) ?? 0) + c.volume);
    supplyByNode.set(c.sinkNodeId, (supplyByNode.get(c.sinkNodeId) ?? 0) - c.volume);
  }

  // Materialise supplies in id-sorted node order; drop net-zero nodes.
  const supplies: Supply[] = [...supplyByNode.keys()]
    .sort(byString)
    .map((nid) => ({ nodeId: nid, amount: supplyByNode.get(nid) ?? 0 }))
    .filter((s) => s.amount !== 0);

  if (supplies.length === 0) {
    // No routable freight survived the on-graph filter (fail-soft).
    return EMPTY_RESULT;
  }

  // Defensive balance assertion (anti-P12). Construction guarantees Σ = 0; if a
  // future change broke it, fail soft rather than letting minCostFlow throw.
  const sum = supplies.reduce((acc, s) => acc + s.amount, 0);
  if (sum !== 0) return EMPTY_RESULT;

  // (f) assign + cost.
  const assignments = assignFreight(graph, supplies);
  const flow = minCostFlow(graph, supplies);
  const flowCost = flow.feasible
    ? assignments.reduce((acc, a) => acc + a.cost, 0)
    : 0;

  return {
    assignments: flow.feasible ? assignments : [],
    flowCost,
    feasible: flow.feasible,
  };
}

/** Sum a trailer's block volumes per next-unload hub (deterministic aggregation). */
function aggregateVolumeByUnloadHub(trailer: TwinTrailer): Map<string, number> {
  const byHub = new Map<string, number>();
  for (const b of trailer.blocks) {
    byHub.set(b.nextUnloadHubId, (byHub.get(b.nextUnloadHubId) ?? 0) + b.volume);
  }
  return byHub;
}
