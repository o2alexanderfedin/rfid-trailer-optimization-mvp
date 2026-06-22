import { z } from "zod";
import {
  deadlineBucketSchema,
  handlingClassSchema,
  sizeWeightClassSchema,
  slaClassSchema,
} from "../planning/index.js";

/**
 * Phase-1 domain entity types (tech spec §6).
 *
 * These are the nouns the Phase-1 `DomainEvent` union references. Behavior
 * (reducers, planners) lives in later packages — this is a pure, zero-runtime
 * dependency leaf (only `zod`). Entities are defined as zod schemas so the same
 * field constraints (e.g. WGS84 ranges, non-empty ids) are reused by the event
 * payload schemas (DRY) and the inferred TS type is the single source of truth.
 */

/** A WGS84 latitude in degrees, [-90, 90]. */
const latitude = z.number().gte(-90).lte(90);
/** A WGS84 longitude in degrees, [-180, 180]. */
const longitude = z.number().gte(-180).lte(180);
/** A non-empty identifier. */
const id = z.string().min(1);

/**
 * A `[lon, lat]` position pair (GeoJSON axis order). Used for route geometry so
 * it drops straight into OpenLayers / GeoJSON without re-ordering (VIZ-01).
 */
export const lonLatSchema = z.tuple([longitude, latitude]);
export type LonLat = z.infer<typeof lonLatSchema>;

/** Package size class — a small closed taxonomy for Phase-1 simulation. */
export const sizeClassSchema = z.enum(["small", "medium", "large"]);
export type SizeClass = z.infer<typeof sizeClassSchema>;

/**
 * A hub: a node in the middle-mile network. Phase-1 needs identity + geographic
 * position (to render on the live map).
 */
export const hubSchema = z.object({
  hubId: id,
  name: z.string().min(1),
  lat: latitude,
  lon: longitude,
});
export type Hub = z.infer<typeof hubSchema>;

/**
 * A package (tech spec §6.1). Phase-1 subset: identity, origin/destination hub,
 * size class, and weight — enough to create, scan, and route it through the
 * network for FND queries + simulation.
 */
export const packageSchema = z.object({
  packageId: id,
  originHubId: id,
  destHubId: id,
  sizeClass: sizeClassSchema,
  /** Weight in kilograms (positive). */
  weight: z.number().positive(),
  /**
   * Optional RFID tag bound to this package (SNS-02 mapping source). Additive:
   * packages created before RFID omit it. When present it is the key the
   * tag→package registry projection maps `RfidObserved.tagId` back through.
   */
  rfidTagId: id.optional(),
});
export type Package = z.infer<typeof packageSchema>;

/**
 * A trailer (tech spec §6.3). Phase-1 subset: identity + the hub it is
 * currently at. The full rear-to-nose slice model arrives in Phase 2.
 */
export const trailerSchema = z.object({
  trailerId: id,
  currentHubId: id,
});
export type Trailer = z.infer<typeof trailerSchema>;

/**
 * A dock door (tech spec §6.6): a constrained loading/unloading resource at a
 * hub. Phase-1 subset: identity + owning hub.
 */
export const dockDoorSchema = z.object({
  dockDoorId: id,
  hubId: id,
});
export type DockDoor = z.infer<typeof dockDoorSchema>;

/**
 * A route (tech spec §6.7): a planned hub-to-hub linehaul leg. Phase-1 models a
 * single from→to leg plus its great-circle geometry (`[lon, lat][]`) for the
 * map. Multi-stop routes are a later-phase extension.
 */
export const routeSchema = z.object({
  routeId: id,
  fromHubId: id,
  toHubId: id,
  geometry: z.array(lonLatSchema),
});
export type Route = z.infer<typeof routeSchema>;

/**
 * A trip (tech spec §6.8): a concrete trailer movement along a route leg.
 * Phase-1 subset: identity, the trailer, and from/to hubs.
 *
 * v1.2 (DRV-03): a trip may optionally name the driver bound to it. The field is
 * `.optional()` so every pre-v1.2 fixture/stream (no `driverId`) stays valid — a
 * trip is either unassigned or bound to exactly one driver, never a break.
 */
