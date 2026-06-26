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
import type MapBrowserEvent from "ol/MapBrowserEvent.js";
import { fetchHubs, fetchRoutes } from "../api/client.js";
import type { RouteDto } from "../api/client.js";
import {
  createHubLayer,
  createRouteLayer,
  createTrailerLayer,
  createTrailerStopLayer,
  createInductionLayer,
  createDeliveryLayer,
  applyTrailerStops,
  flashInduction,
  flashDelivery,
  upsertTrailerKeyframe,
  removeTrailerFeature,
  applyHubBuckets,
  applyRouteBuckets,
} from "./layers.js";
import {
  makeEntityMaps,
  type EntityMaps,
} from "./wsClient.js";
import { useWsEnvelope } from "./WsProvider.js";
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

interface MapViewProps {
  /**
   * Called when the user clicks a trailer feature on the map.
   * Receives the trailerId string. Called with null if the click lands on
   * an empty area (deselects any current selection).
   */
  readonly onTrailerSelect?: ((trailerId: string | null) => void) | undefined;
  /**
   * VIZ-07: called when the user clicks a HUB feature on the map. Receives the
   * hubId string, or null when the click lands on an empty area (deselects).
   * Mirrors `onTrailerSelect` — a hub click takes priority over a (rarely
   * co-located) trailer hit so the Hub Detail panel opens reliably.
   */
  readonly onHubSelect?: ((hubId: string | null) => void) | undefined;
}

