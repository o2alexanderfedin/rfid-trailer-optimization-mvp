import {
  applyDrivingLeg,
  DEFAULT_HOS_CONFIG,
  DEFAULT_PLANNER_CONFIG,
  epochMinutesToIso,
  type HosClock,
  type HosConfig,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
} from "@mm/domain";
import { isFeasible, validatePlan } from "@mm/load-planner";

import { constructRoutes } from "./construct.js";
import { feasibleArrivals, totalDemand } from "./feasibility.js";
import { localSearch } from "./local-search.js";
import type {
  DriverHosContext,
  RoutedStop,
  Stop,
  TrailerRoute,
  TravelModel,
} from "./types.js";

/**
 * `@mm/optimizer` — `routeTrailers`: the VRPTW pipeline entry (OPT-03, Task 3).
 *
 * Routes ONE trailer over its stops:
 *   1. CONSTRUCT a window+capacity-feasible route by cheapest insertion.
 *   2. IMPROVE it with 2-opt/or-opt local search (never worsening, never
 *      violating).
 *   3. Derive arrival/departure ETAs from the {@link TravelModel} + service
 *      times, and a `utilization` estimate (`totalDemand / capacity`).
 *   4. GATE the resulting trailer LOAD through the REUSED Phase-2
 *      `validatePlan`/`isFeasible` — the LIFO accessibility HARD gate is NEVER
 *      reimplemented here (DRY; the optimizer owns no blocker/invariant logic of
 *      its own — feasibility comes only from `@mm/load-planner`).
 *
 * The route's `feasible` flag is the AND of three SEPARATE hard checks, all
 * distinct from any cost objective (anti-P2): (a) every stop placed within its
 * window + capacity (construction left nothing unplaced), and (b) the derived
 * ETAs re-verify window-feasibility, and (c) the trailer load passes the reused
 * LIFO HARD gate. Pure + deterministic: no clock, no RNG (anti-P3).
 *
 * Load ⇄ route bridge: each stop carries one {@link LoadBlock} whose
 * `nextUnloadHubId` is the stop's hub. The trailer is loaded LIFO-correctly —
 * the k-th stop's block at slice depth k (depth 0 = rear = unloaded first) — so a
 * window/capacity-feasible route also yields a LIFO-feasible load. The validator
 * re-derives unload order independently from the route, so this is a genuine
 * cross-check, not a tautology.
 */

/** The input to {@link routeTrailers}: one trailer, its capacity, and its stops. */
export interface RouteTrailersInput {
  /** The trailer being routed. */
  readonly trailerId: string;
  /** Integer freight capacity (the capacity hard gate + utilization denominator). */
  readonly capacity: number;
  /** Stops to service (order irrelevant — the router orders them). */
  readonly stops: readonly Stop[];
  /** Hub the trailer departs from (route origin for ETAs + cost). */
  readonly startHubId: string;
  /** Pure, deterministic travel oracle. */
  readonly travel: TravelModel;
  /** Minute the trailer leaves `startHubId` (default 0). */
  readonly startMin?: number;
  /** Planner config for the reused HARD gate (default {@link DEFAULT_PLANNER_CONFIG}). */
  readonly config?: PlannerConfig;
  /**
   * OPT-HOS-02 — OPTIONAL assigned-driver HOS context. When present (and ONLY
   * then), the HARD HOS gate runs: each driving leg is checked through the shared
   * Phase-10 engine and a leg the driver cannot legally complete makes the route
   * `hosFeasible: false` (folded into `feasible`). Absent ⇒ the gate is inactive
   * and `hosFeasible` is `undefined` (pre-Phase-16 back-compat).
   */
  readonly driver?: DriverHosContext;
}

