import VectorLayer from "ol/layer/Vector.js";
import VectorImageLayer from "ol/layer/VectorImage.js";
import VectorSource from "ol/source/Vector.js";
import Cluster from "ol/source/Cluster.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import LineString from "ol/geom/LineString.js";
import { fromLonLat } from "ol/proj.js";
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";
import type { StyleFunction } from "ol/style/Style.js";
import type { HubDto, RouteDto } from "../api/client.js";
import type { TrailerSnapshot } from "./useTrailerSnapshots.js";
import type { HubState, RouteState, TrailerKeyframe, TrailerStop } from "@mm/api";
import { hubStyleTiered, routeStyleTiered, trailerStyle } from "./coloring.js";
import { classifyDutyBucket } from "./dutyColoring.js";
import { stopStyle } from "./stopColoring.js";
import { inductionStyle } from "./inductionColoring.js";
import { deliveryStyle } from "./deliveryColoring.js";
import { suggestionStyle } from "./suggestionColoring.js";

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

// ---------------------------------------------------------------------------
// VIZ-15 — cluster-bubble cached styles (≤4 pre-allocated, never per-cluster)
//
// Radius log-bucketed: 14px (1 member), 17px (2-4), 20px (5-9), 22px (10+).
// Slate-700 (#334155) disc, white count text. NEVER allocate inside the
// StyleFunction — all sizes are pre-built at module load.
// ---------------------------------------------------------------------------

/** Slate-700 disc fill for cluster bubbles (VIZ-15 UI-SPEC). */
const CLUSTER_FILL_COLOR = "#334155";
/** White text for the cluster count label. */
const CLUSTER_TEXT_COLOR = "#ffffff";
/** Font for the cluster count (bold, small, readable). */
const CLUSTER_FONT = 'bold 11px "system-ui", sans-serif';

/**
 * Pre-allocated cluster bubble styles: 4 size buckets, log-scaled.
 *
 *  bucket 0 → radius 14 (1 member  — rendered as individual in OL, but kept for fallback)
 *  bucket 1 → radius 17 (2-4 members)
 *  bucket 2 → radius 20 (5-9 members)
 *  bucket 3 → radius 22 (10+ members)
 *
 * The count label is a placeholder; the actual count is set by mutating
 * `image.text_` (OL internals) … but we follow the zero-per-frame rule by
 * pre-allocating the four SIZE variants, and set the count text on a
 * module-scoped mutable `Text` that is SHARED across the cluster style fn calls.
 * (OL re-renders the frame after `map.render()`, so the last-set text is correct.)
 *
 * Alternative: set the text on the cached Style at call time — OL does NOT cache
 * style objects per se; it caches rendering metadata. Mutating the Text object is
 * the established OL cluster pattern.
 */
const CLUSTER_STYLES: readonly Style[] = [14, 17, 20, 22].map(
  (radius) =>
    new Style({
      image: new CircleStyle({
        radius,
        fill: new Fill({ color: CLUSTER_FILL_COLOR }),
        stroke: new Stroke({ color: CLUSTER_TEXT_COLOR, width: 1.5 }),
      }),
      text: new Text({
        text: "",
        fill: new Fill({ color: CLUSTER_TEXT_COLOR }),
        font: CLUSTER_FONT,
      }),
    }),
);

/**
 * Return the cluster-bubble style for a cluster feature (VIZ-15).
 *
 * Branches:
 *  - cluster wraps >1 member → slate disc + white count, radius log-bucketed from
 *    pre-allocated CLUSTER_STYLES (zero per-cluster alloc).
 *  - cluster wraps exactly 1 member → delegate to hubStyleTiered for the individual
 *    member feature so a lone spoke still reads its tier + bucket style.
 *
 * OL Cluster feature exposes `.get("features")` as the member feature array.
 */
