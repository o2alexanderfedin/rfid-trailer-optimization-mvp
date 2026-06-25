import type { FeasibilityResult, LoadPlan, Violation } from "@mm/load-planner";
import { scorePlan } from "@mm/load-planner";
import type { LoadBlock, PlannerConfig, RouteStop, TimingConfig, TrailerSlice } from "@mm/domain";
import {
  applyDrivingLeg,
  DEFAULT_FUEL_CONFIG,
  DEFAULT_HOS_CONFIG,
  DEFAULT_PLANNER_CONFIG,
  DEFAULT_TIMING_CONFIG,
  epochMinutesToIso,
  expectedDwellMinutes,
  type FuelConfig,
  type HosClock,
  type HosConfig,
  remainingLegalDriveMinutes,
} from "@mm/domain";

import { objective, objectiveBreakdown } from "../objective/objective.js";
import { selectPlan } from "../objective/select-plan.js";
import type { Candidate, ObjectiveWeights, PlanMetrics } from "../objective/types.js";
import { localRepair } from "../repair/local-repair.js";
import type { HosInfeasibleLeg, RepairScope } from "../repair/local-repair.js";
import { routeTrailers } from "../vrptw/route-trailers.js";
import type { DriverHosContext, Stop, TravelModel } from "../vrptw/types.js";
import { assignFreightForEpoch } from "../flow/freight-stage.js";
import { detectAffectedScope } from "./scope.js";
import { buildTwin } from "./twin.js";
import { isFrozen, scopeHash } from "./freeze-idempotency.js";
import type {
  Epoch,
  EpochInput,
  EpochRepairRec,
  EpochRecommendation,
  EpochResult,
  TwinBlock,
  TwinRoute,
  TwinSnapshot,
  TwinTrailer,
} from "./types.js";

/**
 * `@mm/optimizer` — `runEpoch`: the PURE rolling-horizon epoch core
 * (OPT-04/05/06).
 *
 * It is a deterministic FUNCTION — data in (`epoch`, `input`, `weights`), data
 * out (`EpochResult`). It performs NO IO, reads NO clock (`Date.now`), draws NO
 * RNG (`Math.random`): the only stateful, side-effecting part is the `@mm/api`
 * `RollingOptimizerService` shell that calls it and persists its payloads. So two
 * calls with identical inputs return a DEEP-EQUAL result (the OPT-06 keystone).
 *
 * The pipeline (a readable, linear composition of the Wave-2 algorithms):
 *
 *   detectAffectedScope(events)        // OPT-05: scope to the affected slice only
 *     → buildTwin(scope, snapshot)     // OPT-04: a structuredClone sandbox
 *       → for each in-scope trailer:
 *            isFrozen?                  // OPT-06: skip near-departure trailers
 *            routeTrailers(...)         // VRPTW route + REUSED validatePlan gate
 *            objective(metrics)         // §12 weighted score (feasibility SEPARATE)
 *       → selectPlan(candidates)        // feasibility-gated, deterministic winner
 *       → PlanGenerated + (maybe) PlanAccepted payloads
 *
 * Feasibility (the Phase-2 `validatePlan` HARD gate, surfaced by `routeTrailers`)
 * stays a SEPARATE output from the objective (anti-P2): a candidate's `feasible`
 * flag and its `objectiveCost` never collapse into one value, and `selectPlan`
 * gates on feasibility FIRST.
 */

/** A pure travel oracle over the twin's route legs (symmetric, integer minutes). */
function buildTravelModel(routes: readonly TwinRoute[]): TravelModel {
  const leg = new Map<string, number>();
  for (const r of routes) {
    const minutes = toNonNegIntMinutes(r.travelMin);
    // Both directions — the VRPTW oracle must answer either orientation.
    leg.set(`${r.fromHubId} ${r.toHubId}`, minutes);
    leg.set(`${r.toHubId} ${r.fromHubId}`, minutes);
  }
  return {
    travelMin(fromHubId: string, toHubId: string): number {
      if (fromHubId === toHubId) return 0;
      return leg.get(`${fromHubId} ${toHubId}`) ?? 0;
    },
  };
}

/** Round a (possibly fractional) minute estimate to a non-negative integer (anti-P12). */
function toNonNegIntMinutes(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
}

