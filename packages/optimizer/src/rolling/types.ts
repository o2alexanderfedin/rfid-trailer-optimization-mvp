import type { DomainEvent, PlanAccepted, PlanGenerated, TimingConfig } from "@mm/domain";

import type { ObjectiveBreakdown, ObjectiveWeights } from "../objective/types.js";
import type { OptimizerScope } from "../graph/types.js";
import type { Recommendation, RepairKind } from "../repair/local-repair.js";

/**
 * `@mm/optimizer` — the rolling-epoch CONTRACTS (OPT-04/05/06).
 *
 * These types fix the stateless surface the rolling SHELL (the `@mm/api`
 * `RollingOptimizerService`) composes. Every type here is plain data: the only
 * stateful, IO-bearing part lives in the service, so the algorithmic core stays
 * a PURE function of its inputs (replay-identical, anti-P3; idempotent per
 * `(epochId, scopeHash)`, anti-P7).
 *
 * Discipline carried from the package:
 *  - The epoch clock (`nowMin`) is supplied from sim/event time — NEVER
 *    `Date.now()`. No `Math.random()` anywhere in the path. Same `(epoch, input,
 *    weights)` ⇒ byte-identical {@link EpochResult} (the OPT-06 keystone).
 *  - Feasibility (the Phase-2 `validatePlan` HARD gate) stays a SEPARATE output
 *    from the objective (anti-P2): a candidate's `feasible` flag and its
 *    `objectiveCost` never collapse into one value.
 */

/**
 * A minimal route stop in the twin: the hub serviced and its unload order
 * (`stopIndex` — earlier unload ⇒ lower index ⇒ lower trailer depth). The twin
 * carries its OWN minimal stop shape (not the full domain `RouteStop`) so the
 * rolling contract stays a small, self-describing surface (DIP / KISS).
 */
export interface TwinStop {
  readonly hubId: string;
  /** Unload order; 0 = earliest unload (rear door / lowest depth). */
  readonly stopIndex: number;
}

/**
 * A minimal load block in the twin: a stable id, the hub it next unloads at, and
 * its integer freight volume. This is the small slice of a domain load block the
 * epoch needs — the optimizer never re-models the full Phase-2 block (DRY).
 */
export interface TwinBlock {
  readonly blockId: string;
  /** Hub this block is unloaded at (must equal one of the trailer's stops). */
  readonly nextUnloadHubId: string;
  /** Integer freight units (the capacity + utilization driver). */
  readonly volume: number;
}

/**
 * OPT-HOS-01 (v1.2 Phase 15) — the assigned driver's HOS summary carried into the
 * planning twin. `remainingDriveMinutes` is the Phase-10 HOS engine's headline
 * `remainingLegalDriveMinutes`, read DETERMINISTICALLY from the Phase-13
 * `driver_status` projection by the snapshot builder (NEVER recomputed off the
 * wall clock). The optimizer SOFT-prefers trailers whose driver has more
 * remaining minutes (a smaller {@link PlanMetrics.restPenalty}). OPTIONAL +
 * additive on {@link TwinTrailer}: when absent, the trailer has no known driver
 * and the rest term is 0 — prior plans reproduce byte-identically.
 */
export interface TwinDriver {
  /** Stable id of the driver bound to this trailer's trip. */
  readonly driverId: string;
  /**
   * Remaining legal drive minutes (HOS-03), clamped ≥ 0 — the projection's
   * `remaining_drive_minutes`. Higher = more rested = soft-preferred.
   */
  readonly remainingDriveMinutes: number;
}

/**
 * One trailer in the planning twin: its current hub, scheduled departure, the
 * remaining route it must service, and the load blocks currently assigned to it.
 * A departure within the freeze window makes it FROZEN — the epoch leaves its
 * plan untouched (anti-P7 thrash).
 */
