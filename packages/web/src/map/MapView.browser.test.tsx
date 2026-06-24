/**
 * MapView.browser.test.tsx — Vitest Browser Mode (the `browser` lane, real Chromium).
 *
 * A genuine OpenLayers `ol/Map` is created against a real DOM + canvas (impossible
 * under jsdom). Beyond the original mount smoke, this suite DRIVES behaviour:
 *
 *  - mount smoke: single map, Legend overlay, leak-guard data-* invariants;
 *  - ws-driven trailer keyframe upsert + the `postrender` animation step
 *    (asserted via the live trailer Point moving off its [0,0] placeholder);
 *  - hub/route bucket application (asserted via data-hub-count / data-route-count
 *    populating from the MSW geo fetch, and the snapshot applying buckets in place);
 *  - click → select via the real `map.forEachFeatureAtPixel` path (a synthesized
 *    OL pointer click over the live trailer pixel selects its id; an empty-area
 *    click deselects to null);
 *  - unmount teardown: the leak data-* invariant returns (`data-map-net-live` → 0).
 *
 * Drive strategy (deliberate):
 *  - The MSW browser worker is started so `/api/hubs` + `/api/routes` resolve,
 *    populating the hub/route sources (so the bucket-apply branches are real).
 *  - Envelopes are pushed through a custom `WsContext.Provider` registry (NOT the
 *    socket-backed `WsProvider`), so dispatch is synchronous + deterministic and
 *    no real WebSocket is opened in the assertion window.
 *  - The real `ol/Map` is captured by spying on `attachTrailerAnimation` (whose
 *    2nd arg IS the map) while delegating to the real implementation — so the test
 *    can compute the live trailer pixel and synthesize a real OL click on it.
 *
 * OL refuses to render into a 0×0 container, so every mount host is sized.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import Point from "ol/geom/Point.js";
import type OlMap from "ol/Map.js";
import type Feature from "ol/Feature.js";
import type { WsEnvelope } from "@mm/api";
import type * as AnimateModule from "./animate.js";
import { MapView } from "./MapView.js";
import { WsProvider, WsContext, makeSubscriberRegistry } from "./WsProvider.js";
import { makeEntityMaps, applySnapshot, applyTick } from "./wsClient.js";
import { worker } from "../../test/msw/worker.js";
import { WS_SNAPSHOT, WS_TICK } from "../../test/msw/handlers.js";

// ---------------------------------------------------------------------------
// Capture the real OL Map: spy on attachTrailerAnimation (2nd arg = the map),
// delegating to the genuine implementation so the animation loop is unchanged.
// ---------------------------------------------------------------------------
let capturedMap: OlMap | null = null;

vi.mock("./animate.js", async () => {
  const actual = await vi.importActual<typeof AnimateModule>("./animate.js");
  return {
    ...actual,
    attachTrailerAnimation: (
      ...args: Parameters<typeof actual.attachTrailerAnimation>
    ): ReturnType<typeof actual.attachTrailerAnimation> => {
      capturedMap = args[1];
      return actual.attachTrailerAnimation(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create + attach a sized host so OL has a non-zero viewport.
 *
 * The OL target is MapView's INNER `.app__map` div (where `containerRef` points),
 * NOT this host. That div gets its size from `app__map { flex: 1 }` in index.css
 * — which is NOT loaded in this harness — so we make `host` a flex column and let
 * the `.app__map` flex child fill it (see the injected stylesheet below). Without
 * a non-zero OL target, the render/postrender animation loop never runs.
 */
function makeHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.width = "640px";
  host.style.height = "480px";
  host.style.display = "flex";
  document.body.appendChild(host);
  return host;
}

/** A `WsContext` value with a fresh registry + maps the test can dispatch into. */
function makeTestWsContext(): {
  registry: ReturnType<typeof makeSubscriberRegistry>;
  maps: ReturnType<typeof makeEntityMaps>;
} {
  return { registry: makeSubscriberRegistry(), maps: makeEntityMaps() };
}

