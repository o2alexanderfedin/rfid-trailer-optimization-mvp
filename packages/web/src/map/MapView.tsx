import { useCallback, useEffect, useRef } from "react";
import Map from "ol/Map.js";
import View from "ol/View.js";
import TileLayer from "ol/layer/Tile.js";
import OSM from "ol/source/OSM.js";
import type VectorSource from "ol/source/Vector.js";
import { fromLonLat } from "ol/proj.js";
import { getUid } from "ol/util.js";
import { fetchHubs, fetchRoutes } from "../api/client.js";
import {
  createHubLayer,
  createRouteLayer,
  createTrailerLayer,
  updateTrailerFeatures,
} from "./layers.js";
import {
  useTrailerSnapshots,
  type SnapshotMessage,
} from "./useTrailerSnapshots.js";
import "ol/ol.css";

/** Centre of the contiguous USA, used as the initial view (lon, lat). */
const USA_CENTER: readonly [number, number] = [-98.5795, 39.8283];
const USA_ZOOM = 4;

/**
 * The live USA map (VIZ-01). OpenLayers 10 + OSM basemap rendering all hubs as
 * markers, all linehaul routes as LineStrings, and simulated trailers as LIVE
 * points fed by the `@mm/api` ws snapshot channel.
 *
 * OpenLayers leak discipline (PITFALLS P10 / validated realtime pattern):
 *  - The `ol/Map` and every `VectorSource` live in `useRef` — NEVER React state
 *    — and the map is created EXACTLY ONCE (the `[]`-dep effect).
 *  - Each logical layer (hubs, routes, trailers) is one reused `VectorSource`.
 *  - Live trailer updates mutate feature geometry IN PLACE
 *    (`updateTrailerFeatures` -> `getGeometry().setCoordinates(...)`); the
 *    source is never cleared/rebuilt, so the feature count stays bounded.
 *  - `crossOrigin: 'anonymous'` is set on OSM; tiles load over HTTPS.
 *  - On unmount the map is disposed (`setTarget(undefined)`), sources cleared,
 *    and the ws closed.
 *
 * Diagnostic `data-*` attributes on the map container expose bounded feature
 * counts + instance counts so the Playwright leak guard can assert the
 * single-source / in-place-update / created-once invariants from the outside.
 */
export function MapView(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const trailerSourceRef = useRef<VectorSource | null>(null);
  /** How many distinct ol/Map instances this component has created (leak guard). */
  const mapInstancesRef = useRef(0);
  /** How many distinct trailer VectorSources have been created (leak guard). */
  const trailerSourceInstancesRef = useRef(0);
  /** How many ws snapshots have been applied (proves live updates flow). */
  const snapshotCountRef = useRef(0);

  /** Write a diagnostic count onto the map container for the e2e to read. */
  const setAttr = useCallback((name: string, value: number): void => {
    containerRef.current?.setAttribute(name, String(value));
  }, []);

  // --- Create the OL Map exactly once + load static geo ---------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) return;

    const trailer = createTrailerLayer();
    trailerSourceRef.current = trailer.source;
    trailerSourceInstancesRef.current += 1;
    setAttr("data-trailer-source-instances", trailerSourceInstancesRef.current);

    const map = new Map({
      target: container,
      layers: [
        new TileLayer({ source: new OSM({ crossOrigin: "anonymous" }) }),
        trailer.layer, // trailer points draw on top of routes + hubs once added
      ],
      view: new View({
        center: fromLonLat([USA_CENTER[0], USA_CENTER[1]]),
        zoom: USA_ZOOM,
      }),
    });
    mapRef.current = map;
    mapInstancesRef.current += 1;
    setAttr("data-map-instances", mapInstancesRef.current);
    setAttr("data-hub-count", 0);
    setAttr("data-route-count", 0);
    setAttr("data-trailer-count", 0);
    setAttr("data-snapshot-count", 0);

    // Load the static geo once and insert hub/route layers UNDER the trailers.
    const controller = new AbortController();
    void (async () => {
      try {
        const [hubs, routes] = await Promise.all([
          fetchHubs(controller.signal),
          fetchRoutes(controller.signal),
        ]);
        if (controller.signal.aborted || mapRef.current !== map) return;
        const hubLayer = createHubLayer(hubs);
        const routeLayer = createRouteLayer(routes);
        // Routes beneath hubs beneath trailers (trailers stay top-most).
        map.getLayers().insertAt(1, routeLayer.layer);
        map.getLayers().insertAt(2, hubLayer.layer);
        setAttr("data-hub-count", hubLayer.source.getFeatures().length);
        setAttr("data-route-count", routeLayer.source.getFeatures().length);
      } catch {
        /* a stubbed/failed geo fetch leaves the basemap + live trailers usable */
      }
    })();

    return () => {
      controller.abort();
      map.getLayers().forEach((layer) => {
        const src: unknown =
          layer && "getSource" in layer
            ? (layer as { getSource(): unknown }).getSource()
            : null;
        if (src !== null && typeof src === "object" && "clear" in src) {
          (src as VectorSource).clear();
        }
      });
      map.setTarget(undefined);
      map.dispose();
      mapRef.current = null;
      trailerSourceRef.current = null;
    };
  }, [setAttr]);

  // --- Apply each ws snapshot IN PLACE on the single trailer source ----------
  const onSnapshot = useCallback(
    (snapshot: SnapshotMessage): void => {
      const source = trailerSourceRef.current;
      if (source === null) return;
      updateTrailerFeatures(source, snapshot.trailers);
      snapshotCountRef.current += 1;
      setAttr("data-trailer-count", source.getFeatures().length);
      setAttr("data-snapshot-count", snapshotCountRef.current);
      // Leak guard: expose the OL uid of one stable trailer feature. If updates
      // RECREATED features instead of mutating them in place, this uid would
      // change every snapshot; with in-place updates it stays constant.
      const probe = source.getFeatures()[0];
      if (probe !== undefined) {
        containerRef.current?.setAttribute("data-trailer-uid", getUid(probe));
      }
    },
    [setAttr],
  );
  useTrailerSnapshots(onSnapshot);

  return <div ref={containerRef} className="app__map" data-testid="map" />;
}
