import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import LineString from "ol/geom/LineString.js";
import { fromLonLat } from "ol/proj.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";
import type { HubDto, RouteDto } from "../api/client.js";
import type { TrailerSnapshot } from "./useTrailerSnapshots.js";

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

/** Shared hub marker style (one instance for all hubs). */
const HUB_STYLE = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: "#ef4444" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
});

/** Shared route line style (one instance for all routes). */
const ROUTE_STYLE = new Style({
  stroke: new Stroke({ color: "#2563eb", width: 2 }),
});

/** Shared trailer marker style (one instance for all live trailer points). */
const TRAILER_STYLE = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#16a34a" }),
    stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
  }),
});

/** A vector layer paired with the single source it owns. */
export interface Layer {
  readonly layer: VectorLayer;
  readonly source: VectorSource;
}

/** Create the hubs layer and populate its single source with all hub markers. */
export function createHubLayer(hubs: readonly HubDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const hub of hubs) {
    const feature = new Feature({
      geometry: new Point(fromLonLat([hub.lon, hub.lat])),
      hubId: hub.hubId,
      name: hub.name,
    });
    feature.setId(`hub:${hub.hubId}`);
    source.addFeature(feature);
  }
  const layer = new VectorLayer({ source, style: HUB_STYLE });
  return { layer, source };
}

/** Create the routes layer and populate its single source with all LineStrings. */
export function createRouteLayer(routes: readonly RouteDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const route of routes) {
    const coords = route.geometry.map(([lon, lat]) => fromLonLat([lon, lat]));
    const feature = new Feature({
      geometry: new LineString(coords),
      routeId: route.routeId,
    });
    feature.setId(`route:${route.routeId}`);
    source.addFeature(feature);
  }
  const layer = new VectorLayer({ source, style: ROUTE_STYLE });
  return { layer, source };
}

/** Create the (initially empty) live-trailer layer + its single reused source. */
export function createTrailerLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: TRAILER_STYLE });
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
