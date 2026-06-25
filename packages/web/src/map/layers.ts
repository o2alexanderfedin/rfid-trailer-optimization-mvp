import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import LineString from "ol/geom/LineString.js";
import { fromLonLat } from "ol/proj.js";
import type { HubDto, RouteDto } from "../api/client.js";
import type { TrailerSnapshot } from "./useTrailerSnapshots.js";
import type { HubState, RouteState, TrailerKeyframe, TrailerStop } from "@mm/api";
import { hubStyle, routeStyle, trailerStyle } from "./coloring.js";
import { classifyDutyBucket } from "./dutyColoring.js";
import { stopStyle } from "./stopColoring.js";
import { inductionStyle } from "./inductionColoring.js";
import { deliveryStyle } from "./deliveryColoring.js";

/**
 * The three logical map layers (VIZ-01), each backed by ONE reused
 * `ol/source/Vector` for the lifetime of the map (PITFALLS P10):
 *  - hubs     : static Point markers (one per hub).
 *  - routes   : static LineString geometries (one per linehaul leg).
 *  - trailers : LIVE Point markers, upserted + mutated IN PLACE per snapshot.
 *
 * Style discipline: every layer uses a SINGLE shared `Style` instance (no
 * per-feature style allocation), so many live updates never leak style objects.
 * Sources use `useSpatialIndex: true` (the default) for efficient extent
 * queries; we never clear/rebuild a source on update.
 */

/** A vector layer paired with the single source it owns. */
export interface Layer {
  readonly layer: VectorLayer;
  readonly source: VectorSource;
}

/** Create the hubs layer and populate its single source with all hub markers.
 *
 * VIZ-03: uses `hubStyle` (zero-alloc StyleFunction from coloring.ts) so hub
 * colors update in place via `feature.set("volumeBucket", b)` — no source rebuild.
 */
export function createHubLayer(hubs: readonly HubDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const hub of hubs) {
    const feature = new Feature({
      geometry: new Point(fromLonLat([hub.lon, hub.lat])),
      hubId: hub.hubId,
      name: hub.name,
      // Default bucket 0 until first tick delta arrives.
      volumeBucket: 0,
      slaRiskBucket: 0,
      congestionBucket: 0,
    });
    feature.setId(`hub:${hub.hubId}`);
    source.addFeature(feature);
  }
  // VIZ-03: StyleFunction replaces the single static HUB_STYLE — same zero-alloc
  // discipline (hubStyle reads from a pre-allocated STYLE_CACHE).
  const layer = new VectorLayer({ source, style: hubStyle });
  return { layer, source };
}

/** Create the routes layer and populate its single source with all LineStrings.
 *
 * VIZ-03: uses `routeStyle` (zero-alloc StyleFunction) so route colors update
 * in place via `feature.set("loadBucket", b)` — no source rebuild.
 */
export function createRouteLayer(routes: readonly RouteDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const route of routes) {
    const coords = route.geometry.map(([lon, lat]) => fromLonLat([lon, lat]));
    const feature = new Feature({
      geometry: new LineString(coords),
      routeId: route.routeId,
      // Default bucket 0 until first tick delta arrives.
      loadBucket: 0,
      slaRiskBucket: 0,
    });
    feature.setId(`route:${route.routeId}`);
    source.addFeature(feature);
  }
  const layer = new VectorLayer({ source, style: routeStyle });
  return { layer, source };
}

/** Create the (initially empty) live-trailer layer + its single reused source.
 *
 * VIZ-03 / FIX 9: uses `trailerStyle` (zero-alloc StyleFunction) so a trailer's
 * marker color tracks its `state` ("onTime" | "slaRisk" | "late" | "idle") in
 * place via `feature.set("state", s)` — no source rebuild, no per-frame alloc.
 */
export function createTrailerLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: trailerStyle });
  return { layer, source };
}

/**
 * Upsert the live trailer features on the SINGLE reused trailer source:
 *  - existing trailer (matched by feature id): mutate its Point geometry IN
 *    PLACE via `getGeometry().setCoordinates(...)` — never recreate the feature.
 *  - new trailer: create one Point feature, set its id, add it to the source.
 *
 * The source is NEVER cleared/rebuilt, so the feature count stays bounded to the
 * number of distinct trailers (leak guard / threat T-01-24).
 *
 * @deprecated Used by the legacy `useTrailerSnapshots` hook (Phase-1 protocol).
 * New code should use `upsertTrailerKeyframe` with the VIZ-02 keyframe approach.
 */
