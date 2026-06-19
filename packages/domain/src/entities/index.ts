import { z } from "zod";

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
 */
export const tripSchema = z.object({
  tripId: id,
  trailerId: id,
  fromHubId: id,
  toHubId: id,
});
export type Trip = z.infer<typeof tripSchema>;

/**
 * Phase-2 STUB (tech spec §6.2): a load block is the primary optimization unit
 * (a group of packages that move together). Kept minimal here so the closed
 * Phase-1 contract can name it without pulling Phase-2 behavior forward (YAGNI).
 */
export const loadBlockSchema = z.object({
  loadBlockId: id,
  packageIds: z.array(id),
});
export type LoadBlock = z.infer<typeof loadBlockSchema>;

/**
 * Phase-2 STUB (tech spec §6.4): a trailer slice is a logical depth segment
 * (rear-to-nose). Minimal placeholder for the LIFO load model.
 */
export const trailerSliceSchema = z.object({
  index: z.number().int().nonnegative(),
  loadBlockIds: z.array(id),
});
export type TrailerSlice = z.infer<typeof trailerSliceSchema>;
