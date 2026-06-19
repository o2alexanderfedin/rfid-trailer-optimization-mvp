import { useCallback, useEffect, useRef } from "react";
import OlMap from "ol/Map.js";
import View from "ol/View.js";
import TileLayer from "ol/layer/Tile.js";
import OSM from "ol/source/OSM.js";
import type VectorSource from "ol/source/Vector.js";
import type VectorLayer from "ol/layer/Vector.js";
import LineString from "ol/geom/LineString.js";
import Point from "ol/geom/Point.js";
import { fromLonLat } from "ol/proj.js";
import { getUid } from "ol/util.js";
import { fetchHubs, fetchRoutes } from "../api/client.js";
import type { RouteDto } from "../api/client.js";
import {
  createHubLayer,
  createRouteLayer,
  createTrailerLayer,
  upsertTrailerKeyframe,
  removeTrailerFeature,
  applyHubBuckets,
  applyRouteBuckets,
} from "./layers.js";
import {
  makeEntityMaps,
  useWsEnvelope,
  type EntityMaps,
} from "./wsClient.js";
import { makeSimClock } from "./simClock.js";
import {
  attachTrailerAnimation,
  type TrailerAnim,
  type TrailerAnimationHandle,
} from "./animate.js";
import { Legend } from "./Legend.js";
import type { WsEnvelope } from "@mm/api";
import "ol/ol.css";

/** Centre of the contiguous USA, used as the initial view (lon, lat). */
const USA_CENTER: readonly [number, number] = [-98.5795, 39.8283];
const USA_ZOOM = 4;

/**
 * The live USA map (VIZ-01 / VIZ-02 / VIZ-03). OpenLayers 10 + OSM basemap
 * rendering all hubs as state-colored markers, all linehaul routes as
 * metric-colored LineStrings, and simulated trailers as LIVE animated points
 * fed by the `@mm/api` ws versioned envelope channel.
 *
 * OpenLayers leak discipline (PITFALLS P10 / T-01-24):
 *  - The `ol/Map` and every `VectorSource` live in `useRef` — NEVER React state
 *    — and the map is created EXACTLY ONCE (the `[]`-dep effect).
 *  - Each logical layer (hubs, routes, trailers) is one reused `VectorSource`.
 *  - Trailer animation is driven by ONE `postrender` listener (per
 *    `attachTrailerAnimation`), mutating `Point.setCoordinates` IN PLACE.
 *  - Hub/route coloring uses pre-allocated `STYLE_CACHE` via zero-alloc
 *    StyleFunctions; bucket deltas applied via `feature.set(...)` (no rebuild).
 *  - On unmount: `detach()` removes the postrender listener; sources cleared;
 *    map disposed; ws closed.
 *
 * Diagnostic `data-*` attributes on the map container expose bounded feature
 * counts + instance counts so the Playwright leak guard can assert the
 * single-source / in-place-update / created-once invariants from the outside.
 */