export function updateTrailerFeatures(
  source: VectorSource,
  trailers: readonly TrailerSnapshot[],
): void {
  for (const trailer of trailers) {
    const id = `trailer:${trailer.trailerId}`;
    const coord = fromLonLat([trailer.lon, trailer.lat]);
    const existing = source.getFeatureById(id);
    if (existing !== null) {
      const geom = existing.getGeometry();
      if (geom instanceof Point) {
        geom.setCoordinates(coord); // IN-PLACE update — no new feature/source
      }
      continue;
    }
    const feature = new Feature({
      geometry: new Point(coord),
      trailerId: trailer.trailerId,
      tripId: trailer.tripId,
    });
    feature.setId(id);
    source.addFeature(feature);
  }
}

// ---------------------------------------------------------------------------
// VIZ-02 / VIZ-03 — keyframe-based trailer upsert + metric bucket updates
// ---------------------------------------------------------------------------

/**
 * Upsert a trailer feature from a `TrailerKeyframe` (VIZ-02 envelope type).
 *
 * Unlike `updateTrailerFeatures` (which sets absolute lon/lat), this function
 * stores the keyframe's timing and routeId metadata on the feature for the
 * `attachTrailerAnimation` postrender loop to tween. The position is
 * NOT set here — the animation loop sets it via `getCoordinateAt(fraction)`.
 *
 * For new trailers: creates the feature with a Point at the route start (0,0
 * in EPSG:3857) as a placeholder; the postrender loop updates it before the
 * first visible frame.
 */
export function upsertTrailerKeyframe(
  source: VectorSource,
  keyframe: TrailerKeyframe,
): void {
  const id = `trailer:${keyframe.id}`;
  const existing = source.getFeatureById(id);
  if (existing !== null) {
    // In-place property update; the postrender loop reads these on the next frame.
    existing.set("routeId", keyframe.routeId);
    existing.set("departMs", keyframe.departMs);
    existing.set("etaMs", keyframe.etaMs);
    existing.set("state", keyframe.state);
    if (keyframe.util !== undefined) existing.set("util", keyframe.util);
    // VIZ-12: thread the flow direction so trailerStyle can color consolidation
    // trailers distinctly. Optional+additive — absent ⇒ the state-keyed style.
    if (keyframe.direction !== undefined) existing.set("direction", keyframe.direction);
    return;
  }
  // New trailer: create placeholder feature (point at origin until first tween).
  const feature = new Feature({
    geometry: new Point([0, 0]),
    trailerId: keyframe.id,
    routeId: keyframe.routeId,
    departMs: keyframe.departMs,
    etaMs: keyframe.etaMs,
    state: keyframe.state,
  });
  if (keyframe.util !== undefined) feature.set("util", keyframe.util);
  if (keyframe.direction !== undefined) feature.set("direction", keyframe.direction);
  feature.setId(id);
  source.addFeature(feature);
}

/**
 * Remove a trailer feature from the source when it leaves the network.
 *
 * Called for each id in `TickPayload.trailersGone`. Never clears the source;
 * only removes the specific feature so the feature count stays bounded.
 */
export function removeTrailerFeature(source: VectorSource, trailerId: string): void {
  const id = `trailer:${trailerId}`;
  const feature = source.getFeatureById(id);
  if (feature !== null) {
    source.removeFeature(feature);
  }
}

/**
 * Apply `HubState` metric bucket deltas to hub features (VIZ-03).
 *
 * `feature.set("volumeBucket", b)` triggers OL to re-invoke the `hubStyle`
 * StyleFunction on the next render, returning the pre-allocated cached `Style`.
 * NEVER rebuilds the source; NEVER calls `feature.setStyle(new Style(...))`.
 */
export function applyHubBuckets(
  source: VectorSource,
  hubs: readonly HubState[],
): void {
  for (const hub of hubs) {
    const feature = source.getFeatureById(`hub:${hub.id}`);
    if (feature === null) continue;
    feature.set("volumeBucket", hub.volumeBucket);
    feature.set("slaRiskBucket", hub.slaRiskBucket);
    feature.set("congestionBucket", hub.congestionBucket);
    // VIZ-11: derive the driver-duty bucket from the ws driver buckets and set it
    // on the feature so `hubStyle` colors the hub by driver availability. When a
    // hub carries no driver data the bucket is cleared (undefined) so the marker
    // falls back to its volume coloring (nothing is fabricated).
    const dutyBucket = classifyDutyBucket(hub);
    feature.set("dutyBucket", dutyBucket ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// SP2 — parked/refueling stop layer (spec §8)
// ---------------------------------------------------------------------------

/**
 * Create the (initially empty) trailer-STOP layer + its single reused source. A
 * `rested`/`refueling` stop renders a STATIONARY marker here (no tween) for the
 * stop's duration, styled distinctly by `stopStyle` (amber "P" / blue fuel pump).
 */
export function createTrailerStopLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: stopStyle });
  return { layer, source };
}