/**
 * SP2 (spec §7) — build the per-directed-leg DISTANCE oracle (miles) the fuel-aware
 * `stopsForTrailer` walk reads, keyed `from->to` (both orientations, like the
 * travel oracle). A route with no `distanceMiles` contributes nothing (omitted),
 * so a pre-SP2 twin (no distances) never triggers a refuel — byte-identical.
 */
function buildDistanceModel(routes: readonly TwinRoute[]): ReadonlyMap<string, number> {
  const leg = new Map<string, number>();
  for (const r of routes) {
    if (r.distanceMiles === undefined) continue;
    const miles = r.distanceMiles < 0 ? 0 : r.distanceMiles;
    leg.set(`${r.fromHubId}->${r.toHubId}`, miles);
    leg.set(`${r.toHubId}->${r.fromHubId}`, miles);
  }
  return leg;
}

/**
 * The deterministic role-based dwell SERVICE TIME (whole minutes) for a hub
 * (OPT-09 / TIME-02 parity): the log-normal MEAN of the role's dwell
 * distribution via {@link expectedDwellMinutes}, integer-rounded for the
 * VRPTW's integer-minute ETA arithmetic (anti-P12). A stop at the network
 * CENTER hub draws the longer dwellCenter; every other (spoke) hub draws
 * dwellSpoke. Pure: a function of the hub role + config only.
 */
function dwellServiceMin(
  hubId: string,
  centerHubId: string,
  timing: TimingConfig,
): number {
  const role = hubId === centerHubId ? "center" : "spoke";
  return toNonNegIntMinutes(expectedDwellMinutes(role, timing));
}

/**
 * SP2 (spec §7) — the PURE refuel-threshold helper. Given the miles accrued
 * BEFORE a leg, the leg's road distance, and the fuel config, decide whether the
 * trailer refuels at the stop the leg ENDS at: it refuels iff the cumulative
 * `milesBefore + legDistanceMiles` reaches (≥) `refuelThresholdMiles`. On a refuel
 * the running total RESETS to 0 (a full tank); otherwise it carries the new
 * cumulative forward. A disabled (or absent-`enabled`) fuel config NEVER refuels
 * (refuelMin 0). `refuelMin` is integer-rounded at the boundary (anti-P12).
 *
 * Pure + deterministic: a function of its three numeric/config args only.
 */
export function refuelMinForStop(args: {
  milesBefore: number;
  legDistanceMiles: number;
  fuel: FuelConfig;
}): { refuelMin: number; milesAfter: number } {
  const { milesBefore, legDistanceMiles, fuel } = args;
  const cumulative = milesBefore + Math.max(0, legDistanceMiles);
  if (fuel.enabled === true && cumulative >= fuel.refuelThresholdMiles) {
    return { refuelMin: toNonNegIntMinutes(fuel.refuelTimeMinutes), milesAfter: 0 };
  }
  return { refuelMin: 0, milesAfter: cumulative };
}