export const tripSchema = z.object({
  tripId: id,
  trailerId: id,
  fromHubId: id,
  toHubId: id,
  /** v1.2: the driver assigned to this trip, when one is bound (DRV-03). */
  driverId: id.optional(),
});
export type Trip = z.infer<typeof tripSchema>;

/**
 * Driver duty status (v1.2 DRV-01) — the closed four-state panel taxonomy from
 * the FMCSA duty-state machine: `driving → on_break (30-min) → driving →
 * resting (10h/34h) → off_duty`. The HOS engine (Phase 10) drives transitions;
 * here it is just the closed vocabulary, single-sourced for event payloads.
 */
export const dutyStatusSchema = z.enum([
  "driving",
  "on_break",
  "resting",
  "off_duty",
]);
export type DutyStatus = z.infer<typeof dutyStatusSchema>;

/**
 * A driver (v1.2 DRV-01): a first-class, event-sourced renewable resource. The
 * operational twin moved bare trailers before v1.2; a driver carries identity,
 * an optional human `name`/`licenseClass`, and a current `dutyStatus`. The
 * inferred type is the single source of truth (DRY with the driver event
 * payloads). The per-driver HOS clock is the separate {@link HosClock}
 * value-object (DRV-02), carried in event snapshots / projection rows.
 */
export const driverSchema = z.object({
  driverId: id,
  /** Optional human-readable name (additive — minimal drivers omit it). */
  name: z.string().min(1).optional(),
  /** Optional CDL license class (e.g. "A"); additive. */
  licenseClass: z.string().min(1).optional(),
  dutyStatus: dutyStatusSchema,
});
export type Driver = z.infer<typeof driverSchema>;

/**
 * A non-negative integer count of MINUTES (1 sim tick = 1 minute). HOS clocks
 * are pure integer math (no RNG, no fractional time), so every counter rejects
 * negatives and fractions at the validation boundary.
 */
const minuteCount = z.number().int().nonnegative();

/**
 * The per-driver Hours-of-Service clock (v1.2 DRV-02): the integer-minute state
 * the forward-labeling HOS engine (Phase 10) advances. A value-object (no
 * identity of its own) snapshotted into `DriverDutyStateChanged` and folded into
 * the driver-status projection.
 *
 * **Modeling note (the keystone trap):** the 14-hour duty window is ELAPSED
 * wall-clock — an ABSOLUTE deadline `dutyWindowStartAt + dutyWindowMin`, NOT a
 * decrementing counter (a counter would silently pause during breaks/dwell and
 * overstate legal drive time). Hence `dutyWindowStartAt`/`comeOnDutyAt` are ISO
 * stamps, while the accumulators are pure minute counts.
 *
 * The two `sleeperBerth*` accumulators carry the in-progress 7/3 & 8/2 split
 * provisions (`395.1(g)`) the Phase-10 engine consumes; they are 0 when no split
 * is in progress.
 */
export const hosClockSchema = z.object({
  /** 11h driving clock — minutes DRIVEN since the last 10h reset. */
  driveTodayMin: minuteCount,
  /** ISO stamp the 14h ABSOLUTE window deadline is measured from. */
  dutyWindowStartAt: id,
  /** 8h-break clock — minutes driven since the last ≥30-min break. */
  sinceLastBreakMin: minuteCount,
  /** 70h/8-day rolling ON-DUTY sum (driving + on-duty-not-driving), minutes. */
  weeklyOnDutyMin: minuteCount,
  /** ISO come-on-duty stamp for this duty cycle. */
  comeOnDutyAt: id,
  /** Sleeper-berth split: accrued minutes in the LONG period (≥7h qualifier). */
  sleeperBerthLongMin: minuteCount,
  /** Sleeper-berth split: accrued minutes in the SHORT period (the 2h/3h leg). */
  sleeperBerthShortMin: minuteCount,
});
export type HosClock = z.infer<typeof hosClockSchema>;