export interface TwinTrailer {
  /** Stable trailer id (also a deterministic tie-break key). */
  readonly trailerId: string;
  /** Hub the trailer currently sits at / departs from. */
  readonly currentHubId: string;
  /** Scheduled departure, minutes from the fixed epoch (sim/event time). */
  readonly departureMin: number;
  /** Integer freight capacity (utilization denominator + the capacity gate). */
  readonly capacity: number;
  /** The remaining route the trailer must service (drives unload order). */
  readonly route: readonly TwinStop[];
  /** Load blocks currently assigned to this trailer. */
  readonly blocks: readonly TwinBlock[];
  /**
   * OPT-HOS-01 — the assigned driver's HOS summary (remaining legal drive
   * minutes). OPTIONAL + additive: absent when the trailer has no driver bound
   * (back-compat — prior twins reproduce byte-identically with `restCost = 0`).
   */
  readonly driver?: TwinDriver;
}

/**
 * The planning twin's read of the world the epoch optimizes over — a pure data
 * snapshot of the projections (hubs, route legs, trailers + their loads). The
 * twin is a `structuredClone` of (the affected slice of) this snapshot, so
 * evaluation never mutates the source projection (OPT-04: zero side effects until
 * accept).
 */
export interface TwinSnapshot {
  /** Hubs in the network (identity only — the optimizer never re-models them). */
  readonly hubs: readonly string[];
  /**
   * The hub-and-spoke network CENTER hub id (OPT-09 / TIME-02 parity). A stop at
   * this hub draws the longer `dwellCenter` estimate; every other hub draws the
   * `dwellSpoke` estimate (mirroring the simulator's role-keyed dwell). OPTIONAL
   * + additive: when absent, the center defaults to `hubs[0]` (the convention the
   * simulator uses — `const center = hubs[0]`), so existing snapshots keep their
   * meaning without a contract break.
   */
  readonly centerHubId?: string;
  /** Route legs trailers run along (travel + capacity). */
  readonly routes: readonly TwinRoute[];
  /** Trailers in the network with their current load + route. */
  readonly trailers: readonly TwinTrailer[];
}

/** A route leg in the twin: a single `from → to` linehaul with travel + capacity. */
export interface TwinRoute {
  readonly routeId: string;
  readonly fromHubId: string;
  readonly toHubId: string;
  /** Travel time along the leg, whole minutes. */
  readonly travelMin: number;
  /** Per-trip integer freight capacity. */
  readonly capacity: number;
}

/**
 * One rolling epoch's clock + freeze knobs. `nowMin` comes from sim/event time
 * (NEVER `Date.now()`); `freezeWindowMin` is the 10-15-min near-departure window
 * within which a trailer's plan is frozen (anti-P7).
 */
export interface Epoch {
  /** Stable id for this epoch (idempotency key prefix). */
  readonly epochId: string;
  /** "Now" in minutes from the fixed epoch — from sim/event time, NEVER `Date.now`. */
  readonly nowMin: number;
  /** Freeze window in minutes: a trailer departing within `[now, now+freeze]` is frozen. */
  readonly freezeWindowMin: number;
}

/**
 * The input to {@link import("./epoch.js").runEpoch}: the new domain events that
 * drive scope detection + twin updates, and the twin snapshot the epoch reads.
 */
export interface EpochInput {
  /** New domain events since the last epoch (drive `detectAffectedScope`). */
  readonly events: readonly DomainEvent[];
  /** The planning-twin snapshot the epoch optimizes over (cloned, never mutated). */
  readonly twinSnapshot: TwinSnapshot;
  /**
   * The active timing config (OPT-09 / OPT-10) — the SINGLE source the optimizer
   * derives its deterministic role-based dwell estimate from (`expectedDwellMinutes`),
   * the same `TimingConfig` the simulator draws its random dwell from. OPTIONAL +
   * additive: defaults to `DEFAULT_TIMING_CONFIG` when absent, so existing callers
   * are unaffected. (Per-leg transit reaches the optimizer as `TwinRoute.travelMin`,
   * which the twin builder derives from `expectedTransitMinutes` of this config.)
   */
  readonly timing?: TimingConfig;
}

