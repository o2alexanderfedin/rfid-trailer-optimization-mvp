/**
 * `@mm/optimizer` — the VRPTW (OPT-03) CONTRACT.
 *
 * The strong-typed boundary the cheapest-insertion construction + 2-opt/or-opt
 * local search present to `routeTrailers` and to the rest of the optimizer.
 * Defining these shapes here — small, `readonly`, integer-minute valued — keeps
 * the whole router a PURE, DETERMINISTIC function of its inputs:
 *
 *  - No clock (`Date.now()`) and no RNG (`Math.random()`) anywhere in `src`, so
 *    a rolling epoch replays identically (PITFALLS P3) — every tie is broken
 *    LEXICOGRAPHICALLY by `hubId`, never randomly.
 *  - INTEGER minute arithmetic (anti-P12): travel/service/window values are
 *    whole minutes, so arrival/departure ETAs and the travel-cost objective
 *    never drift under float rounding.
 *  - FEASIBILITY is a SEPARATE boolean output, checked FIRST, never folded into
 *    the travel-cost objective (anti-P2): a window/capacity-violating route is
 *    rejected regardless of how cheap its travel is.
 *
 * VRPTW is explicitly NOT min-cost flow (its temporal constraints are NP-hard)
 * and NOT a MILP/OR-Tools solve (the locked research decision) — it is a pure-TS
 * construction heuristic + bounded local search.
 */

/**
 * A stop the trailer must service: a hub, the time it takes to service there,
 * the `[windowStart, windowEnd]` minutes during which service may BEGIN, and the
 * integer freight `demand` it adds to the trailer.
 *
 * All times are minutes from a fixed epoch (sim/event time — never the wall
 * clock). A stop is window-feasible at a given arrival ⟺ service can begin at or
 * after `windowStartMin` and NO LATER than `windowEndMin` (arriving early is
 * allowed — the trailer waits; arriving after `windowEndMin` is a violation).
 */
export interface Stop {
  /** The hub serviced at this stop — also the deterministic tie-break key. */
  readonly hubId: string;
  /** Service duration at the stop, whole minutes (≥ 0). */
  readonly serviceMin: number;
  /** Earliest minute service may BEGIN (arrive earlier ⇒ wait). */
  readonly windowStartMin: number;
  /** Latest minute service may BEGIN (arrive later ⇒ window violation). */
  readonly windowEndMin: number;
  /** Integer freight units this stop adds to the trailer (≥ 0). */
  readonly demand: number;
}

/**
 * A pure, deterministic travel-time oracle: `travelMin(from, to)` is the whole
 * minutes to drive between two hubs. It MUST be a function of its arguments only
 * (no clock, no RNG) and return a NON-NEGATIVE INTEGER, with `travelMin(x, x) =
 * 0`, so the router stays replay-safe and the travel-cost objective is integral.
 */
export interface TravelModel {
  /** Whole minutes to travel `fromHubId → toHubId` (≥ 0, 0 when equal). */
  travelMin(fromHubId: string, toHubId: string): number;
}

/**
 * A stop after routing: when the trailer ARRIVES at the hub and when it DEPARTS.
 *
 *  - `arrivalMin` — the minute the trailer reaches the hub (may be before the
 *    window opens; the trailer then waits).
 *  - `departureMin` — when it leaves: `max(arrivalMin, windowStartMin) +
 *    serviceMin`. So `departure − arrival` covers any wait plus the service.
 *
 * Both are whole minutes from the fixed epoch (anti-P12 integer ETAs).
 */
export interface RoutedStop {
  readonly hubId: string;
  /** Minute the trailer arrives at the hub. */
  readonly arrivalMin: number;
  /** Minute the trailer departs (after any wait + service). */
  readonly departureMin: number;
}

/**
 * The routing output for ONE trailer: the ordered {@link RoutedStop} sequence
 * with ETAs, a `utilization` estimate (`demand / capacity`, in `[0, 1]`), and
 * the SEPARATE `feasible` flag (anti-P2).
 *
 * `feasible` is `true` ⟺ every stop is serviced within its window, total demand
 * never exceeds capacity, AND the resulting trailer load passes the REUSED
 * Phase-2 `validatePlan` HARD gate (LIFO accessibility is never re-implemented
 * here — DRY). A window-, capacity-, or LIFO-infeasible route reports
 * `feasible: false`; its `sequence`/`utilization` are still returned for
 * inspection but the load must not be dispatched.
 */
export interface TrailerRoute {
  readonly trailerId: string;
  readonly sequence: readonly RoutedStop[];
  /** `totalDemand / capacity`, clamped to `[0, 1]`. */
  readonly utilization: number;
  /** Window + capacity + reused-LIFO HARD feasibility (separate from cost). */
  readonly feasible: boolean;
}

/**
 * An ordered candidate route under evaluation: the stop sequence plus the cached
 * total travel-minutes objective. Internal to construction + local search (the
 * objective the local search monotonically never worsens). `cost` is `Σ
 * travelMin(seq[i], seq[i+1])` over the sequence — integer minutes, NO window
 * waiting folded in (waiting is a feasibility/ETA concern, not the travel
 * objective the local search optimizes).
 */
export interface CandidateRoute {
  readonly sequence: readonly Stop[];
  /** Total travel minutes over the sequence (the local-search objective). */
  readonly cost: number;
}