/**
 * The 7-part load-block key (AGG-01, tech spec §11.1): the tuple packages are
 * grouped by. Reuses the Phase-2 planning enums so the key vocabulary is
 * single-sourced (the same enums `PlanningPackage` carries).
 */
export const blockKeySchema = z.object({
  currentHubId: id,
  nextUnloadHubId: id,
  finalDestHubId: id,
  slaClass: slaClassSchema,
  deadlineBucket: deadlineBucketSchema,
  handlingClass: handlingClassSchema,
  sizeWeightClass: sizeWeightClassSchema,
});
export type BlockKey = z.infer<typeof blockKeySchema>;

/**
 * A load block (AGG-02, tech spec §6.2): the primary optimization unit — a group
 * of packages sharing a {@link BlockKey} that move together. Carries the
 * aggregates (total volume/weight, package count) and an AGG-04 `priority`.
 *
 * `packageCount` is refined to equal `packageIds.length` so a block cannot carry
 * an inconsistent count past the validation boundary (the aggregator computes
 * both from the same source; the refinement guards tampering — T-02-01).
 */
export const loadBlockSchema = z
  .object({
    loadBlockId: id,
    key: blockKeySchema,
    /** At least one package — an empty block is not a unit (AGG-02). */
    packageIds: z.array(id).min(1),
    packageCount: z.number().int().positive(),
    /** Aggregate volume, m³ (strictly positive). */
    totalVolume: z.number().positive(),
    /** Aggregate weight, kg (strictly positive). */
    totalWeight: z.number().positive(),
    /** AGG-04 lexicographic priority score (higher = placed/served sooner). */
    priority: z.number(),
  })
  .refine((b) => b.packageCount === b.packageIds.length, {
    message: "packageCount must equal packageIds.length",
    path: ["packageCount"],
  });
export type LoadBlock = z.infer<typeof loadBlockSchema>;

/**
 * A trailer slice (LOAD-01, tech spec §6.4): one logical depth segment of the
 * trailer in the rear-to-nose LIFO model.
 *
 * **Canonical depth convention (anti-P1, single-sourced):** `depth 0 = rear`
 * (the door / easiest access); depth increases toward the nose. Earlier-unload
 * freight belongs at lower depth — `unloadOrder(A) < unloadOrder(B) ⟹
 * depth(A) ≤ depth(B)`. The planner and the independent validator both build on
 * this one convention; it is never re-stated divergently.
 *
 * `usedVolume`/`usedWeight` are refined to not exceed the slice capacities so a
 * physically over-filled slice fails validation (P2: capacity is a hard shape
 * constraint, not a soft score).
 */
export const trailerSliceSchema = z
  .object({
    /** Depth from the rear door; 0 = rear (easiest access), increasing → nose. */
    depth: z.number().int().nonnegative(),
    /** Slice volume capacity, m³ (strictly positive). */
    capacityVolume: z.number().positive(),
    /** Slice weight capacity, kg (strictly positive). */
    capacityWeight: z.number().positive(),
    /** Volume currently used (≥ 0, ≤ capacityVolume). */
    usedVolume: z.number().nonnegative(),
    /** Weight currently used (≥ 0, ≤ capacityWeight). */
    usedWeight: z.number().nonnegative(),
    /** Load blocks placed in this slice (may be empty). */
    loadBlockIds: z.array(id),
  })
  .refine((s) => s.usedVolume <= s.capacityVolume, {
    message: "usedVolume must not exceed capacityVolume",
    path: ["usedVolume"],
  })
  .refine((s) => s.usedWeight <= s.capacityWeight, {
    message: "usedWeight must not exceed capacityWeight",
    path: ["usedWeight"],
  });
export type TrailerSlice = z.infer<typeof trailerSliceSchema>;