/** Map a trailer's blocks to VRPTW stops (one stop per next-unload hub, summed demand). */
export function stopsForTrailer(
  trailer: TwinTrailer,
  centerHubId: string,
  timing: TimingConfig,
  /**
   * SP2 (spec §7) — OPTIONAL fuel config. When present AND `enabled`, the walk
   * assigns `Stop.refuelMin` at the route stop where the running distance (seeded
   * from `trailer.milesSinceRefuel`) crosses `refuelThresholdMiles`. Absent OR
   * disabled ⇒ no `refuelMin` is set (back-compat, byte-identical).
   */
  fuel?: FuelConfig,
  /**
   * SP2 — per-directed-leg road distance in miles, keyed `from->to`. The walk uses
   * it to accumulate distance from `currentHubId` through the ordered route. Absent
   * legs contribute 0, so no refuel triggers without distances.
   */
  distanceMiles?: ReadonlyMap<string, number>,
): readonly Stop[] {
  // Sum block volume per unload hub; service/window from the trailer's route order.
  const demandByHub = new Map<string, number>();
  for (const b of trailer.blocks) {
    demandByHub.set(b.nextUnloadHubId, (demandByHub.get(b.nextUnloadHubId) ?? 0) + b.volume);
  }

  const orderedRoute = [...trailer.route].sort((a, b) => a.stopIndex - b.stopIndex);
  const routeHubs = new Set(orderedRoute.map((s) => s.hubId));

  // SP2 fuel-aware walk: accumulate the running distance from the trailer's current
  // miles-since-refuel, leg by leg in route order, assigning `refuelMin` at the
  // stop where it crosses the threshold (then resetting). Off (no fuel/distance) ⇒
  // every stop's `refuelMin` is 0 (omitted), byte-identical to the prior plan.
  const fuelCfg = fuel ?? DEFAULT_FUEL_CONFIG;
  const fuelOn = fuelCfg.enabled === true && distanceMiles !== undefined;
  const refuelByHubIndex = new Map<number, number>();
  if (fuelOn) {
    let running = Math.max(0, trailer.milesSinceRefuel ?? 0);
    let prevHubId = trailer.currentHubId;
    orderedRoute.forEach((stop, idx) => {
      const legMiles = distanceMiles.get(`${prevHubId}->${stop.hubId}`) ?? 0;
      const { refuelMin, milesAfter } = refuelMinForStop({
        milesBefore: running,
        legDistanceMiles: legMiles,
        fuel: fuelCfg,
      });
      if (refuelMin > 0) refuelByHubIndex.set(idx, refuelMin);
      running = milesAfter;
      prevHubId = stop.hubId;
    });
  }

  const stops: Stop[] = orderedRoute.map((stop, idx) => {
    const refuelMin = refuelByHubIndex.get(idx) ?? 0;
    return {
      hubId: stop.hubId,
      // OPT-09 / TIME-02 parity: exactly ONE role-based dwell per stop (center
      // at the network center hub, spoke elsewhere) as the VRPTW service time.
      serviceMin: dwellServiceMin(stop.hubId, centerHubId, timing),
      windowStartMin: 0,
      // A wide window so routing is window-feasible (the freeze window — not the
      // service window — is what protects near-departure trailers here).
      windowEndMin: Number.MAX_SAFE_INTEGER,
      demand: demandByHub.get(stop.hubId) ?? 0,
      // SP2: only set `refuelMin` when a refuel falls here (omit 0 so an off run is
      // byte-identical — an absent field and `0` both fold via `?? 0`).
      ...(refuelMin > 0 ? { refuelMin } : {}),
    };
  });

  // FIX 1 — capacity gate bypass: a block whose unload hub is NOT on the trailer's
  // route would otherwise have its volume silently dropped from the demand, so the
  // capacity check could be evaded (a trailer loaded beyond capacity passing the
  // gate). Surface every off-route hub as its own stop carrying its block volume,
  // so ALL assigned-block volume counts toward `totalDemand` (the capacity gate is
  // never under-counted). Sorted by hubId for deterministic output (anti-P3).
  const offRouteHubs = [...demandByHub.keys()]
    .filter((hubId) => !routeHubs.has(hubId))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const hubId of offRouteHubs) {
    stops.push({
      hubId,
      serviceMin: dwellServiceMin(hubId, centerHubId, timing),
      windowStartMin: 0,
      windowEndMin: Number.MAX_SAFE_INTEGER,
      demand: demandByHub.get(hubId) ?? 0,
    });
  }

  return stops;
}

/** Total route miles ≈ Σ travelMin over the trailer's stop sequence (integer minutes proxy). */
function routeMiles(
  startHubId: string,
  sequence: readonly { readonly hubId: string }[],
  travel: TravelModel,
): number {
  let miles = 0;
  let prev = startHubId;
  for (const s of sequence) {
    miles += travel.travelMin(prev, s.hubId);
    prev = s.hubId;
  }
  return miles;
}

// ---------------------------------------------------------------------------
// Synthetic LoadPlan/LoadBlock builders (FIX 2 — real rehandleScore via scorePlan)
// ---------------------------------------------------------------------------

/**
 * Convert a `TwinBlock` to a minimal `LoadBlock` for the Phase-2 `scorePlan`
 * gate. Only the fields `scorePlan` actually reads are populated: `loadBlockId`,
 * `key.nextUnloadHubId`, and `totalVolume`. Remaining fields are plausible
 * placeholders that keep the Zod schema valid.
 *
 * Pure + deterministic: same input ⇒ same output.
 */