export function MapView(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const trailerSourceRef = useRef<VectorSource | null>(null);
  const hubSourceRef = useRef<VectorSource | null>(null);
  const routeSourceRef = useRef<VectorSource | null>(null);

  /** Route DTOs cached so we can look up LineString geometry for TrailerAnim. */
  const routeDtosRef = useRef<Map<string, RouteDto>>(new Map());

  /** Per-trailer animation targets (mutated in place by envelope handler). */
  const trailerAnimsRef = useRef<Map<string, TrailerAnim>>(new Map());

  /** Sim clock — resynced on each envelope's simMs. */
  const simClockRef = useRef(makeSimClock({ simSpeed: 1 }));

  /** Animation handle — removed on teardown. */
  const animationHandleRef = useRef<TrailerAnimationHandle | null>(null);

  /** Leak guard counters. */
  const mapInstancesRef = useRef(0);
  const mapDisposedRef = useRef(0);
  const trailerSourceInstancesRef = useRef(0);
  const snapshotCountRef = useRef(0);

  /** Entity maps — off the React render path. */
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  /** Write a diagnostic count onto the map container for the e2e to read. */
  const setAttr = useCallback((name: string, value: number | string): void => {
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

    const map = new OlMap({
      target: container,
      layers: [
        new TileLayer({ source: new OSM({ crossOrigin: "anonymous" }) }),
        trailer.layer,
      ],
      view: new View({
        center: fromLonLat([USA_CENTER[0], USA_CENTER[1]]),
        zoom: USA_ZOOM,
      }),
    });
    mapRef.current = map;
    mapInstancesRef.current += 1;
    setAttr("data-map-instances", mapInstancesRef.current);
    setAttr(
      "data-map-net-live",
      mapInstancesRef.current - mapDisposedRef.current,
    );
    setAttr("data-hub-count", 0);
    setAttr("data-route-count", 0);
    setAttr("data-trailer-count", 0);
    setAttr("data-snapshot-count", 0);

    // Attach the VIZ-02 animation loop — ONE postrender listener for all trailers.
    const handle = attachTrailerAnimation(
      trailer.layer as VectorLayer<VectorSource>,
      map,
      trailerAnimsRef.current,
      (frameTime) => simClockRef.current.fromFrameTime(frameTime),
    );
    animationHandleRef.current = handle;

    // Load the static geo once and insert hub/route layers UNDER the trailers.
    const controller = new AbortController();
    void (async () => {
      try {
        const [hubs, routes] = await Promise.all([
          fetchHubs(controller.signal),
          fetchRoutes(controller.signal),
        ]);
        if (controller.signal.aborted || mapRef.current !== map) return;

        // Cache route DTOs for geometry lookup by routeId.
        for (const r of routes) {
          routeDtosRef.current.set(r.routeId, r);
        }

        const hubLayer = createHubLayer(hubs);
        const routeLayer = createRouteLayer(routes);
        hubSourceRef.current = hubLayer.source;
        routeSourceRef.current = routeLayer.source;

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

      // VIZ-02 leak discipline: remove the postrender listener before disposal.
      handle.detach();
      animationHandleRef.current = null;

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
      mapDisposedRef.current += 1;
      setAttr(
        "data-map-net-live",
        mapInstancesRef.current - mapDisposedRef.current,
      );
      mapRef.current = null;
      trailerSourceRef.current = null;
      hubSourceRef.current = null;
      routeSourceRef.current = null;
      trailerAnimsRef.current.clear();
      routeDtosRef.current.clear();
    };
  }, [setAttr]);

  // --- Apply each ws envelope (VIZ-02 keyframes + VIZ-03 bucket deltas) -----
  const onEnvelope = useCallback(
    (envelope: WsEnvelope, maps: EntityMaps): void => {
      const trailerSource = trailerSourceRef.current;
      const hubSource = hubSourceRef.current;
      const routeSource = routeSourceRef.current;
      if (trailerSource === null) return;

      // Resync the sim clock to the envelope's authoritative simMs.
      simClockRef.current.resync(performance.now(), envelope.simMs);

      snapshotCountRef.current += 1;
      setAttr("data-snapshot-count", snapshotCountRef.current);

      if (envelope.type === "snapshot") {
        // Full resync: rebuild trailer anims + apply all hubs/routes.
        const payload = envelope.payload;

        // Upsert all trailer keyframes.
        for (const kf of payload.trailers) {
          upsertTrailerKeyframe(trailerSource, kf);
          _upsertTrailerAnim(kf.id, kf.routeId, kf.departMs, kf.etaMs);
        }

        // Apply hub + route buckets.
        if (hubSource !== null) applyHubBuckets(hubSource, payload.hubs);
        if (routeSource !== null) applyRouteBuckets(routeSource, payload.routes);
      } else {
        // Delta tick: upsert + delete.
        const payload = envelope.payload;

        if (payload.trailers !== undefined) {
          for (const kf of payload.trailers) {
            upsertTrailerKeyframe(trailerSource, kf);
            _upsertTrailerAnim(kf.id, kf.routeId, kf.departMs, kf.etaMs);
          }
        }
        if (payload.trailersGone !== undefined) {
          for (const id of payload.trailersGone) {
            removeTrailerFeature(trailerSource, id);
            trailerAnimsRef.current.delete(id);
          }
        }
        if (hubSource !== null && payload.hubs !== undefined) {
          applyHubBuckets(hubSource, payload.hubs);
        }
        if (routeSource !== null && payload.routes !== undefined) {
          applyRouteBuckets(routeSource, payload.routes);
        }
      }

      setAttr("data-trailer-count", trailerSource.getFeatures().length);

      // Leak guard: expose the OL uid of a stable trailer feature.
      const probe = trailerSource.getFeatures()[0];
      if (probe !== undefined) {
        setAttr("data-trailer-uid", getUid(probe));
      }

      // Expose entity map sizes for soak test assertions.
      setAttr("data-entity-trailers", maps.trailers.size);
    },
    [setAttr],
  );

  /**
   * Upsert a TrailerAnim for the animation loop from a keyframe.
   *
   * Looks up route geometry from the cached route DTOs. If the route is not
   * loaded yet (geo fetch still in flight), the anim is created with a stub
   * geometry (zero-length LineString); it will be corrected on the next resync.
   */
  function _upsertTrailerAnim(
    trailerId: string,
    routeId: string,
    departMs: number,
    etaMs: number,
  ): void {
    const trailerSource = trailerSourceRef.current;
    if (trailerSource === null) return;

    const existing = trailerAnimsRef.current.get(trailerId);
    const routeDto = routeDtosRef.current.get(routeId);

    // Build or reuse the route LineString geometry.
    let routeGeom: LineString;
    let routeLengthM: number;

    if (routeDto !== undefined) {
      const coords = routeDto.geometry.map((pair) =>
        fromLonLat([pair[0] ?? 0, pair[1] ?? 0]),
      );
      routeGeom = new LineString(coords);
      routeLengthM = routeGeom.getLength();
    } else if (existing !== undefined) {
      // Keep the existing geometry if no route DTO available yet.
      routeGeom = existing.routeGeom;
      routeLengthM = existing.routeLengthM;
    } else {
      // Stub: single-point zero-length geometry (no route data yet).
      routeGeom = new LineString([[0, 0], [0, 0]]);
      routeLengthM = 0;
    }

    if (existing !== undefined) {
      // In-place update — do NOT recreate the TrailerAnim (would break the
      // animation loop's reference into the same Map entry).
      existing.routeGeom = routeGeom;
      existing.routeLengthM = routeLengthM;
      existing.departSimMs = departMs;
      existing.etaSimMs = etaMs;
      return;
    }

    // New trailer: look up or create its Point geometry from the source feature.
    const featureId = `trailer:${trailerId}`;
    const feature = trailerSource.getFeatureById(featureId);
    let pointGeom: Point;
    if (feature !== null) {
      const geom = feature.getGeometry();
      pointGeom = geom instanceof Point ? geom : new Point([0, 0]);
    } else {
      pointGeom = new Point([0, 0]);
    }

    trailerAnimsRef.current.set(trailerId, {
      trailerId,
      routeGeom,
      routeLengthM,
      departSimMs: departMs,
      etaSimMs: etaMs,
      pointGeom,
    });
  }

  // Pass the stable entity maps ref to the hook (off the React render path).
  useWsEnvelope(onEnvelope, entityMapsRef.current);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="app__map" data-testid="map" />
      <Legend />
    </div>
  );
}
