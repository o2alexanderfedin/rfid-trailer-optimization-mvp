/**
 * MSW request handlers for the web component test harness.
 *
 * These model the REAL `/api/*` surface the web components call through the
 * `packages/web/src/api/client.ts` helpers and the `WsProvider` socket:
 *
 *   - GET  /api/hubs        → readonly HubDto[]      (fetchHubs / MapView)
 *   - GET  /api/routes      → readonly RouteDto[]    (fetchRoutes / MapView)
 *   - GET  /api/kpis        → KpiSnapshot            (fetchKpis / KpiDashboard)
 *   - GET  /api/exceptions  → ExceptionItem[]        (alert feed bootstrap)
 *   - GET  /api/sim/speed   → SimSpeedState          (SpeedControl bootstrap)
 *   - POST /api/sim/speed   → SimSpeedState          (setSimSpeed / SpeedControl)
 *   - ws   /api/ws          → WsEnvelope snapshot+tick (WsProvider channel)
 *
 * Shapes reuse the canonical `@mm/api` wire types so the fixtures can never
 * drift from the server contract (a type error here means the contract moved).
 *
 * Note on paths: the browser requests the same-origin `/api/...` prefix (Vite
 * proxies it to Fastify in dev), so the handlers MUST match `/api/...`, not the
 * bare Fastify route paths.
 */
import { http, HttpResponse } from "msw";
import { ws } from "msw/core/ws";
import type {
  HubDto,
  RouteDto,
  KpiSnapshot,
  SimSpeedState,
  ExceptionItem,
  WsEnvelope,
} from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures — small but contract-realistic
// ---------------------------------------------------------------------------

/** Three USA hubs (subset of the real ~10) with valid lat/lon. */
export const HUBS: readonly HubDto[] = [
  { hubId: "LAX", name: "Los Angeles", lat: 33.9416, lon: -118.4085 },
  { hubId: "DFW", name: "Dallas/Fort Worth", lat: 32.8998, lon: -97.0403 },
  { hubId: "ORD", name: "Chicago O'Hare", lat: 41.9742, lon: -87.9073 },
];

/** Two linehaul routes with `[lon, lat]` GeoJSON-axis geometry. */
export const ROUTES: readonly RouteDto[] = [
  {
    routeId: "R-LAX-DFW",
    fromHubId: "LAX",
    toHubId: "DFW",
    geometry: [
      [-118.4085, 33.9416],
      [-97.0403, 32.8998],
    ],
  },
  {
    routeId: "R-DFW-ORD",
    fromHubId: "DFW",
    toHubId: "ORD",
    geometry: [
      [-97.0403, 32.8998],
      [-87.9073, 41.9742],
    ],
  },
];

/** A realistic live KPI snapshot (with the baseline sub-object for the money slide). */
export const KPIS: KpiSnapshot = {
  utilization: 0.82,
  rehandleCount: 7,
  rehandleMinutes: 35,
  wrongTrailerCount: 2,
  missedUnloadCount: 1,
  slaViolationRate: 0.04,
  onTimeDeparture: 0.93,
  onTimeArrival: 0.9,
  baseline: {
    utilization: 0.71,
    rehandleCount: 19,
    rehandleMinutes: 95,
    wrongTrailerCount: 6,
    missedUnloadCount: 4,
    slaViolationRate: 0.12,
    onTimeDeparture: 0.81,
    onTimeArrival: 0.78,
  },
};

/** A couple of open exceptions for the alert-feed bootstrap. */
export const EXCEPTIONS: readonly ExceptionItem[] = [
  {
    id: "ex-1",
    kind: "wrongTrailer",
    severity: "high",
    entityId: "T-100",
    reason: "Package P-9 scanned onto T-100 bound for ORD, destined DFW",
    recommendedAction: "Reroute P-9 to T-200",
    simMs: 12_000,
  },
  {
    id: "ex-2",
    kind: "lowUtilization",
    severity: "low",
    entityId: "T-200",
    reason: "Trailer T-200 departing at 41% fill",
    recommendedAction: "Hold for consolidation",
    simMs: 9_000,
  },
];