/**
 * Build the `(plan, blocks, route)` triple the REUSED `validatePlan` consumes
 * from an ordered VRPTW stop sequence, loading the trailer LIFO-correctly.
 *
 * Stop `k` (0-based, in service order) becomes:
 *  - a {@link RouteStop} `{ hubId, stopIndex: k }` (drives the validator's
 *    independent unload-order recompute),
 *  - a {@link LoadBlock} destined to that hub,
 *  - a slice at `depth: k` holding that block (rear→nose = first→last unload).
 *
 * Each stop is a DISTINCT unload event in time, so its synthetic gate hub id is
 * made unique per stop position (`"<hubId>#<k>"`). A route that REVISITS a hub
 * (e.g. 0→10→0) thus yields strictly-increasing unload orders (0,1,2,…) instead
 * of collapsing both visits of the revisited hub to one order — which previously
 * counted PHANTOM blockers against the later visit (the block loaded at the nose
 * and unloaded LAST was mis-ranked as unloading first), falsely failing LIFO.
 * Distinguishing the visits makes unloadOrder == depth == k, the physically
 * correct (zero-blocker) LIFO load. Non-revisiting routes are unaffected (every
 * hub already unique). This is the ONLY place the optimizer talks to the load
 * planner; it never computes feasibility itself.
 */
function buildLoadForGate(sequence: readonly Stop[]): {
  readonly plan: { readonly slices: readonly { readonly depth: number; readonly loadBlockIds: readonly string[] }[] };
  readonly blocks: readonly LoadBlock[];
  readonly route: readonly RouteStop[];
} {
  const route: RouteStop[] = [];
  const blocks: LoadBlock[] = [];
  const slices: { depth: number; loadBlockIds: string[] }[] = [];

  sequence.forEach((stop, k) => {
    const loadBlockId = "vrptw-blk-" + String(k) + "-" + stop.hubId;
    // A unique gate hub per stop OCCURRENCE: a hub revisited at two stops is two
    // distinct unload events, so the validator must rank them as distinct orders
    // (no earliest-occurrence collapse). For a route that visits each hub once
    // this is `"<hubId>#0"` everywhere it appears, equivalent to the bare hub id.
    const gateHubId = stop.hubId + "#" + String(k);
    route.push({ hubId: gateHubId, stopIndex: k });
    blocks.push({
      loadBlockId,
      key: {
        currentHubId: "origin",
        nextUnloadHubId: gateHubId,
        finalDestHubId: gateHubId,
        slaClass: "standard",
        deadlineBucket: 0,
        handlingClass: "standard",
        sizeWeightClass: "small",
      },
      packageIds: ["pkg-" + String(k)],
      packageCount: 1,
      // demand may be 0 for pure routing fixtures; LoadBlock needs positive
      // aggregates, so floor at 1 (the gate only relates depth ⇄ unload order).
      totalVolume: Math.max(1, stop.demand),
      totalWeight: Math.max(1, stop.demand),
      priority: 0,
    });
    slices.push({ depth: k, loadBlockIds: [loadBlockId] });
  });

  return { plan: { slices }, blocks, route };
}

/** Map the improved {@link Stop} sequence to {@link RoutedStop} ETAs (or `null` if infeasible). */
function deriveEtas(
  sequence: readonly Stop[],
  startHubId: string,
  travel: TravelModel,
  startMin: number,
): readonly RoutedStop[] | null {
  return feasibleArrivals(sequence, startHubId, travel, startMin);
}

/**
 * OPT-HOS-02 — the HARD HOS feasibility gate. Walks the ordered route's DRIVING
 * legs (each `prev → stop` linehaul) through the SAME Phase-10 `applyDrivingLeg`
 * engine the simulator uses (DRY — the optimizer owns NO HOS arithmetic of its
 * own), advancing the assigned driver's {@link HosClock} leg-by-leg. A leg the
 * driver CANNOT legally complete — the engine had to insert a 10h `rest`, a 34h
 * restart, or a `sleeper` split to make it legal — fails the gate.
 *
 * Mirrors the Phase-2 LIFO HARD gate: a SEPARATE boolean verdict, checked
 * independently of (and never folded into) any travel-cost objective (anti-P2). A
 * 30-min `break` segment is NOT a failure — it folds in as `serviceMin` via
 * `restMin` (rest-as-time), not an infeasibility (the leg is still completable).
 *
 * Pure + deterministic: the clock advances by integer minutes off the route's
 * `startMin` (sim/event time), never the wall clock; the leg start instant is
 * derived purely from `startMin + travelMin` accumulation. Returns `true` for an
 * empty route (a driver who drives no legs is trivially legal).
 *
 * @param sequence  The improved stop sequence (service order).
 * @param startHubId The route origin.
 * @param travel    The pure travel oracle.
 * @param startMin  The minute the trailer departs `startHubId` (sim/event time).
 * @param driver    The assigned-driver HOS context (clock + FMCSA config).
 */
