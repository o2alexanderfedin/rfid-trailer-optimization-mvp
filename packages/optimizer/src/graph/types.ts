/**
 * `@mm/optimizer` — the time-expanded flow-graph CONTRACT (OPT-01).
 *
 * This module is the interface-first foundation every Wave-2 optimizer plan
 * (Plan 03 min-cost flow, the VRPTW heuristic, the objective, the repair loop)
 * builds against. Defining `TimeExpandedGraph` / `FlowEdge` / `FlowNode` /
 * `EdgeKind` here — BEFORE the solver exists — lets the algorithm plans compile
 * against a fixed shape with zero codebase scavenger-hunting.
 *
 * Discipline (carried from the Phase-1/2 pure leaves):
 *  - PURE, types + value-helpers only: imports only `@mm/domain`. No I/O, no
 *    clock (`Date.now()`), no RNG (`Math.random()`) anywhere in this package's
 *    `src` — the graph is a deterministic function of its inputs (PITFALLS P3).
 *  - INTEGER costs + capacities (PITFALLS P12): JS `number` is float64; mixing
 *    float costs into the successive-shortest-path / glpk min-cost-flow solver
 *    silently flips the optimum under rounding. Costs are scaled to integers at
 *    the graph boundary so the solver (Plan 03) only ever sees integers, and the
 *    glpk.js oracle agrees to the last unit.
 *  - COARSE time nodes (PITFALLS P9): nodes are stepped by a fixed
 *    `timeStepMin` (15-min default) over a scope-bounded horizon, so the
 *    time-expanded graph stays small (node count bounded by hubs × timesteps).
 */

/**
 * The six edge kinds of the time-expanded hub-network graph (tech spec §11.2).
 *
 *  - `trip`      — a scheduled linehaul leg `A@t → B@(t+travel)` (a trailer
 *                  moving between hubs); the only edge that changes hub.
 *  - `wait`      — staying at the same hub across one timestep `A@t → A@(t+step)`
 *                  (idle dwell — catching a later trailer).
 *  - `hold`      — deliberately holding freight at a hub across a timestep
 *                  (over-carry / deferred connection); same shape as `wait` but a
 *                  distinct, separately-costed decision.
 *  - `crossDock` — moving freight from an inbound to an outbound position within
 *                  one hub timestep (inbound → outbound transfer).
 *  - `load`      — loading freight onto a trailer at a hub (handling).
 *  - `unload`    — unloading freight from a trailer at a hub (handling).
 */
export type EdgeKind = "trip" | "wait" | "crossDock" | "load" | "unload" | "hold";

/**
 * A hub-at-time node in the time-expanded graph. `timeMin` is minutes from the
 * scope horizon start (an integer multiple of the scope `timeStepMin`). The
 * canonical id is `${hubId}@${timeMin}` ({@link nodeId}).
 */
export interface FlowNode {
  /** Canonical id `${hubId}@${timeMin}` — unique within a graph. */
  readonly id: string;
  /** The hub this node lives at. */
  readonly hubId: string;
  /** Minutes from the horizon start (integer multiple of `timeStepMin`). */
  readonly timeMin: number;
}

/**
 * A directed, capacitated, integer-costed edge between two {@link FlowNode}s.
 *
 * Time-window respect is structural: every edge's head node time is `>=` its
 * tail node time (`headNode.timeMin >= tailNode.timeMin`), so flow never travels
 * backwards in time. Both `capacity` and `cost` are non-negative integers
 * (PITFALLS P12) — `cost` is the scaled cost PER UNIT of flow.
 */
export interface FlowEdge {
  /** Stable, unique edge id (deterministic — derived from kind + endpoints). */
  readonly id: string;
  /** Tail node id ({@link FlowNode.id}). */
  readonly from: string;
  /** Head node id ({@link FlowNode.id}). */
  readonly to: string;
  /** Which of the six §11.2 edge kinds this is. */
  readonly kind: EdgeKind;
  /** Non-negative integer flow capacity. */
  readonly capacity: number;
  /** Non-negative integer cost per unit flow (scaled — PITFALLS P12). */
  readonly cost: number;
}

/**
 * The built time-expanded graph: the substrate the Plan-03 min-cost-flow solver
 * runs over. `nodes` and `edges` are in a DETERMINISTIC order (sorted by their
 * stable ids) so the same `(network, schedule, scope)` yields a byte-identical
 * graph (PITFALLS P3). `nodeIndex` maps every {@link FlowNode.id} to its node
 * for O(1) endpoint resolution.
 */
export interface TimeExpandedGraph {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly nodeIndex: ReadonlyMap<string, FlowNode>;
}

