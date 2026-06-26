import type { HosConfig } from "@mm/domain";

import type { Rng } from "../rng.js";
import {
  type FuelFeasibilityConfig,
  truckLegFeasibility,
} from "./feasibility.js";
import type { AgentObservation, DivertReason, TruckDecision } from "./observe.js";

/**
 * OODA-01 — the PURE truck Observe→Orient→Decide function.
 *
 * `decideTruck(obs, rng)` reads ONLY the FROZEN `obs` snapshot and draws any
 * stochastic tie-break ONLY from the passed per-agent substream `rng` (never
 * `Math.random`, never `Date.now()` — DET-03). It NEVER mutates `obs`. Identical
 * `(obs, rng-state)` ⇒ identical `TruckDecision` (the determinism keystone).
 *
 * PRIORITY LADDER (documented, deterministic — binding feasibility first, so a
 * coordinator in P25 cannot override these agent-owned constraints, OODA-03):
 *
 *   1. REST  — out of legal driving hours, OR past the 8h break boundary. HOS is
 *      a HARD legal constraint, so it outranks everything (a truck physically
 *      cannot keep driving). `remainingLegalDriveMinutes <= 0` ⇒ a 10h reset;
 *      `minutesSinceLastBreak >= BREAK_BOUNDARY_MIN` ⇒ a 30-min break.
 *   2. REFUEL — the per-trailer odometer crossed `REFUEL_THRESHOLD_MILES` and the
 *      truck is legal to drive (else rest already won). A truck out of fuel also
 *      cannot proceed, so refuel is the second binding constraint.
 *   3. DIVERT — the next hub is congested/blocked beyond a tolerance AND an
 *      alternate exists. This is the ONE genuinely-new decision (→ TrailerDiverted).
 *   4. HOLD — no trip to run, or the next-hub dock is unavailable but the queue is
 *      still manageable (wait in place rather than re-route).
 *   5. PROCEED — feasible, uncongested: keep driving the planned leg (no event).
 *
 * Thresholds mirror the domain defaults (`DEFAULT_FUEL_CONFIG.refuelThresholdMiles`
 * = 1200; the FMCSA 8h/30-min break = 480 min) so the agent's binding feasibility
 * matches the existing centralized HOS/fuel logic it reuses. They are integer
 * constants here (the observation is integer/string only — PITFALLS Pitfall 2).
 */

/** Odometer miles that trigger a refuel (mirrors `DEFAULT_FUEL_CONFIG.refuelThresholdMiles`). */
const REFUEL_THRESHOLD_MILES = 1_200;
/** Minutes since last break that force a 30-min break (FMCSA 8h driving boundary). */
const BREAK_BOUNDARY_MIN = 8 * 60;
/** A 10h reset (rest-10h) is 600 minutes. */
const REST_10H_MIN = 600;
/** A 30-min break (break-30min) is 30 minutes. */
const BREAK_30_MIN = 30;
/** A refuel service stop (mirrors `DEFAULT_FUEL_CONFIG.refuelTimeMinutes`). */
const REFUEL_TIME_MIN = 30;
/** Deterministic tank model (mirrors `DEFAULT_FUEL_CONFIG`): mpg + tank capacity. */
const MILES_PER_GALLON = 6.5;
const TANK_CAPACITY_GALLONS = 150;
/**
 * Next-hub queue depth above which the truck considers diverting. Below this the
 * truck either proceeds (dock free) or holds (dock busy) rather than re-routing.
 */
const DIVERT_QUEUE_TOLERANCE = 50;

/**
 * Candidate alternate hubs to divert toward, in a STABLE preference order. In
 * this plan the truck Decide is pure/standalone (the engine wiring in 24-02 will
 * supply the real route-aware alternates); the fixed roster keeps the decision
 * deterministic and testable. The chosen hub is always DIFFERENT from `nextHubId`.
 */
const DIVERT_ALTERNATES: readonly string[] = ["DFW", "ATL", "DEN", "ORD", "MEM"];

/**
 * Build the `refuel` decision from the frozen observation (the deterministic tank
 * model mirrors `DEFAULT_FUEL_CONFIG`). Shared by both the binding-gate path and
 * the standalone fallback (DRY) so the refuel outcome is identical either way.
 */
function refuelDecision(obs: AgentObservation): TruckDecision {
  const gallons = Math.round(
    Math.min(obs.odometerMiles / MILES_PER_GALLON, TANK_CAPACITY_GALLONS),
  );
  return {
    kind: "refuel",
    gallons,
    odometerMiles: obs.odometerMiles,
    durationMin: REFUEL_TIME_MIN,
  };
}

