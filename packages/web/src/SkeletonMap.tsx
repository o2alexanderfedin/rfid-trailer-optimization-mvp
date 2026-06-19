import { useEffect, useRef } from "react";
import Map from "ol/Map.js";
import View from "ol/View.js";
import TileLayer from "ol/layer/Tile.js";
import OSM from "ol/source/OSM.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import { fromLonLat } from "ol/proj.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";
import type { HubDto } from "./hubs.js";
import "ol/ol.css";

/** Centre of the contiguous USA, used as the initial view. */
const USA_CENTER: [number, number] = [-98.5795, 39.8283];

const hubStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: "#ef4444" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
});

/**
 * Phase-1 map spike (VIZ-01). Renders an OSM USA basemap plus hub markers
 * from `/hubs`.
 *
 * OpenLayers leak discipline (PITFALLS P10):
 *  - The `ol/Map` is created exactly ONCE and kept in a ref; React never
 *    re-creates or re-renders the map node.
 *  - A SINGLE `VectorSource` is reused for the lifetime of the component;
 *    feature updates clear + re-add features in place (no new source/layer
 *    per update) so the feature count stays bounded.
 *  - The map is disposed on unmount.
 *
 * The current hub feature count is exposed on the map container's
 * `data-hub-count` attribute so an e2e can assert no leak across updates.
 */
export function SkeletonMap({ hubs }: { hubs: readonly HubDto[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  // The ONE reused vector source.
  const sourceRef = useRef<VectorSource>(new VectorSource());

  // Create the map exactly once.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) return;

    const map = new Map({
      target: container,
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({ source: sourceRef.current, style: hubStyle }),
      ],
      view: new View({
        center: fromLonLat(USA_CENTER),
        zoom: 4,
      }),
    });
    mapRef.current = map;

    return () => {
      map.setTarget(undefined);
      map.dispose();
      mapRef.current = null;
    };
  }, []);

  // Update features IN PLACE on the single source when hubs change.
  useEffect(() => {
    const source = sourceRef.current;
    source.clear();
    for (const hub of hubs) {
      const feature = new Feature({
        geometry: new Point(fromLonLat([hub.lon, hub.lat])),
        hubId: hub.hubId,
        name: hub.name,
      });
      feature.setId(hub.hubId);
      source.addFeature(feature);
    }
    const container = containerRef.current;
    if (container !== null) {
      container.setAttribute(
        "data-hub-count",
        String(source.getFeatures().length),
      );
    }
  }, [hubs]);

  return <div ref={containerRef} className="app__map" data-testid="map" />;
}