/** The default "speed of time" state (1× cadence, not paused). */
export const SPEED_DEFAULT: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

/**
 * A sample snapshot envelope (seq 1) — one trailer on R-LAX-DFW, hub + route
 * buckets, and the open exceptions. Carries the envelope-level `speed` field.
 */
export const WS_SNAPSHOT: WsEnvelope = {
  v: 1,
  type: "snapshot",
  seq: 1,
  simMs: 10_000,
  speed: SPEED_DEFAULT,
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
    hubs: [
      { id: "LAX", volumeBucket: 3, slaRiskBucket: 1, congestionBucket: 2 },
      { id: "DFW", volumeBucket: 2, slaRiskBucket: 0, congestionBucket: 1 },
      { id: "ORD", volumeBucket: 1, slaRiskBucket: 0, congestionBucket: 0 },
    ],
    routes: [
      { id: "R-LAX-DFW", loadBucket: 3, slaRiskBucket: 1 },
      { id: "R-DFW-ORD", loadBucket: 1, slaRiskBucket: 0 },
    ],
    exceptionsOpen: EXCEPTIONS,
  },
};

/** A sample tick envelope (seq 2) — one trailer state change + speed echo. */
export const WS_TICK: WsEnvelope = {
  v: 1,
  type: "tick",
  seq: 2,
  simMs: 10_500,
  speed: SPEED_DEFAULT,
  payload: {
    trailers: [
      {
        id: "T-100",
        routeId: "R-LAX-DFW",
        departMs: 8_000,
        etaMs: 28_000,
        state: "slaRisk",
        util: 0.84,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// WebSocket link (MSW v2 `ws`) — the `/api/ws` snapshot channel
// ---------------------------------------------------------------------------

/**
 * The `/api/ws` link. MSW's ws link matches on a URL pattern; the WsProvider
 * connects to `ws(s)://<host>/api/ws`, so a `*` host wildcard matches under any
 * test origin (jsdom `localhost`, browser-mode preview host, etc.).
 */
export const api = ws.link("ws://*/api/ws");

/**
 * The WebSocket handler: on connect, emit the snapshot envelope, then a single
 * tick — exactly what a real consumer (WsProvider → MapView/KpiDashboard) sees.
 */
const wsHandler = api.addEventListener("connection", ({ client }) => {
  client.send(JSON.stringify(WS_SNAPSHOT));
  client.send(JSON.stringify(WS_TICK));
});

// ---------------------------------------------------------------------------
// HTTP + WS handler list
// ---------------------------------------------------------------------------

/** All handlers — shared by the node server and the browser worker. */
export const handlers = [
  http.get("/api/hubs", () => HttpResponse.json(HUBS)),
  http.get("/api/routes", () => HttpResponse.json(ROUTES)),
  http.get("/api/kpis", () => HttpResponse.json(KPIS)),
  http.get("/api/exceptions", () => HttpResponse.json(EXCEPTIONS)),
  http.get("/api/sim/speed", () => HttpResponse.json(SPEED_DEFAULT)),
  http.post("/api/sim/speed", async ({ request }) => {
    const body = (await request.json()) as {
      multiplier?: number;
      paused?: boolean;
    };
    // Echo the requested change back as the effective state (server-clamped in
    // prod; here the test simply reflects the input over the defaults).
    const next: SimSpeedState = {
      multiplier: body.multiplier ?? SPEED_DEFAULT.multiplier,
      tickIntervalMs: SPEED_DEFAULT.tickIntervalMs,
      simSpeed: body.paused === true ? 0 : SPEED_DEFAULT.simSpeed,
      paused: body.paused ?? SPEED_DEFAULT.paused,
    };
    return HttpResponse.json(next);
  }),
  wsHandler,
];