function twinBlockToLoadBlock(b: TwinBlock): LoadBlock {
  return {
    loadBlockId: b.blockId,
    key: {
      // Required by scorePlan's rehandleBreakdown: nextUnloadHubId + handlingClass.
      // The other fields are synthetic placeholders (scorePlan ignores them).
      currentHubId: "SYNTHETIC",
      nextUnloadHubId: b.nextUnloadHubId,
      finalDestHubId: b.nextUnloadHubId,
      slaClass: "standard",
      deadlineBucket: 0,
      handlingClass: "standard",
      sizeWeightClass: "medium",
    },
    packageIds: [b.blockId], // synthetic — scorePlan does not inspect package ids
    packageCount: 1,
    totalVolume: b.volume,
    totalWeight: b.volume, // proxy (volume=weight in integer units for demo)
    priority: 0,
  };
}

/**
 * Build a synthetic `RouteStop[]` from the twin's stop list. `stopIndex` is the
 * canonical unload order — lower = earlier unload = closer to the rear (depth 0).
 */
function twinRouteToStops(trailer: TwinTrailer): RouteStop[] {
  // Include the current hub as stop 0 if not already in the route (some trailers
  // list only their REMAINING stops). Sort by stopIndex for determinism.
  const stops: RouteStop[] = [...trailer.route]
    .sort((a, b) => a.stopIndex - b.stopIndex)
    .map((s) => ({ hubId: s.hubId, stopIndex: s.stopIndex }));
  return stops;
}

/**
 * Synthesise a `LoadPlan` from the twin's block + stop data for rehandle scoring.
 *
 * The twin's `blocks` array is treated as an ORDERED sequence: block[0] sits at
 * depth 0 (rear door), block[1] at depth 1, and so on. This mirrors the order in
 * which the operational twin records block assignments (the projection upserts
 * blocks in event-arrival order). `scorePlan` then detects any block that sits
 * at a lower depth than a later-unload block in front of it and scores the cost.
 *
 * Each block occupies one dedicated depth slice (one block per slice, integer
 * volume). This is the minimal slice model that lets `scorePlan` observe the
 * LIFO order without requiring the full Phase-2 plan data.
 */
function twinToLoadPlan(trailer: TwinTrailer, loadBlocks: readonly LoadBlock[]): LoadPlan {
  const orderByHub = new Map(trailer.route.map((s) => [s.hubId, s.stopIndex]));
  const latestOrder = trailer.route.length; // fallback for off-route blocks

  const sliceCapacity = trailer.capacity > 0 ? trailer.capacity : 1;

  const slices: TrailerSlice[] = trailer.blocks.map((b, depth) => {
    const lb = loadBlocks[depth];
    const usedVol = b.volume;
    // The slice capacity must be ≥ usedVolume for the Zod schema (LOAD-01).
    // We use the full trailer capacity per slice so no single slice is over-filled.
    return {
      depth,
      capacityVolume: sliceCapacity,
      capacityWeight: sliceCapacity,
      usedVolume: usedVol,
      usedWeight: usedVol, // proxy
      loadBlockIds: lb !== undefined ? [lb.loadBlockId] : [],
    };
  });

  const placements = trailer.blocks.map((b, depth) => {
    const unloadOrder = orderByHub.get(b.nextUnloadHubId) ?? latestOrder;
    return { loadBlockId: b.blockId, depth, unloadOrder };
  });

  return {
    trailerId: trailer.trailerId,
    slices,
    placements,
  };
}

/**
 * Compute the real rehandleScore for this trailer's current block arrangement by
 * running the REUSED Phase-2 `scorePlan` gate over a synthetic `LoadPlan` built
 * from the twin data (FIX 2 — was hardcoded 0). Pure + deterministic.
 */
function rehandleScoreFor(trailer: TwinTrailer, config: PlannerConfig): number {
  if (trailer.blocks.length === 0) return 0;
  const loadBlocks = trailer.blocks.map(twinBlockToLoadBlock);
  const route = twinRouteToStops(trailer);
  const plan = twinToLoadPlan(trailer, loadBlocks);
  return scorePlan(plan, loadBlocks, route, config).rehandleScore;
}