/**
 * The scoped horizon the graph is built over (anti-P9 graph-explosion guard).
 *
 * The graph is bounded to `hubIds` × the timesteps of
 * `[horizonStartMin, horizonEndMin]` stepped by `timeStepMin`, and to trips
 * involving `trailerIds`. A rolling epoch passes the affected scope only — never
 * the whole network — so the time-expanded graph stays small.
 */
export interface OptimizerScope {
  /** Hubs in scope; one node column per hub. */
  readonly hubIds: readonly string[];
  /** Trailers in scope; trips on out-of-scope trailers are excluded. */
  readonly trailerIds: readonly string[];
  /** Horizon start, minutes from a fixed epoch (from sim/event time, not the wall clock). */
  readonly horizonStartMin: number;
  /** Horizon end, minutes from the same fixed epoch (exclusive upper bound on node times). */
  readonly horizonEndMin: number;
  /** Node time granularity in minutes (coarse — 15-min default, PITFALLS P9). */
  readonly timeStepMin: number;
}

/**
 * The static hub network the graph is built from — the hubs and route legs in
 * play. Both are `@mm/domain` entity arrays so the optimizer never re-models the
 * Phase-1 network (DRY). Only hubs referenced by in-scope nodes/trips matter.
 */
export interface OptimizerNetwork {
  /** Hubs that may appear as node columns. */
  readonly hubs: readonly OptimizerHub[];
  /** Route legs trips run along (carry per-leg travel + capacity). */
  readonly routes: readonly OptimizerRoute[];
}

/** A hub in the optimizer network (the subset OPT-01 needs: identity). */
export interface OptimizerHub {
  readonly hubId: string;
}

/**
 * A route leg in the optimizer network: a single `fromHubId → toHubId` linehaul
 * with its travel time (minutes) and per-trip trailer capacity (integer units —
 * e.g. load-block slots). Mirrors the `@mm/domain` single-leg `Route`, extended
 * with the optimizer-relevant travel/capacity OPT-01 needs.
 */
export interface OptimizerRoute {
  readonly routeId: string;
  readonly fromHubId: string;
  readonly toHubId: string;
  /** Travel time along the leg, in minutes (rounded to timesteps when expanded). */
  readonly travelMin: number;
  /** Per-trip trailer flow capacity (integer units of freight). */
  readonly capacity: number;
}

/**
 * The schedule the graph is built from: the concrete trips departing on routes
 * over the horizon. Each trip becomes (at most) one `trip` edge in the graph.
 */
export interface OptimizerSchedule {
  readonly trips: readonly ScheduledTrip[];
}

/**
 * A scheduled trip: a trailer departing a hub on a route leg at a known time.
 * The departure time is minutes from the same fixed epoch as the scope horizon
 * (from sim/event time — never the wall clock).
 */
export interface ScheduledTrip {
  readonly tripId: string;
  readonly trailerId: string;
  readonly routeId: string;
  /** Departure time, minutes from the fixed epoch. */
  readonly departMin: number;
}

/**
 * Integer cost/capacity knobs for graph construction (anti-P12). All costs are
 * already-scaled non-negative INTEGERS (e.g. cents / scaled minutes) so the
 * min-cost-flow solver and the glpk.js oracle only ever see integers.
 *
 * Defaults live in {@link DEFAULT_GRAPH_CONFIG}; callers may override per epoch.
 */
export interface GraphConfig {
  /** Per-timestep cost of a `wait` self-edge (idle dwell). */
  readonly waitCost: number;
  /** Per-timestep cost of a `hold` self-edge (deliberate over-carry hold). */
  readonly holdCost: number;
  /** Handling cost of a `load` edge at a hub. */
  readonly loadCost: number;
  /** Handling cost of an `unload` edge at a hub. */
  readonly unloadCost: number;
  /** Handling cost of a `crossDock` edge at a hub. */
  readonly crossDockCost: number;
  /** Per-minute cost applied to a `trip` edge (multiplied by leg travel minutes). */
  readonly tripCostPerMin: number;
  /** Capacity of the per-hub handling edges (load/unload/crossDock/wait/hold). */
  readonly hubHandlingCapacity: number;
}

/**
 * Spec-derived, integer graph-config defaults. Conservative demo values — every
 * field is a non-negative integer so the solver/oracle never see floats. The
 * §11.2 edge taxonomy is costed so a `trip` (movement) is favoured over a long
 * `hold` (over-carry), and `wait` (cheap idle) over `hold` (deliberate carry).
 */
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  waitCost: 1,
  holdCost: 2,
  loadCost: 5,
  unloadCost: 5,
  crossDockCost: 8,
  tripCostPerMin: 1,
  hubHandlingCapacity: 1_000_000,
};