export function MapView({ onTrailerSelect, onHubSelect }: MapViewProps = {}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const trailerSourceRef = useRef<VectorSource | null>(null);
  const hubSourceRef = useRef<VectorSource | null>(null);
  const routeSourceRef = useRef<VectorSource | null>(null);
  // SP2 (spec §8): the parked/refueling stop-marker source.
  const stopSourceRef = useRef<VectorSource | null>(null);
  // VIZ-13: the transient external-induction pulsing-marker source.
  const inductionSourceRef = useRef<VectorSource | null>(null);
  // VIZ-14: the transient outbound-delivery flash layer source.
  const deliverySourceRef = useRef<VectorSource | null>(null);

  /** Route DTOs cached so we can look up LineString geometry for TrailerAnim. */
  const routeDtosRef = useRef<Map<string, RouteDto>>(new Map());

  /** Hub lon/lat cached (hubId → [lon, lat]) for VIZ-13 induction marker placement. */
  const hubLonLatRef = useRef<Map<string, readonly [number, number]>>(new Map());

  /** Per-trailer animation targets (mutated in place by envelope handler). */
  const trailerAnimsRef = useRef<Map<string, TrailerAnim>>(new Map());

  /**
   * Sim clock — resynced on each envelope's simMs AND retuned to the envelope's
   * `speed.simSpeed` so the local tween advances at the server's effective rate.
   * Seeded at 120 (= the default 500ms-tick cadence, MS_PER_TICK/tickIntervalMs)
   * so trailers move at the right pace from the very first frame; the first
   * envelope corrects it to the server-authoritative value.
   */
  const simClockRef = useRef(makeSimClock({ simSpeed: 120 }));

  /** Animation handle — removed on teardown. */
  const animationHandleRef = useRef<TrailerAnimationHandle | null>(null);

  /**
   * Stable ref for the VIZ-05 click-to-select callback so a changing closure
   * never requires re-registering the click listener on the OL map.
   */
  const onTrailerSelectRef = useRef<((id: string | null) => void) | undefined>(
    onTrailerSelect,
  );
  onTrailerSelectRef.current = onTrailerSelect;

  /** Stable ref for the VIZ-07 hub-select callback (same discipline as above). */
  const onHubSelectRef = useRef<((id: string | null) => void) | undefined>(
    onHubSelect,
  );
  onHubSelectRef.current = onHubSelect;

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

    // SP2 (spec §8): the parked/refueling STOP layer, ABOVE the moving-trailer
    // layer so a stationary stop marker sits on top of its (paused) truck marker.
    const stop = createTrailerStopLayer();
    stopSourceRef.current = stop.source;

    // VIZ-13: the transient external-induction layer, ABOVE the stop layer so a
    // pulsing induction marker reads on top (it self-removes after ~2s).
    const induction = createInductionLayer();
    inductionSourceRef.current = induction.source;

    // VIZ-14: the transient outbound-delivery layer, ABOVE the induction layer so
    // a delivery flash (green ✓) reads on top at the destination hub; it
    // self-removes after ~2s. Distinct from VIZ-13 induction purple / consolidation
    // cyan.
    const delivery = createDeliveryLayer();
    deliverySourceRef.current = delivery.source;

    const map = new OlMap({
      target: container,
      layers: [
        new TileLayer({
          source: new OSM({
            crossOrigin: "anonymous",
            // HUB-04: the hub set is derived from the GeoNames city dataset
            // (via `all-the-cities`), which is CC BY 4.0 and requires visible
            // attribution. OL APPENDS these to its default "© OpenStreetMap
            // contributors" credit, so both render in the on-map attribution
            // control alongside the basemap credit.
            attributions: [
              'City data © <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>, ' +
                '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>',
            ],
          }),
        }),
        trailer.layer,
        stop.layer,
        induction.layer,
        delivery.layer,
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

    // VIZ-05 + VIZ-07: wire map click → trailer / hub selection via
    // forEachFeatureAtPixel. The handler reads the *Ref.current callbacks so a
    // changing closure never requires re-registering the listener (one listener
    // for the map lifetime). A HUB hit takes priority over a trailer hit so the
    // Hub Detail panel opens reliably; an empty-area click deselects both.
    const clickHandler = (evt: MapBrowserEvent<PointerEvent>): void => {
      const trailerCb = onTrailerSelectRef.current;
      const hubCb = onHubSelectRef.current;
      if (trailerCb === undefined && hubCb === undefined) return;

      let hubId: string | null = null;
      let trailerId: string | null = null;
      map.forEachFeatureAtPixel(evt.pixel, (feature) => {
        const hid = feature.get("hubId") as string | undefined;
        if (typeof hid === "string") {
          hubId = hid;
          return true; // hub takes priority — stop on the first hub hit
        }
        const tid = feature.get("trailerId") as string | undefined;
        if (typeof tid === "string" && trailerId === null) {
          trailerId = tid; // remember the first trailer hit, keep scanning for a hub
        }
        return false;
      });

      // VIZ-07: a hub hit opens the Hub Detail panel (and clears any trailer
      // selection); otherwise a trailer hit opens the trailer plan. An empty
      // click deselects both panels.
      if (hubId !== null) {
        hubCb?.(hubId);
        trailerCb?.(null);
      } else {
        trailerCb?.(trailerId);
        hubCb?.(null);
      }
    };
    map.on("click", clickHandler as (evt: MapBrowserEvent) => void);

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

        // VIZ-13: cache hub lon/lat for placing induction markers by hubId.
        for (const h of hubs) {
          hubLonLatRef.current.set(h.hubId, [h.lon, h.lat]);
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

      // VIZ-05: unregister the click handler before disposal (Q5 item 6).
      map.un("click", clickHandler as (evt: MapBrowserEvent) => void);

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
      stopSourceRef.current = null;
      inductionSourceRef.current = null;
      deliverySourceRef.current = null;
      trailerAnimsRef.current.clear();
      routeDtosRef.current.clear();
      hubLonLatRef.current.clear();
    };
  }, [setAttr]);

  // --- Apply each ws envelope (VIZ-02 keyframes + VIZ-03 bucket deltas) -----
  const onEnvelope = useCallback(
    (envelope: WsEnvelope, maps: EntityMaps): void => {
      const trailerSource = trailerSourceRef.current;
      const hubSource = hubSourceRef.current;
      const routeSource = routeSourceRef.current;
      const stopSource = stopSourceRef.current;
      const inductionSource = inductionSourceRef.current;
      const deliverySource = deliverySourceRef.current;
      if (trailerSource === null) return;

      // Drive the local clock's PLAYBACK RATE from the server's effective speed
      // (= MS_PER_TICK / tickIntervalMs, or 0 while paused) BEFORE resyncing, so
      // the tween advances at the same rate the server jumps simMs per tick. This
      // is the fix that makes trailers track the server pace (and freeze on pause)
      // — it only mutates a closure number, so it never re-renders the map.
      simClockRef.current.setSpeed(envelope.speed.simSpeed);

      // Resync the sim clock to the envelope's authoritative simMs.
      // FIX D: use Date.now() — OL's frameState.time is also Date.now()-based
      // (animationDelay_ calls renderFrame_(Date.now())).  Using performance.now()
      // here while fromFrameTime() receives frameState.time (Date.now()-based) would
      // yield a wall-clock basis mismatch: the elapsed = frameTime - anchorWall
      // computation would be astronomically wrong, breaking the tween fraction.
      simClockRef.current.resync(Date.now(), envelope.simMs);

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
        // SP2 (spec §8): render the parked/refueling stop markers (full set).
        if (stopSource !== null) applyTrailerStops(stopSource, payload.trailerStops ?? []);
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
        // SP2 (spec §8): the tick carries the FULL stop set whenever it changed —
        // reconcile the parked-marker layer wholesale (undefined ⇒ unchanged).
        if (stopSource !== null && payload.trailerStops !== undefined) {
          applyTrailerStops(stopSource, payload.trailerStops);
        }
        // VIZ-13: flash a transient pulsing marker at each induction hub for ~2s
        // (freight entering from outside). Hub lon/lat looked up from the static
        // hub cache; an unknown hub is skipped (no marker rather than a crash).
        if (inductionSource !== null && payload.inductionEvents !== undefined) {
          for (const ev of payload.inductionEvents) {
            const lonLat = hubLonLatRef.current.get(ev.inductionHubId);
            if (lonLat !== undefined) {
              flashInduction(inductionSource, ev.inductionHubId, lonLat[0], lonLat[1]);
            }
          }
        }
        // VIZ-14: flash a transient marker at each DESTINATION hub for ~2s
        // (freight delivered / exiting the network). Hub lon/lat looked up from
        // the static hub cache; an unknown hub is skipped (no marker rather than a
        // crash). `deliveryEvents` exists ONLY on a TickPayload (Pitfall-7), so a
        // reconnect snapshot never re-flashes historical deliveries.
        if (deliverySource !== null && payload.deliveryEvents !== undefined) {
          for (const ev of payload.deliveryEvents) {
            const lonLat = hubLonLatRef.current.get(ev.hubId);
            if (lonLat !== undefined) {
              flashDelivery(deliverySource, ev.hubId, lonLat[0], lonLat[1]);
            }
          }
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
   * FIX 15: The route LineString + `getLength()` are only rebuilt when the
   * trailer's `routeId` actually changes (i.e., the trailer switches legs).
   * Reusing the cached `routeGeom` and `routeLengthM` on same-leg envelope
   * updates eliminates per-frame / per-envelope LineString allocations.
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

    if (existing !== undefined) {
      // In-place update — do NOT recreate the TrailerAnim (would break the
      // animation loop's reference into the same Map entry).
      // FIX 15: only rebuild routeGeom + routeLengthM when routeId changed.
      if (existing.currentRouteId !== routeId) {
        const routeDto = routeDtosRef.current.get(routeId);
        if (routeDto !== undefined) {
          const coords = routeDto.geometry.map((pair) =>
            fromLonLat([pair[0] ?? 0, pair[1] ?? 0]),
          );
          existing.routeGeom = new LineString(coords);
          existing.routeLengthM = existing.routeGeom.getLength();
        }
        // If no routeDto yet, keep the existing geom until geo fetch completes.
        existing.currentRouteId = routeId;
      }
      existing.departSimMs = departMs;
      existing.etaSimMs = etaMs;
      return;
    }

    // New trailer: build its initial geometry.
    const routeDto = routeDtosRef.current.get(routeId);
    let routeGeom: LineString;
    let routeLengthM: number;

    if (routeDto !== undefined) {
      const coords = routeDto.geometry.map((pair) =>
        fromLonLat([pair[0] ?? 0, pair[1] ?? 0]),
      );
      routeGeom = new LineString(coords);
      routeLengthM = routeGeom.getLength();
    } else {
      // Stub: single-point zero-length geometry (no route data yet).
      routeGeom = new LineString([[0, 0], [0, 0]]);
      routeLengthM = 0;
    }

    // Look up or create the Point geometry from the source feature.
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
      currentRouteId: routeId,
      routeGeom,
      routeLengthM,
      departSimMs: departMs,
      etaSimMs: etaMs,
      pointGeom,
    });
  }

  // Pass the stable entity maps ref to the hook (off the React render path).
  useWsEnvelope(onEnvelope, entityMapsRef.current);

  // The outer div carries app__map (flex: 1 1 auto from index.css) and
  // data-testid for e2e assertions. Position: relative so the Legend overlay
  // can be positioned absolute inside it.
  return (
    <div
      ref={containerRef}
      className="app__map"
      data-testid="map"
      style={{ position: "relative" }}
    >
      <Legend />
    </div>
  );
}
