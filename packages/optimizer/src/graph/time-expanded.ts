import {
  DEFAULT_GRAPH_CONFIG,
  type EdgeKind,
  type FlowEdge,
  type FlowNode,
  type GraphConfig,
  type OptimizerNetwork,
  type OptimizerRoute,
  type OptimizerSchedule,
  type OptimizerScope,
  type ScheduledTrip,
  type TimeExpandedGraph,
} from "./types.js";

/**
 * OPT-01 — `buildTimeExpandedGraph(network, schedule, scope)`: the pure,
 * deterministic time-expanded hub-network graph builder (tech spec §11.2).
 *
 * It expands the static hub network into hub@time nodes over the scoped horizon
 * and connects them with the six edge kinds — `trip` (scheduled linehaul),
 * `wait` / `hold` (same-hub self-progress across a timestep), and `load` /
 * `unload` / `crossDock` (in-place handling at a hub node) — each with an INTEGER
 * cost + capacity (anti-P12) and a head time `>=` its tail time (time-window
 * respect). Nodes and edges are sorted by their stable ids so the same inputs
 * replay byte-identically (anti-P3) — the substrate the Plan-03 min-cost-flow
 * solver runs over.
 *
 * Purity: imports only `@mm/domain`-derived contract types; NO clock
 * (`Date.now()`), NO RNG (`Math.random()`). The horizon/trip times come from
 * sim/event time supplied by the caller, never the wall clock.
 */

/** Canonical node id for a hub-at-time node: `${hubId}@${timeMin}`. */
export function nodeId(hubId: string, timeMin: number): string {
  return `${hubId}@${timeMin}`;
}

/**
 * Round an absolute minute value UP to the scope timestep grid
 * (`horizonStart + k * step`). Rounding UP (never down) guarantees flow never
 * "arrives early": a trip arriving between two grid points lands on the next
 * node, so `head.timeMin >= depart + travel` always holds (time-window respect).
 */
function ceilToStep(absoluteMin: number, scope: OptimizerScope): number {
  const { horizonStartMin, timeStepMin } = scope;
  const offset = absoluteMin - horizonStartMin;
  const steps = Math.ceil(offset / timeStepMin);
  return horizonStartMin + steps * timeStepMin;
}

/**
 * The ordered timestep grid of the scope: `[start, end)` stepped by
 * `timeStepMin` (end exclusive). Deterministic ascending order.
 */
function timestepsOf(scope: OptimizerScope): number[] {
  const out: number[] = [];
  for (let t = scope.horizonStartMin; t < scope.horizonEndMin; t += scope.timeStepMin) {
    out.push(t);
  }
  return out;
}

/** Build the hub@time node set: one node per (in-scope hub, timestep). */
function buildNodes(scope: OptimizerScope): FlowNode[] {
  const hubIds = [...new Set(scope.hubIds)];
  const timesteps = timestepsOf(scope);
  const nodes: FlowNode[] = [];
  for (const hubId of hubIds) {
    for (const timeMin of timesteps) {
      nodes.push({ id: nodeId(hubId, timeMin), hubId, timeMin });
    }
  }
  return nodes;
}

/** A stable edge id from kind + endpoints (deterministic, unique per kind/pair). */
function edgeId(kind: EdgeKind, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

/**
 * The `wait` / `hold` self-progress edges: at each hub, connect every timestep
 * node to the next one (`A@t → A@(t+step)`). `wait` is cheap idle dwell; `hold`
 * is a deliberate over-carry hold (a distinct, separately-costed decision).
 */
function buildSelfProgressEdges(
  nodesByHub: ReadonlyMap<string, readonly FlowNode[]>,
  cfg: GraphConfig,
): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const hubNodes of nodesByHub.values()) {
    for (let i = 0; i + 1 < hubNodes.length; i += 1) {
      const from = hubNodes[i]!.id;
      const to = hubNodes[i + 1]!.id;
      edges.push(makeEdge("wait", from, to, cfg.hubHandlingCapacity, cfg.waitCost));
      edges.push(makeEdge("hold", from, to, cfg.hubHandlingCapacity, cfg.holdCost));
    }
  }
  return edges;
}

/**
 * The in-place handling self-edges (`from === to`) at every hub node:
 * `load`, `unload`, `crossDock` (inbound→outbound within one hub timestep).
 * These model the handling cost of touching freight at a hub.
 */
function buildHandlingEdges(nodes: readonly FlowNode[], cfg: GraphConfig): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const n of nodes) {
    edges.push(makeEdge("load", n.id, n.id, cfg.hubHandlingCapacity, cfg.loadCost));
    edges.push(makeEdge("unload", n.id, n.id, cfg.hubHandlingCapacity, cfg.unloadCost));
    edges.push(
      makeEdge("crossDock", n.id, n.id, cfg.hubHandlingCapacity, cfg.crossDockCost),
    );
  }
  return edges;
}