/**
 * OPT-HOS-01 — the SOFT driver-rest penalty for a trailer (Phase 15). A driver
 * with FEWER remaining legal drive minutes is soft-penalized: the penalty is
 * `max(0, maxDriveMin − remainingDriveMinutes)`, bounded by the FMCSA 11h drive
 * ceiling (`DEFAULT_HOS_CONFIG.maxDriveMin`), so a fully-rested driver (remaining
 * = 660) ⇒ penalty 0 and a depleted driver (remaining = 0) ⇒ penalty 660. The
 * remaining minutes are read DETERMINISTICALLY off the Phase-13 `driver_status`
 * projection via `trailer.driver` (NEVER recomputed off the clock); the value is
 * clamped non-negative and rounded to a whole minute (anti-P12).
 *
 * Returns 0 when the trailer has no driver bound — so a driverless twin (every
 * pre-Phase-15 snapshot) reproduces the prior `restPenalty: 0` exactly. With the
 * default `restCost = 0` weight this whole term is a no-op (byte-identical plans).
 */
function restPenaltyFor(trailer: TwinTrailer): number {
  if (trailer.driver === undefined) return 0;
  const remaining = toNonNegIntMinutes(trailer.driver.remainingDriveMinutes);
  return Math.max(0, DEFAULT_HOS_CONFIG.maxDriveMin - remaining);
}

/**
 * OPT-HOS-02 — build the {@link DriverHosContext} that ACTIVATES the hard HOS
 * gate in `routeTrailers`, or `undefined` when the trailer has no driver OR the
 * driver carries no full `hosClock` (the Phase-15 soft-only case — the gate stays
 * off so prior verdicts reproduce byte-identically).
 */
function driverHosContextFor(trailer: TwinTrailer): DriverHosContext | undefined {
  const driver = trailer.driver;
  if (driver === undefined || driver.hosClock === undefined) return undefined;
  return driver.hosConfig === undefined
    ? { driverId: driver.driverId, hosClock: driver.hosClock }
    : { driverId: driver.driverId, hosClock: driver.hosClock, config: driver.hosConfig };
}

/**
 * OPT-HOS-03 — find the FIRST driving leg of the trailer's ordered route the
 * assigned driver cannot legally complete, walking the SAME Phase-10 engine the
 * hard gate uses (DRY). Returns the {@link HosInfeasibleLeg} (driver + leg + why)
 * for `localRepair`, or `undefined` if every leg is legal. Pure + deterministic:
 * the clock advances by integer minutes off the trailer's `departureMin`.
 *
 * The route is read in `stopIndex` order; each `prev → stop` linehaul whose
 * travel minutes the engine cannot satisfy without inserting a rest/sleeper is
 * the offending leg. Reuses {@link remainingLegalDriveMinutes} for the "why".
 */
function firstHosInfeasibleLeg(
  trailer: TwinTrailer,
  travel: TravelModel,
  driverCtx: DriverHosContext,
): HosInfeasibleLeg | undefined {
  const config: HosConfig = driverCtx.config ?? DEFAULT_HOS_CONFIG;
  let clock: HosClock = driverCtx.hosClock;
  let prevHubId = trailer.currentHubId;
  let legStartMin = trailer.departureMin;

  const ordered = [...trailer.route].sort((a, b) => a.stopIndex - b.stopIndex);
  for (const stop of ordered) {
    const legMinutes = travel.travelMin(prevHubId, stop.hubId);
    if (legMinutes > 0) {
      const result = applyDrivingLeg(clock, config, legMinutes, epochMinutesToIso(legStartMin));
      const requiresRest = result.segments.some(
        (s) => s.kind === "rest" || s.kind === "sleeper",
      );
      if (requiresRest) {
        return {
          driverId: driverCtx.driverId,
          legFromHubId: prevHubId,
          legToHubId: stop.hubId,
          legMinutes,
          remainingDriveMinutes: remainingLegalDriveMinutes(clock, config, legStartMin),
        };
      }
      clock = result.clock;
    }
    legStartMin += legMinutes;
    prevHubId = stop.hubId;
  }
  return undefined;
}

