import type { RoutedStop, Stop, TravelModel } from "./types.js";

/**
 * `@mm/optimizer` — the SHARED VRPTW feasibility + cost predicates (OPT-03).
 *
 * The single source of the two pure functions both the construction heuristic
 * AND the local search build on (DRY — the REFACTOR target the plan calls for):
 *
 *  - {@link feasibleArrivals} — the WINDOW feasibility check + ETA derivation:
 *    walk a stop sequence from the trailer start, accumulate arrival/departure
 *    minutes (waiting when early), and return `null` the moment any stop would be
 *    serviced after its `windowEndMin`. Construction uses it to REJECT an
 *    infeasible insertion; local search uses it to REJECT an infeasible move.
 *  - {@link routeCost} — the TRAVEL-cost objective the local search monotonically
 *    never worsens: `Σ travelMin(start, seq[0]) + travelMin(seq[i], seq[i+1])`.
 *    Pure integer minutes; window WAITING is deliberately NOT folded in — waiting
 *    is a feasibility/ETA concern, the objective is travel only.
 *
 * Both are pure + deterministic: a function of `(sequence, startHubId, travel)`
 * only — no clock, no RNG, integer-minute arithmetic (anti-P3 / anti-P12).
 */

/**
 * Walk `sequence` from `startHubId` and derive each stop's arrival/departure
 * ETAs, OR return `null` if any stop's window is violated.
 *
 * Service may BEGIN no earlier than `windowStartMin` (arrive early ⇒ the trailer
 * waits, so `serviceStart = max(arrival, windowStartMin)`) and no later than
 * `windowEndMin` (`arrival > windowEndMin` ⇒ infeasible ⇒ `null`). Departure is
 * `serviceStart + serviceMin`; the next arrival is `departure + travel`.
 *
 * `startMin` is when the trailer leaves `startHubId` (default 0 — the epoch
 * origin). Determinism: a pure fold over the sequence; no clock, no RNG.
 */
export function feasibleArrivals(
  sequence: readonly Stop[],
  startHubId: string,
  travel: TravelModel,
  startMin = 0,
): readonly RoutedStop[] | null {
  const routed: RoutedStop[] = [];
  let prevHubId = startHubId;
  let clock = startMin;

  for (const stop of sequence) {
    const arrivalMin = clock + travel.travelMin(prevHubId, stop.hubId);
    // WINDOW HARD CHECK (anti-P2: feasibility first, never folded into cost):
    // arriving after the window closes can never be repaired by waiting. NOTE the
    // window is checked on ARRIVAL only, so an inserted rest (`restMin`) never
    // shifts when service may BEGIN — it only delays departure.
    if (arrivalMin > stop.windowEndMin) return null;
    const serviceStart = Math.max(arrivalMin, stop.windowStartMin);
    // OPT-HOS-02 + SP2 — fold the optional driver-rest / refuel minutes into the
    // service time ("rest-as-time", NO new graph edge kind). SP2 (spec §7): a
    // refuel co-located with a rest OVERLAPS it, so the added time is `max(restMin,
    // refuelMin)`, NOT the sum (no double-count); when only one applies, `max`
    // equals that one. Omitting both ⇒ 0, AND `max(restMin, 0) === restMin`, so
    // this is byte-identical to the pre-SP2 (HOS-only) departure fold.
    const departureMin =
      serviceStart + stop.serviceMin + Math.max(stop.restMin ?? 0, stop.refuelMin ?? 0);
    routed.push({ hubId: stop.hubId, arrivalMin, departureMin });
    prevHubId = stop.hubId;
    clock = departureMin;
  }

  return routed;
}

/**
 * The TRAVEL-cost objective of a sequence: total drive minutes from `startHubId`
 * through every stop in order. The quantity the local search strictly reduces
 * (never increases). Integer minutes; window waiting is NOT included.
 */
export function routeCost(
  sequence: readonly Stop[],
  startHubId: string,
  travel: TravelModel,
): number {
  let cost = 0;
  let prevHubId = startHubId;
  for (const stop of sequence) {
    cost += travel.travelMin(prevHubId, stop.hubId);
    prevHubId = stop.hubId;
  }
  return cost;
}

/**
 * The total integer freight demand a sequence loads onto the trailer. The
 * CAPACITY hard check is `totalDemand(seq) ≤ capacity` (anti-P2: a separate hard
 * gate, never folded into the travel cost).
 */
export function totalDemand(sequence: readonly Stop[]): number {
  let sum = 0;
  for (const stop of sequence) sum += stop.demand;
  return sum;
}