/**
 * The `trip` edges: one per scheduled trip whose trailer is in scope and whose
 * rounded departure AND arrival nodes both exist in the graph. Connects
 * `from@departTimestep → to@arrivalTimestep` with the route capacity and an
 * integer travel-scaled cost.
 */
function buildTripEdges(
  schedule: OptimizerSchedule,
  routesById: ReadonlyMap<string, OptimizerRoute>,
  nodeIds: ReadonlySet<string>,
  scope: OptimizerScope,
  cfg: GraphConfig,
): FlowEdge[] {
  const inScopeTrailers = new Set(scope.trailerIds);
  const edges: FlowEdge[] = [];

  for (const trip of schedule.trips) {
    const edge = tripEdge(trip, routesById, nodeIds, inScopeTrailers, scope, cfg);
    if (edge !== undefined) {
      edges.push(edge);
    }
  }
  return edges;
}

/** Build one trip edge, or `undefined` if it is out of scope / off-grid. */
function tripEdge(
  trip: ScheduledTrip,
  routesById: ReadonlyMap<string, OptimizerRoute>,
  nodeIds: ReadonlySet<string>,
  inScopeTrailers: ReadonlySet<string>,
  scope: OptimizerScope,
  cfg: GraphConfig,
): FlowEdge | undefined {
  if (!inScopeTrailers.has(trip.trailerId)) {
    return undefined;
  }
  const route = routesById.get(trip.routeId);
  if (route === undefined) {
    return undefined;
  }

  const departTimestep = ceilToStep(trip.departMin, scope);
  const arriveTimestep = ceilToStep(trip.departMin + route.travelMin, scope);

  const fromId = nodeId(route.fromHubId, departTimestep);
  const toId = nodeId(route.toHubId, arriveTimestep);

  // Both endpoints must be real in-graph nodes (in scope + within the horizon).
  if (!nodeIds.has(fromId) || !nodeIds.has(toId)) {
    return undefined;
  }

  const cost = cfg.tripCostPerMin * route.travelMin;
  return makeEdge("trip", fromId, toId, route.capacity, cost);
}

/** Construct an edge with an integer-guarded cost/capacity. */
function makeEdge(
  kind: EdgeKind,
  from: string,
  to: string,
  capacity: number,
  cost: number,
): FlowEdge {
  return {
    id: edgeId(kind, from, to),
    from,
    to,
    kind,
    capacity: toNonNegInt(capacity),
    cost: toNonNegInt(cost),
  };
}

/** Clamp+round to a non-negative integer (anti-P12: the solver only sees ints). */
function toNonNegInt(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
}

/** Ascending string comparator for stable, deterministic id sorting. */
function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Build the time-expanded hub-network graph (OPT-01).
 *
 * @param network  the static hubs + route legs (travel + capacity per leg)
 * @param schedule the concrete trips departing over the horizon
 * @param scope    the bounded hubs × timesteps × trailers (anti-P9)
 * @param cfg      integer cost/capacity knobs (defaults to {@link DEFAULT_GRAPH_CONFIG})
 * @returns a deterministic, integer-costed {@link TimeExpandedGraph}
 */
export function buildTimeExpandedGraph(
  network: OptimizerNetwork,
  schedule: OptimizerSchedule,
  scope: OptimizerScope,
  cfg: GraphConfig = DEFAULT_GRAPH_CONFIG,
): TimeExpandedGraph {
  // --- Nodes (sorted by id for determinism) ---
  const nodes = buildNodes(scope).sort(byId);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Group nodes by hub, each group ascending in time, for self-progress edges.
  const nodesByHub = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    const group = nodesByHub.get(n.hubId);
    if (group === undefined) {
      nodesByHub.set(n.hubId, [n]);
    } else {
      group.push(n);
    }
  }
  for (const group of nodesByHub.values()) {
    group.sort((a, b) => a.timeMin - b.timeMin);
  }

  const routesById = new Map<string, OptimizerRoute>();
  for (const r of network.routes) {
    routesById.set(r.routeId, r);
  }

  // --- Edges (concatenate the kinds, then sort by id for determinism) ---
  const edges: FlowEdge[] = [
    ...buildTripEdges(schedule, routesById, nodeIds, scope, cfg),
    ...buildSelfProgressEdges(nodesByHub, cfg),
    ...buildHandlingEdges(nodes, cfg),
  ].sort(byId);

  const nodeIndex = new Map<string, FlowNode>();
  for (const n of nodes) {
    nodeIndex.set(n.id, n);
  }

  return { nodes, edges, nodeIndex };
}