/** Build the pure §12 metrics bag for a routed trailer (deterministic, integer-sourced). */
function metricsFor(
  trailer: TwinTrailer,
  miles: number,
  utilization: number,
  config: PlannerConfig,
): PlanMetrics {
  return {
    miles,
    driverTimeMin: miles, // 1:1 proxy — driver minutes ≈ travel minutes (demo).
    fuelUnits: miles,
    dockWaitMin: 0,
    handlingOps: trailer.blocks.length,
    // FIX 2: real rehandleScore from Phase-2 scorePlan (was hardcoded 0).
    rehandleScore: rehandleScoreFor(trailer, config),
    slaLatenessMin: 0,
    utilization,
    overCarryUnits: 0,
    imbalance: 0,
    // Churn anchored to 0 — a fresh epoch has no prior plan to diverge from in the
    // pure core; the shell folds in cross-epoch churn when it has the prior plan.
    churnVsPrevious: 0,
    // OPT-HOS-01 — the SOFT driver-rest penalty (0 when no driver / fully rested).
    // Weighted by the default-0 `restCost`, so neutral until an operator raises it.
    restPenalty: restPenaltyFor(trailer),
  };
}

/**
 * Build a `RepairScope` for `localRepair` from this trailer's twin data (FIX 1).
 * The slices + route are derived the same way as `twinToLoadPlan` so the repair
 * runs over an identical view of the layout.
 */
function repairScopeFor(
  trailer: TwinTrailer,
  planId: string,
  metrics: PlanMetrics,
  weights: ObjectiveWeights,
  config: PlannerConfig,
  hosInfeasible?: HosInfeasibleLeg,
): RepairScope {
  const loadBlocks = trailer.blocks.map(twinBlockToLoadBlock);
  const route = twinRouteToStops(trailer);
  // RepairSlice is {depth, loadBlockIds[]} — same synthetic one-block-per-depth layout.
  const slices = trailer.blocks.map((b, depth) => ({
    depth,
    loadBlockIds: [b.blockId],
  }));
  return {
    planId,
    slices,
    blocks: loadBlocks,
    route,
    config,
    weights,
    baseMetrics: metrics,
    // OPT-HOS-03 — present only when the HARD HOS gate rejected a leg; drives the
    // insertRest/relay recommendations. Omitted ⇒ LIFO-only repair (back-compat).
    ...(hosInfeasible === undefined ? {} : { hosInfeasible }),
  };
}

/** One trailer's evaluated candidate (frozen trailers are excluded from selection). */
interface TrailerEvaluation {
  readonly candidate: Candidate;
  readonly recommendation: EpochRecommendation;
}

/** Deterministic plan id for a trailer in this epoch (no RNG). */
function planIdFor(epochId: string, scope: string, trailerId: string): string {
  return `${epochId}:${scope.slice(0, 12)}:${trailerId}`;
}

/**
 * Lift a `routeTrailers` boolean verdict into the Phase-2 `FeasibilityResult`
 * shape (`isFeasible` ⟺ `hardViolations` empty). An infeasible route carries one
 * HARD accessibility violation so the gate (and any downstream audit) reads true.
 */
function feasibilityOf(trailerId: string, feasible: boolean): FeasibilityResult {
  if (feasible) return { hardViolations: [], softViolations: [] };
  const violation: Violation = {
    loadBlockId: trailerId,
    kind: "accessibility",
    blockerCount: 1,
    severity: "HARD",
    detail: "trailer route is window/capacity/LIFO infeasible",
  };
  return { hardViolations: [violation], softViolations: [] };
}

/**
 * Run one rolling epoch over the twin. Returns the candidate `PlanGenerated`
 * payload, the `PlanAccepted` payload IF a feasible plan is selected (the shell
 * commits it), the idempotency `scopeHash`, and per-trailer recommendations.
 */
