/**
 * screenshots.browser.test.tsx — DOC-02 (Phase 18): capture REAL PNG screenshots
 * of the v1.2 driver-HOS hero feature for the README.
 *
 * Path chosen (per the Phase-18 spec's documented fallback): the existing vitest
 * BROWSER (real headless Chromium) harness — the same `*.browser.test.tsx` lane
 * that renders a genuine OpenLayers `ol/Map` against a real DOM + canvas. We
 * drive REPRESENTATIVE driver-HOS data so the captures show the feature reliably:
 *
 *   (a) `screenshots/live-map.png`   — the live USA map with trailers animating +
 *       hubs colored by driver duty (a snapshot carrying driver buckets sets each
 *       hub feature's `dutyBucket`, which drives the duty coloring).
 *   (b) `screenshots/hub-detail.png` — the Hub Detail panel opened on a hub, with
 *       its compact rows: each trailer's duty status + remaining legal drive time
 *       (the v1.2 hero datum). Fed via an MSW-stubbed `GET /api/hubs/:id/detail`.
 *
 * Why the fallback (not the chromium-real full-stack path): with the realistic
 * ORS time model, a trailer does not reliably DOCK at a destination hub within
 * the e2e's 120-tick window, so the real-stack Hub Detail panel would show no
 * driver duty at capture time. This harness renders the SAME real components with
 * deterministic driver-HOS data, so the hero feature is always visible — a
 * genuine UI render (real Chromium + real OpenLayers + the real React panels),
 * not a mockup. The LIVE demo path itself IS HOS-on (see `main.ts`); this test
 * only guarantees a deterministic capture.
 *
 * Screenshots are written to `docs/screenshots/` (repo root) via `page.screenshot`
 * (`path` is resolved relative to THIS test file). OL refuses to render into a
 * 0×0 container, so every mount host is sized.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type OlMap from "ol/Map.js";
import { http, HttpResponse } from "msw";
import type { WsEnvelope } from "@mm/api";
import type * as AnimateModule from "./map/animate.js";
import { MapView } from "./map/MapView.js";
import { HubDetail } from "./panels/HubDetail.js";
import { WsContext, makeSubscriberRegistry } from "./map/WsProvider.js";
import { makeEntityMaps, applySnapshot, applyTick } from "./map/wsClient.js";
import { worker } from "../test/msw/worker.js";
import type { HubDetailDto } from "./api/client.js";
import "./index.css";

// ---------------------------------------------------------------------------
// The full USA hub-and-spoke network (mirrors `@mm/simulation` USA_HUBS): MEM is
// the center; every spoke linehauls MEM↔spoke. Gives the live-map capture the
// national network the running demo shows (not the 3-hub unit fixture).
// ---------------------------------------------------------------------------
const USA_HUBS = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { hubId: "DFW", name: "Dallas-Fort Worth", lat: 32.7767, lon: -96.797 },
  { hubId: "ATL", name: "Atlanta", lat: 33.749, lon: -84.388 },
  { hubId: "LAX", name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { hubId: "JFK", name: "New York", lat: 40.7128, lon: -74.006 },
  { hubId: "DEN", name: "Denver", lat: 39.7392, lon: -104.9903 },
  { hubId: "PHX", name: "Phoenix", lat: 33.4484, lon: -112.074 },
  { hubId: "SEA", name: "Seattle", lat: 47.6062, lon: -122.3321 },
  { hubId: "IND", name: "Indianapolis", lat: 39.7684, lon: -86.1581 },
] as const;

const MEM = USA_HUBS[0];
const SPOKES = USA_HUBS.slice(1);
const USA_ROUTES = SPOKES.map((s) => ({
  routeId: `R-MEM-${s.hubId}`,
  fromHubId: MEM.hubId,
  toHubId: s.hubId,
  geometry: [
    [MEM.lon, MEM.lat],
    [s.lon, s.lat],
  ] as ReadonlyArray<readonly [number, number]>,
}));

// A duty bucket per spoke (rotating available/on-break/resting) so the live-map
// capture shows the full driver-duty hub coloring across the network.
function dutyBucketsFor(i: number): {
  driverCount: number;
  onBreakCount: number;
  restingCount: number;
} {
  switch (i % 3) {
    case 0:
      return { driverCount: 3, onBreakCount: 0, restingCount: 0 }; // available
    case 1:
      return { driverCount: 3, onBreakCount: 2, restingCount: 0 }; // on break
    default:
      return { driverCount: 2, onBreakCount: 0, restingCount: 2 }; // resting/out
  }
}

// Directory (relative to this file) the PNGs are written to — the README embeds
// them from `docs/screenshots/`.
const SHOT_DIR = "../../../docs/screenshots";

// ---------------------------------------------------------------------------
// Capture the real OL Map (the animation-attach spy hands us the map instance).
// ---------------------------------------------------------------------------
let capturedMap: OlMap | null = null;

vi.mock("./map/animate.js", async () => {
  const actual = await vi.importActual<typeof AnimateModule>("./map/animate.js");
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
// Representative driver-HOS Hub Detail payload — the v1.2 hero feature. Three
// trailers at the hub spanning the duty buckets: driving (0), on_break (1),
// resting (2), each with real remaining legal drive minutes.
// ---------------------------------------------------------------------------
const HUB_ID = "MEM";
const HUB_DETAIL: HubDetailDto = {
  hubId: HUB_ID,
  trailers: [
    {
      trailerId: "T-014",
      status: "docked",
      dockDoorId: "DOCK-3",
      assignedPackageIds: ["P-1001", "P-1002", "P-1003"],
      driver: { driverId: "D003", dutyStatus: "driving", remainingDriveMinutes: 214 },
      rearToNose: [{ depth: 0, loadBlockIds: ["P-1001", "P-1002", "P-1003"] }],
      utilization: 0.78,
      nextHubId: "ATL",
      arrivedAtMs: 8_000,
      estimatedEtaMs: 18_000,
      etaIsEstimate: true,
    },
    {
      trailerId: "T-022",
      status: "docked",
      dockDoorId: "DOCK-7",
      assignedPackageIds: ["P-2001", "P-2002"],
      driver: { driverId: "D007", dutyStatus: "on_break", remainingDriveMinutes: 96 },
      rearToNose: [{ depth: 0, loadBlockIds: ["P-2001", "P-2002"] }],
      utilization: 0.52,
      nextHubId: "DEN",
      arrivedAtMs: 9_500,
      estimatedEtaMs: 21_000,
      etaIsEstimate: true,
    },
    {
      trailerId: "T-031",
      status: "docked",
      dockDoorId: "DOCK-1",
      assignedPackageIds: ["P-3001", "P-3002", "P-3003", "P-3004"],
      driver: { driverId: "D011", dutyStatus: "resting", remainingDriveMinutes: 0 },
      rearToNose: [{ depth: 0, loadBlockIds: ["P-3001", "P-3002", "P-3003", "P-3004"] }],
      utilization: 0.91,
      nextHubId: "ORD",
      arrivedAtMs: 7_000,
      estimatedEtaMs: 30_000,
      etaIsEstimate: true,
    },
  ],
};

// A snapshot carrying DRIVER BUCKETS across the whole network so the map colors
// every hub by driver duty (VIZ-11), plus several trailers in transit on the
// spokes (paused at a fixed fraction so the capture is a stable frame).
const TRAILER_STATES = ["onTime", "slaRisk", "onTime", "late"] as const;
const DUTY_SNAPSHOT: WsEnvelope = {
  v: 1,
  type: "snapshot",
  seq: 1,
  simMs: 18_000,
  speed: { multiplier: 0, tickIntervalMs: 500, simSpeed: 0, paused: true },
  payload: {
    trailers: SPOKES.slice(0, 6).map((s, i) => ({
      id: `T-${100 + i}`,
      routeId: `R-MEM-${s.hubId}`,
      departMs: 8_000,
      etaMs: 28_000,
      state: TRAILER_STATES[i % TRAILER_STATES.length]!,
      util: 0.7 + (i % 3) * 0.08,
    })),
    hubs: USA_HUBS.map((h, i) => ({
      id: h.hubId,
      volumeBucket: (i % 3) + 1,
      slaRiskBucket: i % 2,
      congestionBucket: i % 3,
      ...dutyBucketsFor(i),
    })),
    routes: USA_ROUTES.map((r, i) => ({
      id: r.routeId,
      loadBucket: (i % 3) + 1,
      slaRiskBucket: i % 2,
    })),
    exceptionsOpen: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers (mirror MapView.browser.test.tsx)
// ---------------------------------------------------------------------------

/** Create + attach a sized host so OL has a non-zero viewport. */
function makeHost(width = 960, height = 600): HTMLDivElement {
  const host = document.createElement("div");
  host.className = "shot-host";
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
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

/** Dispatch an envelope exactly as the real `WsProvider` would. */
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

// ---------------------------------------------------------------------------
// MSW worker: /api/hubs + /api/routes for the map geo, plus the hub-detail stub.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // index.css IS imported above, but the OL target `.app__map` derives its size
  // from a flex parent; pin an explicit box so the OL canvas matches the element
  // we screenshot (otherwise OL renders into a partial viewport → white margin).
  const style = document.createElement("style");
  style.textContent =
    ".shot-host { width: 960px; height: 600px; }" +
    ".shot-host .app__map { width: 960px; height: 600px; flex: none; }";
  document.head.appendChild(style);

  await worker.start({ quiet: true, onUnhandledRequest: "bypass" });
  worker.use(
    // The full USA hub-and-spoke network for the live-map capture.
    http.get("/api/hubs", () => HttpResponse.json(USA_HUBS)),
    http.get("/api/routes", () => HttpResponse.json(USA_ROUTES)),
    // Representative driver-HOS hub detail for the panel capture.
    http.get(`/api/hubs/${HUB_ID}/detail`, () => HttpResponse.json(HUB_DETAIL)),
  );
});

