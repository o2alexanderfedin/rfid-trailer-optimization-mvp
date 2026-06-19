import { z } from "zod";

/**
 * Phase-2 planning value types (tech spec §6/§7/§11.5/§12).
 *
 * This module is the SINGLE shared contract both pure Phase-2 packages
 * (`@mm/aggregation` and `@mm/load-planner`) import. It defines the planning
 * vocabulary — SLA / handling / size enums, the per-package planning-input view
 * (`PlanningPackage`), the route-stop shape, and the planner config with
 * spec-derived defaults.
 *
 * Discipline (mirrors the Phase-1 entities-as-schemas style):
 *  - Entities are zod schemas; the inferred TS type is the single source of
 *    truth (DRY). The same field constraints feed downstream validation.
 *  - PURE leaf: only `zod`. No I/O, no clock (`Date.now()`), no RNG
 *    (`Math.random()`) — deterministic, replay-safe, fully unit-testable.
 *  - This module does NOT import `entities` (entities may depend on planning;
 *    keeping the dependency one-directional avoids a cycle).
 */

/** A non-empty identifier (re-declared locally; `id` is module-private in entities). */
const id = z.string().min(1);

// --- Closed enums -----------------------------------------------------------

/**
 * SLA class — a closed urgency taxonomy. The ordering (express > priority >
 * standard > economy) is made deterministic and single-sourced by
 * {@link SLA_CLASS_WEIGHT}; AGG-04 priority imports that map, never re-stating
 * the weights.
 */
export const slaClassSchema = z.enum([
  "express",
  "priority",
  "standard",
  "economy",
]);
export type SlaClass = z.infer<typeof slaClassSchema>;

/**
 * Stable integer weight per SLA class — higher = more urgent. The single source
 * of SLA weighting for AGG-04 lexicographic priority `(slaClassWeight desc,
 * deadline asc)`. Integer so it is a safe deterministic sort key (no float ties).
 */
export const SLA_CLASS_WEIGHT: Record<SlaClass, number> = {
  express: 4,
  priority: 3,
  standard: 2,
  economy: 1,
};

/**
 * Handling class — drives the AGG-03 split rule (fragile must not be mixed with
 * heavy). Closed enum; `standard`/`fragile`/`heavy` are the split-relevant members.
 */
export const handlingClassSchema = z.enum(["standard", "fragile", "heavy"]);
export type HandlingClass = z.infer<typeof handlingClassSchema>;

/** Coarse size/weight class — a closed bucket taxonomy for block keying. */
export const sizeWeightClassSchema = z.enum(["small", "medium", "large"]);
export type SizeWeightClass = z.infer<typeof sizeWeightClassSchema>;

/**
 * A coarse, non-negative integer deadline bucket (tech spec §11.1). Derived
 * deterministically from the SLA window + the package deadline — NEVER from the
 * wall clock. Integer-bucketing keeps deadlines safe as group/sort keys (P3:
 * no floating-point keys).
 */
export const deadlineBucketSchema = z.number().int().nonnegative();
export type DeadlineBucket = z.infer<typeof deadlineBucketSchema>;

// --- Planning input view ----------------------------------------------------

/**
 * The planning-input view of a package (LOAD-01 / AGG inputs). A plain data
 * shape the pure modules consume WITHOUT reading the event store — it carries
 * the seven block-key dimensions plus the aggregate inputs (volume, weight) and
 * the deadline.
 *
 * `deadline` is "ms since a fixed epoch", sourced from event/payload timestamps
 * (NO wall clock), so planning stays deterministic and replay-safe.
 */
export const planningPackageSchema = z.object({
  packageId: id,
  /** Hub the package is currently at (block-key dimension). */
  currentHubId: id,
  /** Next hub at which this package is unloaded (block-key dimension). */
  nextUnloadHubId: id,
  /** Final destination hub (block-key dimension). */
  finalDestHubId: id,
  slaClass: slaClassSchema,
  handlingClass: handlingClassSchema,
  sizeWeightClass: sizeWeightClassSchema,
  /** Deadline in ms since a fixed epoch (from event timestamps — no wall clock). */
  deadline: z.number().int().nonnegative(),
  deadlineBucket: deadlineBucketSchema,
  /** Volume in cubic metres (strictly positive). */
  volume: z.number().positive(),
  /** Weight in kilograms (strictly positive). */
  weight: z.number().positive(),
});
export type PlanningPackage = z.infer<typeof planningPackageSchema>;

/**
 * A single stop on a route (LOAD-02). `stopIndex` is a non-negative integer;
 * stop 0 = earliest unload (mapped to the lowest trailer depth / rear door).
 */
export const routeStopSchema = z.object({
  hubId: id,
  stopIndex: z.number().int().nonnegative(),
});
export type RouteStop = z.infer<typeof routeStopSchema>;

// --- Planner config ---------------------------------------------------------

/** A strictly-positive weight/cost knob. */
const positiveWeight = z.number().positive();
/** A utilization fraction in the open-ish unit interval (0,1]. */
const utilFraction = z.number().gt(0).lte(1);

/**
 * The planner configuration both pure packages consume — the single source of
 * tuning knobs (tech spec §7.3/§7.5/§7.6/§12). Defaults live in
 * {@link DEFAULT_PLANNER_CONFIG}; AGG-04 and all LOAD scoring import these,
 * never hard-coding weights.
 */
export const plannerConfigSchema = z.object({
  /** §7.3 partial-LIFO hard gate: blockers above this ⇒ HARD infeasible. */
  maxAllowedBlockers: z.number().int().nonnegative(),
  /** AGG-03 split threshold (~one trailer-zone capacity), m³. */
  maxBlockVolume: positiveWeight,
  /** §7.5 average unload+reload time per blocker, minutes. */
  unloadReloadMin: positiveWeight,
  /** §7.5 per-unit-volume handling cost. */
  volCost: positiveWeight,
  /** §7.5 flat penalty when a blocked block is fragile. */
  fragilePenalty: positiveWeight,
  /** §7.5 flat penalty for dock delay. */
  dockDelayPenalty: positiveWeight,
  /** §7.5 flat penalty for SLA impact. */
  slaImpactPenalty: positiveWeight,
  /** §7.6 target utilization (0.80). */
  targetUtil: utilFraction,
  /** §12.1 lower band edge (0.75). */
  utilLow: utilFraction,
  /** §12.1 upper band edge (0.90). */
  utilHigh: utilFraction,
  /** §12.1 low-utilization quadratic weight. */
  wLow: positiveWeight,
  /** §12.1 high-utilization quadratic weight. */
  wHigh: positiveWeight,
});
export type PlannerConfig = z.infer<typeof plannerConfigSchema>;

/**
 * Spec-derived planner defaults (tech spec §7.3 `maxAllowedBlockers = 2`, §7.6
 * `targetUtilization = 80%`, acceptable range 75–90% → §12.1 band edges). The
 * remaining weights are positive demo defaults the two pure packages may tune.
 */
export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  maxAllowedBlockers: 2,
  maxBlockVolume: 30,
  unloadReloadMin: 5,
  volCost: 1,
  fragilePenalty: 10,
  dockDelayPenalty: 5,
  slaImpactPenalty: 20,
  targetUtil: 0.8,
  utilLow: 0.75,
  utilHigh: 0.9,
  wLow: 100,
  wHigh: 100,
};