export function runEpoch(
  epoch: Epoch,
  input: EpochInput,
  weights: ObjectiveWeights,
): EpochResult {
  const scope = detectAffectedScope(input.events, epoch);
  const hash = scopeHash(scope, input.twinSnapshot);

  // Empty scope ⇒ nothing affected ⇒ no plan (and no recommendations). The
  // freight stage is still reported fail-soft (feasible, no assignments) so the
  // optional field is always present (no undefined-vs-empty drift for consumers).
  if (scope.trailerIds.length === 0) {
    return {
      epochId: epoch.epochId,
      scopeHash: hash,
      generated: null,
      accepted: null,
      recommendations: [],
      freightAssignment: { assignments: [], flowCost: 0, feasible: true },
    };
  }

  const twin: TwinSnapshot = buildTwin(scope, input.twinSnapshot);
  const travel = buildTravelModel(twin.routes);

  // OPT-09 / OPT-10 — the SHARED realistic time model the optimizer plans against:
  //  - `timing` is the single TimingConfig (defaults to DEFAULT_TIMING_CONFIG) the
  //    role-based dwell estimate is drawn from (`expectedDwellMinutes`).
  //  - the network CENTER hub is read from the FULL source snapshot (the twin's
  //    filtered hub slice may exclude the center); it defaults to `hubs[0]` — the
  //    same hub-and-spoke convention the simulator uses (`const center = hubs[0]`).
  const timing = input.timing ?? DEFAULT_TIMING_CONFIG;
  const centerHubId =
    input.twinSnapshot.centerHubId ?? input.twinSnapshot.hubs[0] ?? "";

  // SP2 (spec §7) — the fuel config + the per-directed-leg DISTANCE oracle the
  // fuel-aware `stopsForTrailer` walk reads. Default disabled ⇒ no refuel assigned
  // ⇒ byte-identical to the pre-SP2 plan. The distance map is built ONCE from the
  // (in-scope) twin routes (both directions, like the travel oracle), keyed
  // `from->to` to mirror `refuelMinForStop`'s leg-key convention.
  const fuelConfig = input.fuelConfig ?? DEFAULT_FUEL_CONFIG;
  const distanceMilesByLeg = buildDistanceModel(twin.routes);

  // F-06 / OPT-02 — run the min-cost-flow freight stage over the IN-SCOPE twin
  // (assign-then-sequence): which freight block flows over which route leg at
  // minimum total cost. PURE + fail-soft; observational only — it does NOT feed
  // selectPlan, so the deterministic winner is unchanged (anti-thrash).
  const freight = assignFreightForEpoch(twin, epoch);

  const evaluations: TrailerEvaluation[] = [];
  const frozenRecs: EpochRecommendation[] = [];

  for (const trailer of twin.trailers) {
    const planId = planIdFor(epoch.epochId, hash, trailer.trailerId);

    if (isFrozen(trailer.departureMin, epoch)) {
      // OPT-06: a near-departure trailer is FROZEN — left untouched this epoch.
      frozenRecs.push({
        trailerId: trailer.trailerId,
        planId,
        feasible: false,
        objectiveCost: 0,
        breakdown: objectiveBreakdown(metricsFor(trailer, 0, 0, DEFAULT_PLANNER_CONFIG), weights),
        frozen: true,
      });
      continue;
    }

    // OPT-HOS-02 — supply the assigned driver's HOS context to ACTIVATE the hard
    // gate (only when a full `hosClock` is present; soft-only drivers leave it off).
    const driverCtx = driverHosContextFor(trailer);
    const route = routeTrailers({
      trailerId: trailer.trailerId,
      capacity: trailer.capacity,
      stops: stopsForTrailer(trailer, centerHubId, timing, fuelConfig, distanceMilesByLeg),
      startHubId: trailer.currentHubId,
      travel,
      startMin: trailer.departureMin,
      ...(driverCtx === undefined ? {} : { driver: driverCtx }),
    });
    const miles = routeMiles(trailer.currentHubId, route.sequence, travel);
    const metrics = metricsFor(trailer, miles, route.utilization, DEFAULT_PLANNER_CONFIG);
    const breakdown = objectiveBreakdown(metrics, weights);
    const feasibility = feasibilityOf(trailer.trailerId, route.feasible);

    // OPT-HOS-03 — when the HARD HOS gate rejected the route, locate the offending
    // leg so localRepair surfaces an explainable insertRest/relay recovery.
    const hosLeg =
      driverCtx !== undefined && route.hosFeasible === false
        ? firstHosInfeasibleLeg(trailer, travel, driverCtx)
        : undefined;

    // FIX 1 (OPT-07) + OPT-HOS-03: for INFEASIBLE trailers, run localRepair to
    // surface ranked split/reassign/hold/over-carry (LIFO) AND insertRest/relay
    // (HOS) recommendations on the live path. A trailer infeasible ONLY for HOS
    // (no load blocks) still recovers via the HOS leg — never crashes the epoch.
    let repairRecommendations: readonly EpochRepairRec[] | undefined;
    if (!route.feasible && (trailer.blocks.length > 0 || hosLeg !== undefined)) {
      const scope = repairScopeFor(trailer, planId, metrics, weights, DEFAULT_PLANNER_CONFIG, hosLeg);
      const recs = localRepair(scope);
      if (recs.length > 0) {
        repairRecommendations = recs.map((r): EpochRepairRec => ({
          kind: r.kind,
          rationale: r.rationale,
          feasible: r.feasibility.hardViolations.length === 0,
        }));
      }
    }

    const recommendation: EpochRecommendation =
      repairRecommendations !== undefined
        ? {
            trailerId: trailer.trailerId,
            planId,
            feasible: route.feasible,
            objectiveCost: breakdown.total,
            breakdown,
            frozen: false,
            repairRecommendations,
          }
        : {
            trailerId: trailer.trailerId,
            planId,
            feasible: route.feasible,
            objectiveCost: breakdown.total,
            breakdown,
            frozen: false,
          };

    evaluations.push({
      candidate: { planId, metrics, feasibility },
      recommendation,
    });
  }

  // selectPlan: HARD-feasibility gate FIRST, then minimum objective, deterministic
  // planId tie-break (anti-P7). Feasibility never folds into the score (anti-P2).
  const winner = selectPlan(
    evaluations.map((e) => e.candidate),
    weights,
  );

  // Recommendations are sorted by trailerId for stable, byte-identical output.
  const recommendations = [...frozenRecs, ...evaluations.map((e) => e.recommendation)].sort(
    (a, b) => (a.trailerId < b.trailerId ? -1 : a.trailerId > b.trailerId ? 1 : 0),
  );

  if (winner === null) {
    // No feasible candidate — still record an observational PlanGenerated for the
    // best-by-objective trailer (if any non-frozen candidate exists), accepted=null.
    const best = pickBestByObjective(evaluations, weights);
    return {
      epochId: epoch.epochId,
      scopeHash: hash,
      generated: best === null ? null : generatedPayload(epoch, hash, best, false),
      accepted: null,
      recommendations,
      freightAssignment: freight,
    };
  }

  const winnerEval = evaluations.find((e) => e.candidate.planId === winner.planId)!;
  const generated = generatedPayload(epoch, hash, winnerEval, true);

  return {
    epochId: epoch.epochId,
    scopeHash: hash,
    generated,
    // The ONE side effect (deferred to the shell): accept the feasible winner.
    accepted: {
      epochId: epoch.epochId,
      scopeHash: hash,
      planId: generated.planId,
      trailerId: generated.trailerId,
      occurredAt: epochClock(epoch),
    },
    recommendations,
    freightAssignment: freight,
  };
}