/** A stop's stable feature id — distinct per (trailer, trip, start), so a trailer
 * may show successive stops along a trip without collision. */
function stopFeatureId(s: TrailerStop): string {
  return `stop:${s.trailerId}:${s.tripId}:${s.startMs}`;
}

/**
 * Create the (initially empty) induction-event layer (VIZ-13). A `PackageInducted`
 * ws message adds a transient pulsing feature here via {@link flashInduction}; a
 * `setTimeout` removes it after ~2000 ms. The source is never blindly cleared —
 * features are added + removed individually (same discipline as the stop layer).
 */
export function createInductionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: inductionStyle });
  return { layer, source };
}

/**
 * Flash an induction marker at `[lon, lat]` for `durationMs` (default 2000): add a
 * transient Point feature, then remove it after the timeout. `Date.now()` is used
 * ONLY for feature-id uniqueness (markers just need to not collide per flash) — it
 * is NOT a virtual-clock concern, so this is correct here.
 */
export function flashInduction(
  source: VectorSource,
  inductionHubId: string,
  lon: number,
  lat: number,
  durationMs = 2000,
): void {
  const featureId = `induction:${inductionHubId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    inductionHubId,
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}

/**
 * Create the (initially empty) outbound-delivery layer (VIZ-14). A
 * `PackageDelivered` ws message adds a transient feature here via
 * {@link flashDelivery}; a `setTimeout` removes it after ~2000 ms. The source is
 * never blindly cleared — features are added + removed individually (same
 * discipline as the induction + stop layers).
 */
export function createDeliveryLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: deliveryStyle });
  return { layer, source };
}

/**
 * Flash a delivery marker at `[lon, lat]` for `durationMs` (default 2000): add a
 * transient Point feature at the destination hub, then remove it after the
 * timeout. `Date.now()` is used ONLY for feature-id uniqueness (markers just need
 * to not collide per flash) — it is NOT a virtual-clock concern, so this is
 * correct here (mirrors {@link flashInduction}).
 */
export function flashDelivery(
  source: VectorSource,
  deliveryHubId: string,
  lon: number,
  lat: number,
  durationMs = 2000,
): void {
  const featureId = `delivery:${deliveryHubId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    deliveryHubId,
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}

/**
 * Reconcile the trailer-stop source against the CURRENT set of active stops
 * (spec §8): upsert a STATIONARY marker per stop at its interpolated `lon`/`lat`
 * (set ONCE — never tweened while parked), and REMOVE any marker whose stop is no
 * longer in the set (the stop finished). The source is never blindly cleared, so
 * a still-active parked marker keeps its exact position across renders.
 */
export function applyTrailerStops(
  source: VectorSource,
  stops: readonly TrailerStop[],
): void {
  const wanted = new Set(stops.map(stopFeatureId));
  // Remove finished stops (feature exists but no longer in the active set).
  for (const feature of source.getFeatures()) {
    const id = feature.getId();
    if (typeof id === "string" && id.startsWith("stop:") && !wanted.has(id)) {
      source.removeFeature(feature);
    }
  }
  // Upsert each active stop (create once; never move a still-parked marker).
  for (const s of stops) {
    const id = stopFeatureId(s);
    if (source.getFeatureById(id) !== null) continue; // already parked here
    const feature = new Feature({
      geometry: new Point(fromLonLat([s.lon, s.lat])),
      trailerId: s.trailerId,
      tripId: s.tripId,
      kind: s.kind,
      startMs: s.startMs,
      durationMinutes: s.durationMinutes,
    });
    feature.setId(id);
    source.addFeature(feature);
  }
}

/**
 * Apply `RouteState` metric bucket deltas to route features (VIZ-03).
 *
 * `feature.set("loadBucket", b)` triggers `routeStyle` on next render.
 */
export function applyRouteBuckets(
  source: VectorSource,
  routes: readonly RouteState[],
): void {
  for (const route of routes) {
    const feature = source.getFeatureById(`route:${route.id}`);
    if (feature === null) continue;
    feature.set("loadBucket", route.loadBucket);
    feature.set("slaRiskBucket", route.slaRiskBucket);
  }
}