const clusterStyle: StyleFunction = (clusterFeature: FeatureLike): Style | Style[] => {
  const members: unknown = clusterFeature.get("features");
  if (!Array.isArray(members)) return CLUSTER_STYLES[0] as Style;

  if (members.length === 1) {
    // Single feature in cluster: render the actual hub style.
    const member = members[0] as FeatureLike;
    return hubStyleTiered(member);
  }

  // Multi-member cluster: log-bucket the count into ≤4 pre-allocated sizes.
  const count = members.length;
  let bucket: number;
  if (count <= 1) bucket = 0;
  else if (count <= 4) bucket = 1;
  else if (count <= 9) bucket = 2;
  else bucket = 3;

  const style = CLUSTER_STYLES[bucket] as Style;
  // Mutate the shared Text object on this cached style to show the count.
  // This follows the established OL cluster-style pattern (single mutable Text
  // per cached style; OL re-draws on the same frame so the text is current).
  style.getText()?.setText(String(count));
  return style;
};

/**
 * The return type for VIZ-15/16 hub layers: TWO separate layers.
 *
 *  - `centerLayer`  : un-clustered `VectorLayer` for Tier-1 regional centers.
 *    Centers are NEVER absorbed into the spoke cluster (UI-SPEC).
 *  - `spokeLayer`   : `VectorImageLayer({declutter:true})` with an `ol/source/Cluster`
 *    wrapping the spoke `VectorSource`. At continental zoom (≤5) this renders cluster
 *    bubbles; at zoom ≥7 individual spoke markers appear.
 *  - `source`       : the MERGED flat `VectorSource` that `applyHubBuckets` writes to
 *    (both centers and spokes live here as `hub:<id>` features). Callers MUST use
 *    this unified source for metric updates so all hubs receive their bucket deltas.
 *  - `centerSource` : center-only sub-source (for the center tier layer).
 *  - `spokeSource`  : spoke-only sub-source (for the Cluster source).
 */
export interface HubLayers {
  /** Tier-1 center layer (plain VectorLayer, never clustered). */
  readonly centerLayer: VectorLayer;
  /** Tier-2 spoke cluster layer (VectorImageLayer + declutter). */
  readonly spokeLayer: VectorImageLayer;
  /**
   * Unified hub source — contains BOTH center and spoke features keyed by
   * `hub:<id>`. This is what `applyHubBuckets` writes to so metric updates
   * reach every hub marker regardless of tier.
   */
  readonly source: VectorSource;
  /** Center-only source (also part of `source` — a separate sub-source for the center tier layer). */
  readonly centerSource: VectorSource;
  /** Spoke-only source (wrapped by the Cluster source). */
  readonly spokeSource: VectorSource;
}

/**
 * Create the VIZ-15/16 split hub layers.
 *
 * SPLIT: hubs are partitioned by `kind` (from Task 1 DTO):
 *  - `"center"` → centerSource (un-clustered VectorLayer, always individually visible)
 *  - `"spoke"`  → spokeSource (Cluster + VectorImageLayer({declutter:true}))
 *  - no kind    → falls back to spokeSource (safe for legacy 10-hub maps)
 *
 * Feature registration: every hub feature is registered with id `hub:<hubId>` in
 * `source` (the unified flat source) for `applyHubBuckets` lookups. A second
 * feature reference (same object) is added to the appropriate tier sub-source so
 * each tier layer renders from its own source. OL feature objects are shared by
 * reference, so a `feature.set("volumeBucket", b)` call on the unified source
 * immediately affects the tier layer rendering — NO double-update needed.
 *
 * VIZ-03: uses `hubStyleTiered` (zero-alloc StyleFunction) for tier-branched
 * coloring. Cluster bubbles use `clusterStyle` (pre-allocated 4 size buckets).
 */
