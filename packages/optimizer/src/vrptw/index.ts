/**
 * `@mm/optimizer` — the VRPTW heuristic barrel (OPT-03).
 *
 * The Wave-2 trailer router: cheapest-insertion CONSTRUCTION → 2-opt/or-opt LOCAL
 * SEARCH → `routeTrailers` (ETAs + utilization), with trailer-load feasibility
 * GATED by the REUSED Phase-2 `validatePlan`/`isFeasible` (no LIFO reimpl — DRY).
 * Pure + deterministic: no clock, no RNG; integer-minute arithmetic; lexicographic
 * tie-breaks. `glpk.js` is a TEST-ONLY devDependency, never imported here.
 *
 * The root `src/index.ts` re-exports this barrel; this plan OWNS this file and
 * never touches the root or another plan's barrel (the no-merge-conflict
 * convention).
 */

// --- The VRPTW contract (strong-typed router boundary) -----------------------
export type {
  CandidateRoute,
  RoutedStop,
  Stop,
  TrailerRoute,
  TravelModel,
} from "./types.js";

// --- Shared feasibility + cost predicates (DRY: used by both construct + search)
export { feasibleArrivals, routeCost, totalDemand } from "./feasibility.js";

// --- Cheapest-insertion construction (OPT-03) --------------------------------
export {
  constructRoutes,
  type ConstructInput,
  type ConstructionResult,
} from "./construct.js";

// --- 2-opt / or-opt local search (OPT-03) ------------------------------------
export { localSearch, type LocalSearchInput } from "./local-search.js";

// --- The routeTrailers pipeline entry (OPT-03) -------------------------------
export { routeTrailers, type RouteTrailersInput } from "./route-trailers.js";