/**
 * The OODA-03 BINDING-FEASIBILITY context (optional). When supplied, `decideTruck`
 * gates every outcome through {@link truckLegFeasibility}, which DELEGATES to the
 * shared `@mm/domain` HOS engine + the engine fuel-threshold rule — the SAME logic
 * the simulator/optimizer use. The verdict short-circuits to rest/refuel BEFORE any
 * proceed/divert branch, so an infeasible action is structurally UNREACHABLE (the
 * contract a P25 coordinator cannot override). When omitted, the Decide falls back
 * to the observation-derived thresholds (the standalone 24-01 behavior).
 */
export interface TruckFeasibilityContext {
  readonly hosConfig: HosConfig;
  readonly fuelConfig: FuelFeasibilityConfig;
  /** The observation's virtual-clock epoch-MINUTE (never `Date.now()` — DET-03). */
  readonly now: number;
}

/**
 * The pure truck decision. See the priority ladder above. The single `rng` draw
 * (the divert tie-break) is the only stochastic element; every other branch is a
 * deterministic function of the frozen observation.
 *
 * When `feasibility` is supplied (the engine path), the FIRST ladder step consults
 * the shared HOS/fuel engine via {@link truckLegFeasibility} and BINDS to rest /
 * refuel before any proceed/divert can be constructed — so no caller (a future
 * coordinator) can force an infeasible action through the agent (OODA-03 / T-24-08).
 */
export function decideTruck(
  obs: AgentObservation,
  rng: Rng,
  feasibility?: TruckFeasibilityContext,
): TruckDecision {
  // (0) BINDING FEASIBILITY GATE (OODA-03) — the un-overridable first step. The
  // verdict DELEGATES to the shared domain HOS engine (`mayDriveNow`/`applyDrivingLeg`)
  // and the engine fuel-threshold; if the truck may NOT legally drive it BINDS to
  // rest (or refuel when that is the binding shortfall), so an infeasible
  // proceed/divert is never even reached. This is what makes infeasibility
  // structurally UNREACHABLE rather than merely discouraged.
  if (feasibility !== undefined) {
    const verdict = truckLegFeasibility(
      obs,
      feasibility.hosConfig,
      feasibility.fuelConfig,
      feasibility.now,
    );
    if (verdict.mustRest) {
      // HOS is the hard legal constraint — it OUTRANKS refuel (a rest also
      // refuels-capable downtime). Read the binding rest off the engine's verdict.
      return verdict.restReason === "break-30min"
        ? { kind: "rest", reason: "break-30min", durationMin: BREAK_30_MIN }
        : { kind: "rest", reason: "rest-10h", durationMin: REST_10H_MIN };
    }
    if (verdict.mustRefuel) {
      return refuelDecision(obs);
    }
    // Legal to drive AND fueled per the SHARED engine — fall through to the
    // (now-feasible) divert/hold/proceed ladder. No proceed/divert can be infeasible.
  } else {
    // Standalone (24-01) fallback: derive the same outcomes from the observation's
    // pre-computed integer fields (the engine pre-rounds them from the SAME HOS/fuel
    // logic). Kept so the pure leaf is testable without a config.
    if (obs.remainingLegalDriveMinutes <= 0) {
      return { kind: "rest", reason: "rest-10h", durationMin: REST_10H_MIN };
    }
    if (obs.minutesSinceLastBreak >= BREAK_BOUNDARY_MIN) {
      return { kind: "rest", reason: "break-30min", durationMin: BREAK_30_MIN };
    }
    if (obs.odometerMiles >= REFUEL_THRESHOLD_MILES) {
      return refuelDecision(obs);
    }
  }

  // No trip to run ⇒ hold (nothing to proceed/divert toward).
  if (obs.tripId === null || obs.nextHubId === null) {
    return { kind: "hold", reason: "no-trip" };
  }

  // (3) DIVERT — the next hub is congested beyond tolerance AND an alternate
  // exists. The alternate is picked from the seeded substream (the ONLY rng draw)
  // among hubs DIFFERENT from the planned next hub, so the choice is deterministic
  // for a fixed (obs, rng-state) yet decorrelated per agent.
  if (obs.nextHubQueueDepth > DIVERT_QUEUE_TOLERANCE) {
    const alternates = DIVERT_ALTERNATES.filter((h) => h !== obs.nextHubId);
    if (alternates.length > 0) {
      const toHubId = rng.pick(alternates);
      const reason: DivertReason = obs.nextHubDockAvailable
        ? "rebalance"
        : "next-hub-congested";
      return { kind: "divert", toHubId, reason };
    }
  }

  // (4) HOLD — dock unavailable but queue manageable: wait rather than re-route.
  if (!obs.nextHubDockAvailable) {
    return { kind: "hold", reason: "dock-unavailable" };
  }

  // (5) PROCEED — feasible, uncongested, dock free: keep driving (no event).
  return { kind: "proceed" };
}
