import {
  applyDrivingLeg,
  type FuelConfig,
  type HosClock,
  type HosConfig,
  mayDriveNow,
  remainingLegalDriveMinutes,
} from "@mm/domain";

import type { AgentObservation } from "./observe.js";
import type { HubObservation } from "./hub.js";

/**
 * OODA-03 — the PURE BINDING-FEASIBILITY predicates that the truck/hub Decide
 * gate every outcome through. These are THIN ADAPTERS that DELEGATE to the
 * already-tested shared engines — they do NOT reimplement HOS/fuel/dock math:
 *
 *  - HOS feasibility REUSES the `@mm/domain` forward-labeling engine
 *    (`mayDriveNow` / `remainingLegalDriveMinutes` / `applyDrivingLeg`) — the
 *    SAME functions the simulator advances driver state with and the optimizer
 *    checks rest-as-time feasibility with (DRY: one HOS engine, no second copy
 *    that could drift at the 1-ULP / clock boundary).
 *  - Fuel feasibility REUSES the engine's odometer-threshold rule
 *    (`odometerMiles >= refuelThresholdMiles`) over the SAME `FuelConfig` the
 *    engine reads — not a new threshold.
 *  - Dock/consolidation feasibility REUSES the hub observation's
 *    dock-availability + manifest fields the engine's consolidation/dock rule
 *    produces.
 *
 * The predicates only ASSEMBLE those delegated results into a closed verdict; an
 * agent then short-circuits to the binding outcome (rest/refuel/hold) BEFORE any
 * proceed/divert/dispatch branch, so an infeasible action is structurally
 * UNREACHABLE — the contract a P25 coordinator's `ActionSuggested` cannot
 * override (if the agent deems it infeasible, the action never leaves the agent).
 *
 * PURITY (DET-03): every input is the FROZEN observation (integer/string only)
 * plus the injected `HosConfig`/`FuelConfig`. `now` is the observation's
 * virtual-clock epoch-minute, never `Date.now()`. No `Math.random`. Identical
 * inputs ⇒ identical verdict.
 */

/**
 * The minimal slice of {@link import("@mm/domain").FuelConfig} the fuel-feasibility
 * predicate needs: the SAME `refuelThresholdMiles` rule the engine applies. Kept as
 * a `Pick` of the domain type (no new config shape — DRY) so a caller passes the
 * exact `FuelConfig` the simulator/optimizer already carry.
 */
export type FuelFeasibilityConfig = Pick<FuelConfig, "refuelThresholdMiles">;

/**
 * The CLOSED truck-leg feasibility verdict. Each flag is derived ENTIRELY by
 * delegating to a shared engine; the agent reads it as a binding gate:
 *  - `canDrive`  — the HOS engine says the truck may legally drive right now.
 *  - `mustRest`  — the HOS engine says it may NOT (the binding rest/break outcome);
 *                  `restReason` says whether a 30-min break or a 10h reset is due.
 *  - `mustRefuel`— the odometer crossed the SAME `refuelThresholdMiles` the engine
 *                  uses (the binding refuel outcome).
 */
export interface TruckLegFeasibility {
  readonly canDrive: boolean;
  readonly mustRest: boolean;
  readonly mustRefuel: boolean;
  /**
   * Remaining legal drive minutes, DELEGATED to `remainingLegalDriveMinutes`
   * (the SAME headline number the engine/optimizer read) — the binding HOS budget
   * a future coordinator can inspect ("won't divert: only N legal minutes left").
   */
  readonly remainingDriveMinutes: number;
  /** Which rest the HOS engine requires when `mustRest` (else null). */
  readonly restReason: "rest-10h" | "break-30min" | null;
}

/**
 * The CLOSED hub-dock feasibility verdict — what the hub Decide is ALLOWED to do
 * given the frozen dock/consolidation state the engine produced:
 *  - `canDispatch`   — a dock door is free, so an outbound dispatch may run.
 *  - `canConsolidate`— a dock door is free, so the staged consolidation may run.
 * When no dock is free BOTH are false ⇒ the hub is bound to `hold` (no event).
 */
export interface HubDockFeasibility {
  readonly canDispatch: boolean;
  readonly canConsolidate: boolean;
}

/**
 * Reconstruct the domain {@link HosClock} from the frozen observation snapshot.
 * `ObservedHosClock` is a structural mirror of `HosClock` (the same seven fields),
 * so this is an identity adapter — it exists only to hand the snapshot to the
 * domain engine as the exact `HosClock` shape the engine signatures require (REUSE,
 * not a re-encode of the clock semantics).
 */
