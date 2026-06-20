import { expect, test } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

/**
 * M-6: VIZ-01 leak guard under React StrictMode (dev), where it actually matters.
 *
 * `main.tsx` wraps the app in `<StrictMode>`. In a DEV build (`vite dev`)
 * StrictMode intentionally runs every effect mount→cleanup→remount, so the
 * MapView create-once effect fires TWICE. The leak invariant is NOT "created
 * exactly once" (the cumulative create count legitimately reaches 2 under dev
 * StrictMode) but "exactly one LIVE instance": the first ol/Map must be disposed
 * in cleanup before the second is created, so net-live == created - disposed == 1.
 *
 * The prod leak.e2e.ts cannot prove this (StrictMode's double-invoke is a no-op
 * in the minified build), so this spec runs against the dev server (:5173) with
 * StrictMode active. It asserts BOTH:
 *   - the double-mount actually happened (data-map-instances == 2), and
 *   - no live map leaked (data-map-net-live == 1).
 */

const HUBS = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
];

const ROUTES = [
  {
    routeId: "MEM-ORD",
    fromHubId: "MEM",
    toHubId: "ORD",
    geometry: [
      [-90.049, 35.1495],
      [-87.6298, 41.8781],
    ],
  },
];

const BASE_SIM_MS = 1_000_000;

const ZERO_KPIS = {
  utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
  missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  baseline: {
    utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
    missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  },
};

function snapshotMessage(): string {
  return JSON.stringify({
    v: 1,
    type: "snapshot",
    seq: 1,
    simMs: BASE_SIM_MS,
    payload: {
      trailers: [
        {
          id: "T-1",
          routeId: "MEM-ORD",
          departMs: BASE_SIM_MS,
          etaMs: BASE_SIM_MS + 3_600_000,
          state: "onTime",
        },
      ],
      hubs: HUBS.map((h) => ({
        id: h.hubId,
        volumeBucket: 0,
        slaRiskBucket: 0,
        congestionBucket: 0,
      })),
      routes: ROUTES.map((r) => ({
        id: r.routeId,
        loadBucket: 0,
        slaRiskBucket: 0,
      })),
      kpis: ZERO_KPIS,
      exceptionsOpen: [],
    },
  });
}

test.describe("MapView leak guard under StrictMode double-mount (M-6)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/hubs", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HUBS) });
    });
    await page.route("**/api/routes", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ROUTES) });
    });
  });

  test("dev StrictMode double-mounts the map but keeps exactly one LIVE instance", async ({
    page,
  }) => {
    await page.routeWebSocket(/\/api\/ws$/, (ws: WebSocketRoute) => {
      ws.send(snapshotMessage());
    });

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // The dev StrictMode mount→cleanup→remount runs the create effect TWICE, so
    // the cumulative created count settles at 2 (proving the double-mount fired).
    await expect(mapEl).toHaveAttribute("data-map-instances", "2");
    await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "2");

    // ...but the first map was disposed before the second was created, so the
    // NET-LIVE count is exactly 1 — no leaked map. This is the real invariant.
    await expect(mapEl).toHaveAttribute("data-map-net-live", "1");

    // Live trailer updates still flow on the surviving instance.
    await expect
      .poll(async () => Number(await mapEl.getAttribute("data-snapshot-count")), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect(mapEl).toHaveAttribute("data-trailer-count", "1");
  });
});