/** The lowest-objective non-frozen candidate (used when none is feasible). */
function pickBestByObjective(
  evaluations: readonly TrailerEvaluation[],
  weights: ObjectiveWeights,
): TrailerEvaluation | null {
  let best: TrailerEvaluation | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const e of evaluations) {
    const cost = objective(e.candidate.metrics, weights);
    if (cost < bestCost || (cost === bestCost && best !== null && e.candidate.planId < best.candidate.planId)) {
      best = e;
      bestCost = cost;
    }
  }
  return best;
}

/** Build the `PlanGenerated` payload (observational candidate record). */
function generatedPayload(
  epoch: Epoch,
  hash: string,
  evaluation: TrailerEvaluation,
  feasible: boolean,
): {
  readonly epochId: string;
  readonly scopeHash: string;
  readonly planId: string;
  readonly trailerId: string;
  readonly objectiveCost: number;
  readonly feasible: boolean;
  readonly occurredAt: string;
} {
  return {
    epochId: epoch.epochId,
    scopeHash: hash,
    planId: evaluation.candidate.planId,
    trailerId: evaluation.recommendation.trailerId,
    objectiveCost: evaluation.recommendation.objectiveCost,
    feasible,
    occurredAt: epochClock(epoch),
  };
}

/**
 * A deterministic ISO timestamp derived PURELY from the epoch's `nowMin` (minutes
 * from the Unix epoch) — a function of the sim/event clock, NEVER `Date.now()`. So
 * the same epoch always stamps the same `occurredAt` (idempotency-safe).
 */
function epochClock(epoch: Epoch): string {
  return new Date(epoch.nowMin * 60_000).toISOString();
}