function hosLegsFeasible(
  sequence: readonly Stop[],
  startHubId: string,
  travel: TravelModel,
  startMin: number,
  driver: DriverHosContext,
): boolean {
  const config: HosConfig = driver.config ?? DEFAULT_HOS_CONFIG;
  let clock: HosClock = driver.hosClock;
  let prevHubId = startHubId;
  let legStartMin = startMin;

  for (const stop of sequence) {
    const legMinutes = travel.travelMin(prevHubId, stop.hubId);
    if (legMinutes > 0) {
      const result = applyDrivingLeg(clock, config, legMinutes, epochMinutesToIso(legStartMin));
      // The leg is LEGAL with no relay iff the engine inserted no off-duty rest /
      // restart / sleeper split — a `break` (30-min) is allowed (rest-as-time).
      const requiresRest = result.segments.some(
        (s) => s.kind === "rest" || s.kind === "sleeper",
      );
      if (requiresRest) return false;
      clock = result.clock;
    }
    // Advance the leg-start clock by the FULL stop dwell (travel + service +
    // any folded rest), so the next leg starts at its true departure minute. The
    // 14h ABSOLUTE window keeps elapsing across the dwell (it does NOT pause).
    legStartMin += legMinutes + stop.serviceMin + (stop.restMin ?? 0);
    prevHubId = stop.hubId;
  }

  return true;
}

/**
 * Route one trailer end-to-end (see the module docstring). Returns the routed
 * sequence with ETAs, the utilization estimate, and the SEPARATE `feasible` flag
 * gated by the reused Phase-2 validator.
 */
export function routeTrailers(input: RouteTrailersInput): TrailerRoute {
  const { trailerId, capacity, stops, startHubId, travel } = input;
  const startMin = input.startMin ?? 0;
  const config = input.config ?? DEFAULT_PLANNER_CONFIG;

  // 1. CONSTRUCT a feasible route (cheapest insertion).
  const built = constructRoutes({ stops, capacity, startHubId, travel, startMin });

  // 2. IMPROVE it (2-opt/or-opt — never worsens, never violates).
  const improved = localSearch({
    sequence: built.sequence,
    startHubId,
    capacity,
    travel,
    startMin,
  });

  // 3. Derive ETAs + utilization.
  const etas = deriveEtas(improved.sequence, startHubId, travel, startMin);
  const demand = totalDemand(improved.sequence);
  const utilization = capacity > 0 ? Math.min(1, demand / capacity) : 0;

  // 4. GATE the load through the REUSED Phase-2 HARD validator (anti-P2: a
  //    separate gate, checked independently of the travel-cost objective).
  const { plan, blocks, route } = buildLoadForGate(improved.sequence);
  const loadFeasible = isFeasible(validatePlan(plan, blocks, route, config));

  // 5. OPT-HOS-02 — the HARD HOS gate (anti-P2: a SEPARATE verdict, run only when
  //    an assigned-driver HOS context is supplied; undefined otherwise so every
  //    pre-Phase-16 instance is byte-identical). Mirrors the Phase-2 LIFO gate.
  const hosFeasible: boolean | undefined =
    input.driver === undefined
      ? undefined
      : hosLegsFeasible(improved.sequence, startHubId, travel, startMin, input.driver);

  // Window+capacity feasibility (construction placed everything) AND ETAs verify
  // AND the reused LIFO gate passes AND (when present) the HOS gate passes. All
  // are SEPARATE hard checks ANDed into `feasible` (never folded into cost).
  const windowOk = built.feasible && etas !== null && demand <= capacity;

  const sequence: readonly RoutedStop[] =
    etas ?? improved.sequence.map((s) => ({ hubId: s.hubId, arrivalMin: startMin, departureMin: startMin }));

  return {
    trailerId,
    sequence,
    utilization,
    feasible: windowOk && loadFeasible && hosFeasible !== false,
    ...(hosFeasible === undefined ? {} : { hosFeasible }),
  };
}