/**
 * One ranked repair recommendation, surfaced by `localRepair` (OPT-07) and
 * carried on an infeasible trailer's `EpochRecommendation`. Feasibility stays a
 * SEPARATE field on each entry (anti-P2): a low-cost repair is never assumed
 * feasible. The rationale (§17.4) is human-readable for the operator UI.
 */
export interface EpochRepairRec {
  /** The §17.4 recovery action. */
  readonly kind: RepairKind;
  /** Human-readable §17.4 rationale (anti-repudiation). */
  readonly rationale: string;
  /** Phase-2 HARD gate verdict — kept distinct from `kind` and cost (anti-P2). */
  readonly feasible: boolean;
}

/**
 * One candidate recommendation surfaced by the epoch for a trailer: its plan id,
 * trailer, the SEPARATE feasibility flag (anti-P2), the weighted objective cost,
 * and the per-term breakdown for explainability.
 */
export interface EpochRecommendation {
  readonly trailerId: string;
  readonly planId: string;
  /** Phase-2 `validatePlan` HARD verdict — kept distinct from `objectiveCost`. */
  readonly feasible: boolean;
  /** §12 weighted objective value (lower = better). */
  readonly objectiveCost: number;
  /** Per-term objective contribution breakdown (explainability). */
  readonly breakdown: ObjectiveBreakdown;
  /** Whether this trailer was frozen (skipped) this epoch (anti-P7). */
  readonly frozen: boolean;
  /**
   * Ranked repair recommendations from `localRepair` (OPT-07). Present only
   * when this trailer is infeasible and at least one repair was found; `undefined`
   * for feasible or frozen trailers (anti-clutter).
   */
  readonly repairRecommendations?: readonly EpochRepairRec[];
}

/**
 * The pure result of one epoch: the idempotency `scopeHash`, the `PlanGenerated`
 * / `PlanAccepted` payloads the SHELL will persist (or `null` when nothing is
 * accepted), and the per-trailer recommendations + objective breakdowns the API
 * exposes. Deep-equal across two identical runs (the OPT-06 keystone).
 */
export interface EpochResult {
  readonly epochId: string;
  /** Stable hash of `(scope, twinSnapshot)` — the idempotency key suffix. */
  readonly scopeHash: string;
  /** The candidate plan to record (observational); `null` when the scope is empty. */
  readonly generated: PlanGenerated["payload"] | null;
  /** The ONE side effect to commit on accept; `null` when nothing is accepted. */
  readonly accepted: PlanAccepted["payload"] | null;
  /** Per-trailer recommendations with objective breakdowns (for the API). */
  readonly recommendations: readonly EpochRecommendation[];
  /**
   * F-06 / OPT-02 — the min-cost-flow freight stage's result for this epoch:
   * which freight block flows over which route legs at minimum total cost
   * (`assignments`), the optimum `flowCost`, and `feasible`. OPTIONAL + additive
   * (non-breaking): it does NOT influence the deterministic selectPlan winner,
   * so it is purely observational. Always present once MCF is wired (fail-soft:
   * empty/infeasible ⇒ `{ assignments: [], flowCost: 0, feasible: true }`).
   */
  readonly freightAssignment?: EpochFreightAssignmentResult;
}

/**
 * The observable shape of the epoch's min-cost-flow freight stage (F-06/OPT-02).
 * Mirrors {@link import("../flow/freight-stage.js").EpochFreightAssignment} but
 * is declared here so the rolling contract stays self-describing (no cross-import
 * cycle: `flow` imports `rolling/types`, not the reverse for values).
 */
export interface EpochFreightAssignmentResult {
  /** Per-block leg assignments (`blockId`, `legEdgeIds`, integer `cost`). */
  readonly assignments: readonly {
    readonly blockId: string;
    readonly legEdgeIds: readonly string[];
    readonly cost: number;
  }[];
  /** `Σ assignment.cost` — the min-cost-flow optimum (0 when none / infeasible). */
  readonly flowCost: number;
  /** Whether the requested freight could be routed (true when empty/fail-soft). */
  readonly feasible: boolean;
}

export type { ObjectiveWeights, OptimizerScope, Recommendation };