/**
 * Dispatch an envelope exactly as the real `WsProvider` would: update the shared
 * entity maps first, then fan out to subscribers (MapView's `onEnvelope`).
 */
function dispatchEnvelope(
  ctx: ReturnType<typeof makeTestWsContext>,
  env: WsEnvelope,
): void {
  if (env.type === "snapshot") {
    applySnapshot(ctx.maps, env.payload);
  } else {
    applyTick(ctx.maps, env.payload);
  }
  ctx.registry.dispatch(env);
}

/** Find the live trailer source feature by id across the captured map's layers. */
function findTrailerFeature(map: OlMap, trailerId: string): Point | null {
  for (const layer of map.getLayers().getArray()) {
    if (!(layer instanceof VectorLayer)) continue;
    const src: unknown = layer.getSource();
    if (!(src instanceof VectorSource)) continue;
    const feature = src.getFeatureById(`trailer:${trailerId}`);
    if (feature === null) continue;
    const geom = feature.getGeometry();
    return geom instanceof Point ? geom : null;
  }
  return null;
}

/** Find the static hub feature by id across the captured map's layers (VIZ-07/11). */
function findHubFeature(map: OlMap, hubId: string): Feature | null {
  for (const layer of map.getLayers().getArray()) {
    if (!(layer instanceof VectorLayer)) continue;
    const src: unknown = layer.getSource();
    if (!(src instanceof VectorSource)) continue;
    const feature = src.getFeatureById(`hub:${hubId}`);
    if (feature !== null) return feature;
  }
  return null;
}

/**
 * Synthesize a real OL single-click at a viewport pixel by dispatching the
 * pointerdown→pointerup sequence OL converts into a `singleclick`/`click`.
 */
function clickAtPixel(map: OlMap, pixel: readonly [number, number]): void {
  const viewport = map.getViewport();
  const rect = viewport.getBoundingClientRect();
  const clientX = rect.left + pixel[0];
  const clientY = rect.top + pixel[1];
  const common: PointerEventInit = {
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
  };
  viewport.dispatchEvent(new PointerEvent("pointerdown", common));
  viewport.dispatchEvent(new PointerEvent("pointerup", common));
}

// ---------------------------------------------------------------------------
// MSW worker: makes /api/hubs + /api/routes resolve so hub/route sources exist.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // index.css is not loaded here, so give MapView's `.app__map` OL target a real
  // size (it would otherwise collapse to 0 height and OL would never render).
  const style = document.createElement("style");
  style.textContent = ".app__map { flex: 1 1 auto; min-height: 0; }";
  document.head.appendChild(style);

  await worker.start({ quiet: true, onUnhandledRequest: "bypass" });
});

afterEach(() => {
  capturedMap = null;
});

afterAll(() => {
  worker.stop();
});

describe("MapView (browser smoke)", () => {
  it("mounts a single real OpenLayers map with the Legend overlay", async () => {
    const host = makeHost();
    const screen = await render(
      <WsProvider>
        <MapView />
      </WsProvider>,
      { container: host },
    );

    const map = screen.getByTestId("map");
    await expect.element(map).toBeInTheDocument();
    await expect.element(screen.getByTestId("map-legend")).toBeInTheDocument();

    const el = map.element();
    expect(el.getAttribute("data-map-instances")).toBe("1");
    expect(el.getAttribute("data-map-net-live")).toBe("1");
    expect(el.getAttribute("data-trailer-source-instances")).toBe("1");
  });
});