export function createHubLayer(hubs: readonly HubDto[]): HubLayers {
  // Unified source — both tiers live here for `applyHubBuckets`.
  const source = new VectorSource({ useSpatialIndex: true });
  // Tier sub-sources (features are SHARED with `source` by object reference).
  const centerSource = new VectorSource({ useSpatialIndex: true });
  const spokeSource = new VectorSource({ useSpatialIndex: true });

  for (const hub of hubs) {
    const feature = new Feature({
      geometry: new Point(fromLonLat([hub.lon, hub.lat])),
      hubId: hub.hubId,
      name: hub.name,
      kind: hub.kind,
      tier: hub.tier,
      // Default bucket 0 until first tick delta arrives.
      volumeBucket: 0,
      slaRiskBucket: 0,
      congestionBucket: 0,
    });
    feature.setId(`hub:${hub.hubId}`);
    source.addFeature(feature);

    if (hub.kind === "center") {
      centerSource.addFeature(feature);
    } else {
      // "spoke" or unset → spoke cluster
      spokeSource.addFeature(feature);
    }
  }

  // Tier-1: un-clustered center layer (always individually visible at every zoom).
  const centerLayer = new VectorLayer({
    source: centerSource,
    style: hubStyleTiered,
  });

  // Tier-2: spoke cluster layer — distance 40, minDistance 20 per UI-SPEC.
  const clusterSource = new Cluster({
    distance: 40,
    minDistance: 20,
    source: spokeSource,
  });
  const spokeLayer = new VectorImageLayer({
    source: clusterSource,
    style: clusterStyle,
    declutter: true,
  });

  return { centerLayer, spokeLayer, source, centerSource, spokeSource };
}

/** Create the routes layer and populate its single source with all LineStrings.
 *
 * VIZ-03 / VIZ-16: uses `routeStyleTiered` (zero-alloc StyleFunction) so route
 * tier (backbone vs spoke leg) is encoded by stroke weight, and metric buckets
 * update in place via `feature.set("loadBucket", b)` — no source rebuild.
 * The `isBackbone` field from the REST DTO is stored on each feature so
 * `routeStyleTiered` can branch correctly.
 */
export function createRouteLayer(routes: readonly RouteDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const route of routes) {
    const coords = route.geometry.map(([lon, lat]) => fromLonLat([lon, lat]));
    const feature = new Feature({
      geometry: new LineString(coords),
      routeId: route.routeId,
      isBackbone: route.isBackbone,
      // Default bucket 0 until first tick delta arrives.
      loadBucket: 0,
      slaRiskBucket: 0,
    });
    feature.setId(`route:${route.routeId}`);
    source.addFeature(feature);
  }
  const layer = new VectorLayer({ source, style: routeStyleTiered });
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

// ---------------------------------------------------------------------------
// VIZ-17 — advisory-suggestion transient flash layer
// ---------------------------------------------------------------------------

/**
 * Create the (initially empty) suggestion-outcome layer (VIZ-17). A
 * `SuggestionEvent` tick-field adds a transient flash marker here via
 * {@link flashSuggestion}; a `setTimeout` removes it after ~2500 ms. The source
 * is never blindly cleared — features are added + removed individually (same
 * discipline as the induction + delivery layers).
 *
 * `declutter: true` so a burst of suggestions never stacks into an unreadable
 * pile (as specified in UI-SPEC VIZ-17).
 */
export function createSuggestionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  // Use a VectorLayer with declutter: true to prevent overlapping label pile-ups.
  const layer = new VectorLayer({ source, style: suggestionStyle, declutter: true });
  return { layer, source };
}

/**
 * Flash a suggestion marker at `[lon, lat]` for `durationMs` (default 2500): add a
 * transient Point feature with the `outcome` property, then remove it after the
 * timeout. `Date.now()` is used ONLY for feature-id uniqueness (markers just need
 * to not collide per flash) — it is NOT a virtual-clock concern, so this is correct
 * here (same sanctioned pattern as {@link flashInduction} / {@link flashDelivery}).
 */
export function flashSuggestion(
  source: VectorSource,
  suggestionId: string,
  lon: number,
  lat: number,
  outcome: "accepted" | "rejected",
  durationMs = 2500,
): void {
  const featureId = `suggestion:${suggestionId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    outcome,
    suggestionId,
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}