afterEach(() => {
  capturedMap = null;
});

afterAll(() => {
  worker.stop();
});

describe("DOC-02 — README screenshots (real UI renders)", () => {
  it("(a) captures the live USA map with trailers + driver-duty hub coloring", async () => {
    // Make the test iframe large enough that the 960×600 host is NOT clipped
    // (a narrow iframe leaves the right of the captured element blank/white).
    await page.viewport(1024, 700);
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

    await vi.waitFor(() => {
      expect(capturedMap).not.toBeNull();
      // The full USA network loaded from MSW (the bucket-apply branches are real).
      expect(el.getAttribute("data-hub-count")).toBe(String(USA_HUBS.length));
      expect(el.getAttribute("data-route-count")).toBe(String(USA_ROUTES.length));
    });
    const map = capturedMap;
    if (map === null) throw new Error("map not captured");

    // Drive the duty snapshot: every hub gets a `dutyBucket` (the duty coloring),
    // trailer features are upserted and tween along their spoke routes.
    dispatchEnvelope(ctx, DUTY_SNAPSHOT);
    expect(el.getAttribute("data-snapshot-count")).toBe("1");
    expect(el.getAttribute("data-trailer-count")).toBe(String(DUTY_SNAPSHOT.payload.trailers?.length ?? 0));

    // The OL canvas must match the (now-laid-out) container, else it renders into
    // a stale/partial viewport. updateSize re-reads the container box; we wait
    // until the canvas spans the full container width before capturing, then let
    // the OSM tiles for the continental USA load + the tweens settle.
    await vi.waitFor(() => {
      map.updateSize();
      const size = map.getSize();
      expect(size).not.toBeUndefined();
      expect((size?.[0] ?? 0)).toBeGreaterThanOrEqual(900);
    });
    map.render();
    await new Promise((r) => setTimeout(r, 2_500));

    const shot = await page.screenshot({
      element: mapEl,
      path: `${SHOT_DIR}/live-map.png`,
      base64: true,
    });
    expect(shot.path).toContain("live-map.png");
    expect(shot.base64.length).toBeGreaterThan(0);
  });

  it("(b) captures the Hub Detail panel with driver duty + remaining drive time", async () => {
    const host = makeHost(420, 560);
    const ctx = makeTestWsContext();

    // Anchor useLiveSimMs (dwell) + useOpenExceptions to a snapshot first so the
    // panel renders live dwell rather than 0, matching the running app.
    dispatchEnvelope(ctx, DUTY_SNAPSHOT);

    const screen = await render(
      <WsContext.Provider value={ctx}>
        <div className="app__rail" style={{ width: 400, padding: 12 }}>
          <HubDetail hubId={HUB_ID} />
        </div>
      </WsContext.Provider>,
      { container: host },
    );

    // The MSW-stubbed fetch resolves → the three driver-duty rows render.
    const panel = screen.getByTestId("hub-detail");
    await expect.element(panel).toBeInTheDocument();
    await vi.waitFor(() => {
      const duties = host.querySelectorAll('[data-testid="hub-trailer-duty"]');
      expect(duties.length).toBe(HUB_DETAIL.trailers.length);
    });

    const shot = await page.screenshot({
      element: panel,
      path: `${SHOT_DIR}/hub-detail.png`,
      base64: true,
    });
    expect(shot.path).toContain("hub-detail.png");
    expect(shot.base64.length).toBeGreaterThan(0);
  });
});