describe("MapView (browser behaviour)", () => {
  it("applies a ws snapshot: loads hub/route geo, upserts a trailer keyframe, applies buckets, and animates the trailer off its placeholder", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView />
      </WsContext.Provider>,
      { container: host },
    );

    const mapEl = screen.getByTestId("map");
    await expect.element(mapEl).toBeInTheDocument();
    const el = mapEl.element();

    // The OL map was captured via the animation-attach spy.
    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // Geo fetch (MSW) resolves → hub + route sources populate (VIZ-01).
    await vi.waitFor(() => {
      expect(el.getAttribute("data-route-count")).toBe("2");
      expect(el.getAttribute("data-hub-count")).toBe("3");
    });

    // No envelope applied yet.
    expect(el.getAttribute("data-snapshot-count")).toBe("0");
    expect(el.getAttribute("data-trailer-count")).toBe("0");

    // Drive the snapshot: trailer keyframe upsert + hub/route bucket apply.
    dispatchEnvelope(ctx, WS_SNAPSHOT);

    // One snapshot applied; one trailer feature now exists.
    expect(el.getAttribute("data-snapshot-count")).toBe("1");
    expect(el.getAttribute("data-trailer-count")).toBe("1");
    // A stable OL uid was exposed for the live trailer probe (set on apply).
    expect(el.getAttribute("data-trailer-uid")).not.toBeNull();

    // The self-sustaining `postrender` loop (attachTrailerAnimation calls
    // map.render() every frame) tweens the trailer off the [0,0] placeholder
    // along the real route LineString (R-LAX-DFW). No explicit render needed.
    await vi.waitFor(
      () => {
        const geom = findTrailerFeature(map, "T-100");
        expect(geom).not.toBeNull();
        const [x, y] = geom?.getCoordinates() ?? [0, 0];
        // Moved away from the placeholder origin (EPSG:3857 metres are large).
        expect(Math.abs(x ?? 0) + Math.abs(y ?? 0)).toBeGreaterThan(1);
      },
      { timeout: 4000 },
    );

    // A delta tick upserts the same trailer (state change) without growing count.
    dispatchEnvelope(ctx, WS_TICK);
    expect(el.getAttribute("data-snapshot-count")).toBe("2");
    expect(el.getAttribute("data-trailer-count")).toBe("1");
  });

  it("removes a trailer on a `trailersGone` tick (bounded feature count)", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView />
      </WsContext.Provider>,
      { container: host },
    );

    const el = screen.getByTestId("map").element();
    await vi.waitFor(() => {
      expect(el.getAttribute("data-route-count")).toBe("2");
    });

    dispatchEnvelope(ctx, WS_SNAPSHOT);
    expect(el.getAttribute("data-trailer-count")).toBe("1");

    // Remove the trailer that the snapshot introduced.
    const goneTick: WsEnvelope = {
      v: 1,
      type: "tick",
      seq: 3,
      simMs: 11_000,
      simDay: 0,
      speed: WS_SNAPSHOT.speed,
      payload: { trailersGone: ["T-100"] },
    };
    dispatchEnvelope(ctx, goneTick);

    expect(el.getAttribute("data-trailer-count")).toBe("0");
    expect(el.getAttribute("data-entity-trailers")).toBe("0");
  });

  it("click → select: a click over the live trailer pixel selects its id; an empty-area click deselects", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();
    const selections: Array<string | null> = [];

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView onTrailerSelect={(id) => selections.push(id)} />
      </WsContext.Provider>,
      { container: host },
    );

    const el = screen.getByTestId("map").element();
    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
      expect(el.getAttribute("data-route-count")).toBe("2");
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // PAUSED snapshot (simSpeed 0) so the tween freezes: the trailer parks at a
    // FIXED fraction = (18000-8000)/(28000-8000) = 0.5 (midpoint of R-LAX-DFW,
    // comfortably inside the viewport). A moving trailer (simSpeed 120) would
    // cross the whole route in ~167ms and the click pixel would go stale.
    const pausedSnapshot: WsEnvelope = {
      v: 1,
      type: "snapshot",
      seq: 1,
      simMs: 18_000,
      simDay: 0,
      speed: { multiplier: 0, tickIntervalMs: 500, simSpeed: 0, paused: true },
      payload: {
        trailers: [
          {
            id: "T-100",
            routeId: "R-LAX-DFW",
            departMs: 8_000,
            etaMs: 28_000,
            state: "onTime",
            util: 0.82,
          },
        ],
        hubs: WS_SNAPSHOT.payload.hubs ?? [],
        routes: WS_SNAPSHOT.payload.routes ?? [],
        exceptionsOpen: [],
      },
    };
    dispatchEnvelope(ctx, pausedSnapshot);

    // Resolve the live trailer's (now stationary) pixel from its tweened
    // coordinate once the animation loop has moved it off the [0,0] placeholder.
    let trailerPixel: readonly [number, number] | null = null;
    await vi.waitFor(
      () => {
        const geom = findTrailerFeature(map, "T-100");
        expect(geom).not.toBeNull();
        const coord = geom?.getCoordinates() ?? [0, 0];
        expect(Math.abs(coord[0] ?? 0) + Math.abs(coord[1] ?? 0)).toBeGreaterThan(1);
        const px = map.getPixelFromCoordinate(coord);
        expect(px).not.toBeNull();
        // Pixel must be inside the 640×480 viewport for a real hit.
        expect(px[0]).toBeGreaterThanOrEqual(0);
        expect(px[0]).toBeLessThanOrEqual(640);
        expect(px[1]).toBeGreaterThanOrEqual(0);
        expect(px[1]).toBeLessThanOrEqual(480);
        trailerPixel = [px[0] ?? 0, px[1] ?? 0];
      },
      { timeout: 4000 },
    );
    if (trailerPixel === null) throw new Error("trailer pixel not resolved");

    // Click ON the trailer → forEachFeatureAtPixel finds it → selects "T-100".
    clickAtPixel(map, trailerPixel);
    await vi.waitFor(
      () => {
        expect(selections).toContain("T-100");
      },
      { timeout: 4000 },
    );

    // Click an empty corner (no feature) → deselect to null.
    const before = selections.length;
    clickAtPixel(map, [3, 3]);
    await vi.waitFor(() => {
      expect(selections.length).toBeGreaterThan(before);
      expect(selections[selections.length - 1]).toBeNull();
    });
  });

  it("VIZ-07: a click over a hub marker selects its hubId (and clears any trailer)", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();
    const hubSelections: Array<string | null> = [];
    const trailerSelections: Array<string | null> = [];

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView
          onHubSelect={(id) => hubSelections.push(id)}
          onTrailerSelect={(id) => trailerSelections.push(id)}
        />
      </WsContext.Provider>,
      { container: host },
    );

    const el = screen.getByTestId("map").element();
    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
      // Hub source is populated by the MSW geo fetch (3 hubs).
      expect(el.getAttribute("data-hub-count")).toBe("3");
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // Resolve the DFW hub's pixel from its (static) coordinate, inside the viewport.
    let hubPixel: readonly [number, number] | null = null;
    await vi.waitFor(() => {
      const feature = findHubFeature(map, "DFW");
      expect(feature).not.toBeNull();
      const geom = feature?.getGeometry();
      const coord = geom instanceof Point ? geom.getCoordinates() : null;
      expect(coord).not.toBeNull();
      const px = map.getPixelFromCoordinate(coord ?? [0, 0]);
      expect(px).not.toBeNull();
      expect(px[0]).toBeGreaterThanOrEqual(0);
      expect(px[0]).toBeLessThanOrEqual(640);
      expect(px[1]).toBeGreaterThanOrEqual(0);
      expect(px[1]).toBeLessThanOrEqual(480);
      hubPixel = [px[0] ?? 0, px[1] ?? 0];
    });
    if (hubPixel === null) throw new Error("hub pixel not resolved");

    // Click ON the hub → forEachFeatureAtPixel finds its hubId → selects "DFW".
    clickAtPixel(map, hubPixel);
    await vi.waitFor(() => {
      expect(hubSelections).toContain("DFW");
    });
    // A hub click clears any trailer selection (single active detail).
    expect(trailerSelections[trailerSelections.length - 1] ?? null).toBeNull();

    // An empty-area click deselects the hub.
    const before = hubSelections.length;
    clickAtPixel(map, [3, 3]);
    await vi.waitFor(() => {
      expect(hubSelections.length).toBeGreaterThan(before);
      expect(hubSelections[hubSelections.length - 1]).toBeNull();
    });
  });

  it("VIZ-11: a snapshot with driver buckets styles the hub markers by duty (dutyBucket set)", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView />
      </WsContext.Provider>,
      { container: host },
    );

    const el = screen.getByTestId("map").element();
    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
      expect(el.getAttribute("data-hub-count")).toBe("3");
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // Drive a snapshot carrying driver buckets: DFW all-resting (→ all-out bucket
    // 3); LAX all available (→ bucket 0); ORD no driver data (→ no duty bucket).
    const dutySnapshot: WsEnvelope = {
      v: 1,
      type: "snapshot",
      seq: 1,
      simMs: 10_000,
      simDay: 0,
      speed: WS_SNAPSHOT.speed,
      payload: {
        trailers: [],
        hubs: [
          { id: "DFW", volumeBucket: 2, slaRiskBucket: 0, congestionBucket: 1, driverCount: 2, onBreakCount: 0, restingCount: 2 },
          { id: "LAX", volumeBucket: 3, slaRiskBucket: 1, congestionBucket: 2, driverCount: 3, onBreakCount: 0, restingCount: 0 },
          { id: "ORD", volumeBucket: 1, slaRiskBucket: 0, congestionBucket: 0 },
        ],
        routes: WS_SNAPSHOT.payload.routes ?? [],
        exceptionsOpen: [],
      },
    };
    dispatchEnvelope(ctx, dutySnapshot);

    // The duty bucket is derived + set on each hub feature (drives hubStyle).
    await vi.waitFor(() => {
      expect(findHubFeature(map, "DFW")?.get("dutyBucket")).toBe(3); // all out
      expect(findHubFeature(map, "LAX")?.get("dutyBucket")).toBe(0); // all available
      // ORD has no driver data → no duty bucket → falls back to volume coloring.
      expect(findHubFeature(map, "ORD")?.get("dutyBucket")).toBeUndefined();
    });
  });

  it("unmount teardown: disposes the live map so net-live (created − disposed) returns to 0", async () => {
    const host = makeHost();
    const ctx = makeTestWsContext();

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <MapView />
      </WsContext.Provider>,
      { container: host },
    );

    const el = screen.getByTestId("map").element();
    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // Live before teardown: exactly one net-live map instance (created − disposed
    // = 1 − 0), and the real OL map is undisposed + attached to a DOM target.
    expect(el.getAttribute("data-map-instances")).toBe("1");
    expect(el.getAttribute("data-map-net-live")).toBe("1");
    expect(map.getTargetElement()).not.toBeNull();

    // Unmount runs the cleanup effect (un click + detach postrender, clear
    // sources, setTarget(undefined), dispose).
    await screen.unmount();

    // The cleanup ran `map.dispose()` (disposed === true) and detached the map
    // from the DOM (no target). MapView increments mapDisposedRef, so net-live =
    // created − disposed = 1 − 1 = 0. NOTE: the `data-map-net-live` attribute
    // CANNOT be re-read here — React nulls `containerRef.current` during the
    // unmount commit BEFORE the passive-effect cleanup runs, so the cleanup's
    // `setAttr(...)` is a no-op on the detached node. We therefore assert the
    // substantive "no leaked live map" invariant on the real OL map object.
    expect(map.getTargetElement()).toBeNull();
  });
});