function clockFromObservation(obs: AgentObservation): HosClock {
  return {
    driveTodayMin: obs.hosClock.driveTodayMin,
    dutyWindowStartAt: obs.hosClock.dutyWindowStartAt,
    sinceLastBreakMin: obs.hosClock.sinceLastBreakMin,
    weeklyOnDutyMin: obs.hosClock.weeklyOnDutyMin,
    comeOnDutyAt: obs.hosClock.comeOnDutyAt,
    sleeperBerthLongMin: obs.hosClock.sleeperBerthLongMin,
    sleeperBerthShortMin: obs.hosClock.sleeperBerthShortMin,
  };
}

/**
 * BINDING truck-leg feasibility (OODA-03). Computes whether the truck may legally
 * drive its next minute and whether it must refuel, by DELEGATING to the domain
 * HOS engine and the engine's fuel-threshold rule — NOT by reimplementing them.
 *
 * HOS verdict (REUSE WITNESS): `canDrive = mayDriveNow(clock, hosConfig, now)`.
 * When it cannot drive, {@link applyDrivingLeg} (the SAME engine the optimizer
 * uses as a rest-as-time feasibility check) is asked to plan a single driving
 * minute; the first inserted `break`/`rest` segment IS the binding rest the agent
 * must take, so `restReason` is read straight off the engine's segment plan
 * (`break` ⇒ a 30-min break, `rest` ⇒ a 10h reset). No FMCSA math is duplicated
 * here — the predicate only ASSEMBLES the engine's outputs into a verdict.
 *
 * Fuel verdict: `mustRefuel = odometerMiles >= fuelConfig.refuelThresholdMiles` —
 * the EXACT rule `departTrailer` applies (`accrued >= refuelThresholdMiles`).
 *
 * @param obs        The FROZEN truck observation (integer/string only).
 * @param hosConfig  The injected FMCSA limits (the SAME the engine uses).
 * @param fuelConfig The injected fuel rule (only `refuelThresholdMiles` is read).
 * @param now        The observation's virtual-clock epoch-MINUTE (never `Date.now`).
 */
export function truckLegFeasibility(
  obs: AgentObservation,
  hosConfig: HosConfig,
  fuelConfig: FuelFeasibilityConfig,
  now: number,
): TruckLegFeasibility {
  const clock = clockFromObservation(obs);

  // HOS — DELEGATE to the shared engine (no reimplementation). `mayDriveNow` is the
  // authoritative "may I drive right now?" predicate; it folds the 11h/14h/8h/70h
  // limits the engine owns. `remainingLegalDriveMinutes` is the SAME headline budget
  // the engine/optimizer read — surfaced for a coordinator's reject-with-reason.
  const canDrive = mayDriveNow(clock, hosConfig, now);
  const remainingDriveMinutes = remainingLegalDriveMinutes(clock, hosConfig, now);

  let mustRest = false;
  let restReason: TruckLegFeasibility["restReason"] = null;
  if (!canDrive) {
    mustRest = true;
    // Ask the SAME engine the optimizer uses (rest-as-time feasibility) which rest
    // it would insert to make a single driving minute legal: the FIRST non-`drive`
    // segment is the binding rest. We read its kind off the engine's plan rather
    // than re-deriving the 8h/11h/14h boundary ourselves.
    const occurredAt = obs.hosClock.dutyWindowStartAt;
    const plan = applyDrivingLeg(clock, hosConfig, 1, occurredAt);
    const inserted = plan.segments.find((s) => s.kind !== "drive");
    restReason = inserted?.kind === "break" ? "break-30min" : "rest-10h";
  }

  // FUEL — the EXACT odometer-threshold rule the engine applies (REUSE, not a new
  // threshold). Independent of HOS: a truck can be both out of fuel and out of hours.
  const mustRefuel = obs.odometerMiles >= fuelConfig.refuelThresholdMiles;

  return { canDrive, mustRest, mustRefuel, remainingDriveMinutes, restReason };
}

/**
 * BINDING hub-dock feasibility (OODA-03). A dispatch or a consolidation may only
 * run when a dock door is free — the SAME dock-availability rule the engine's
 * `observeHub` encodes (`dockDoorsAvailable`). When no door is free the hub is
 * structurally bound to `hold` (no infeasible dispatch/consolidate can be emitted).
 *
 * @param obs The FROZEN hub observation (integer/string only).
 */
export function hubDockFeasibility(obs: HubObservation): HubDockFeasibility {
  const dockFree = obs.dockDoorsAvailable > 0;
  return { canDispatch: dockFree, canConsolidate: dockFree };
}
