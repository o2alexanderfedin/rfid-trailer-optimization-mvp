import { expect, test } from "@playwright/test";

/**
 * VIZ-01 static-map e2e (Task 1): the OpenLayers + OSM map renders the USA
 * basemap, ALL hub markers from `GET /api/hubs`, and ALL route LineStrings from
 * `GET /api/routes`.
 *
 * The HTTP + ws boundaries are stubbed at the network level so the test is
 * hermetic (no API/DB/sim needed):
 *  - `GET /api/hubs`   -> a small fixed set of USA hubs.
 *  - `GET /api/routes` -> a small fixed set of routes (LineString geometries).
 *  - the `/ws` snapshot channel is stubbed so the app's ws hook connects
 *    cleanly but emits no trailers (trailers are covered by leak.e2e.ts).
 *
 * The map container exposes bounded feature counts via `data-*` attributes so
 * the e2e asserts render + leak discipline without reaching into OL internals.
 */

const HUBS = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { hubId: "DFW", name: "Dallas-Fort Worth", lat: 32.7767, lon: -96.797 },
  { hubId: "ATL", name: "Atlanta", lat: 33.749, lon: -84.388 },
  { hubId: "LAX", name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
];

const ROUTES = [
  {
    routeId: "MEM-ORD",
    fromHubId: "MEM",
    toHubId: "ORD",
    geometry: [
      [-90.049, 35.1495],
      [-88.8, 38.5],
      [-87.6298, 41.8781],
    ],
  },
  {
    routeId: "MEM-DFW",
    fromHubId: "MEM",
    toHubId: "DFW",
    geometry: [
      [-90.049, 35.1495],
      [-93.4, 33.9],
      [-96.797, 32.7767],
    ],
  },
  {
    routeId: "MEM-ATL",
    fromHubId: "MEM",
    toHubId: "ATL",
    geometry: [
      [-90.049, 35.1495],
      [-87.2, 34.4],
      [-84.388, 33.749],
    ],
  },
  {
    routeId: "MEM-LAX",
    fromHubId: "MEM",
    toHubId: "LAX",
    geometry: [
      [-90.049, 35.1495],
      [-104.0, 34.6],
      [-118.2437, 34.0522],
    ],
  },
];

test.describe("MapView static layers (VIZ-01)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/hubs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HUBS),
      });
    });
    await page.route("**/api/routes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ROUTES),
      });
    });
    // Stub the ws channel: connect cleanly, emit nothing (no trailers here).
    await page.routeWebSocket(/\/api\/ws$/, () => {
      /* keep the socket open with zero messages */
    });
  });

  test("renders OSM basemap + all hub markers + all route lines", async ({
    page,
  }) => {
    const osmRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("tile.openstreetmap.org")) {
        osmRequests.push(req.url());
      }
    });

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // All hubs render as Point features on the single reused hub source.
    await expect(mapEl).toHaveAttribute(
      "data-hub-count",
      String(HUBS.length),
    );
    // All routes render as LineString features on the single route source.
    await expect(mapEl).toHaveAttribute(
      "data-route-count",
      String(ROUTES.length),
    );

    // The OSM basemap tiles were fetched over HTTPS from openstreetmap.org.
    await expect.poll(() => osmRequests.length).toBeGreaterThan(0);
    expect(osmRequests.every((u) => u.startsWith("https://"))).toBe(true);

    // The map is created exactly once.
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");

    // No leak on re-layout: counts are stable on the SAME single sources.
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(300);
    await expect(mapEl).toHaveAttribute("data-hub-count", String(HUBS.length));
    await expect(mapEl).toHaveAttribute(
      "data-route-count",
      String(ROUTES.length),
    );
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");
  });
});
