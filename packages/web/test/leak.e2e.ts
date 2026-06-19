import { expect, test } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

/**
 * VIZ-01 leak-guard e2e (Task 2): trailer points are driven LIVE by ws
 * snapshots and update IN PLACE on a single reused vector source.
 *
 * The driving guarantee (PITFALLS P10 / threat T-01-24): across MANY snapshot
 * updates the trailer source feature count stays equal to the trailer count
 * (never grows per tick), and neither the `ol/Map` nor the trailer
 * `VectorSource` is recreated — only feature geometry mutates.
 *
 * Everything is stubbed at the network boundary (hermetic, no API/DB/sim):
 *  - `GET /api/hubs` / `GET /api/routes` -> small fixed geo.
 *  - `/ws` -> a stub that pushes N snapshots moving a FIXED set of trailers.
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

/** A fixed fleet — the same three trailer ids appear in EVERY snapshot. */
const TRAILER_IDS = ["T-1", "T-2", "T-3"] as const;
const SNAPSHOT_COUNT = 40;

/** Build snapshot #n: the same 3 trailers, each nudged along the MEM->ORD leg. */
function snapshotMessage(n: number): string {
  const frac = (n % 20) / 20; // 0..1 cycling, so points move but stay bounded
  const lon = -90.049 + (-87.6298 - -90.049) * frac;
  const lat = 35.1495 + (41.8781 - 35.1495) * frac;
  return JSON.stringify({
    t: "snapshot",
    hubs: HUBS.map((h) => ({
      hubId: h.hubId,
      name: h.name,
      lon: h.lon,
      lat: h.lat,
    })),
    trailers: TRAILER_IDS.map((trailerId, i) => ({
      trailerId,
      tripId: `trip-${trailerId}`,
      kind: "depart",
      lon: lon + i * 0.2,
      lat: lat + i * 0.2,
      t: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    })),
  });
}

test.describe("MapView leak guard (VIZ-01)", () => {
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
  });

  test("trailers update in place across many ws snapshots — bounded feature count", async ({
    page,
  }) => {
    // The stub server pushes N snapshots, one per animation frame interval.
    await page.routeWebSocket(/\/api\/ws$/, (ws: WebSocketRoute) => {
      let n = 0;
      // Push an initial snapshot immediately so the map paints trailers.
      ws.send(snapshotMessage(n));
      const timer = setInterval(() => {
        n += 1;
        ws.send(snapshotMessage(n));
        if (n >= SNAPSHOT_COUNT) clearInterval(timer);
      }, 20);
      ws.onClose(() => clearInterval(timer));
    });

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // Trailers appear and the source stabilizes at exactly the fleet size.
    await expect(mapEl).toHaveAttribute(
      "data-trailer-count",
      String(TRAILER_IDS.length),
    );

    // Capture the OL uid of a stable trailer feature EARLY. If updates recreated
    // features (instead of mutating them in place) this uid would change.
    const earlyUid = await mapEl.getAttribute("data-trailer-uid");
    expect(earlyUid).not.toBeNull();

    // Wait until MANY snapshots have been processed (proves live updates).
    await expect
      .poll(
        async () =>
          Number(await mapEl.getAttribute("data-snapshot-count")),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(SNAPSHOT_COUNT);

    // LEAK GUARD: after all those updates the feature count is STILL the fleet
    // size (in-place geometry updates, never source growth).
    await expect(mapEl).toHaveAttribute(
      "data-trailer-count",
      String(TRAILER_IDS.length),
    );

    // The map + the trailer source were each created EXACTLY ONCE — never
    // rebuilt per tick (no source/layer churn).
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");
    await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "1");

    // In-place mutation proof: the SAME trailer feature object persisted across
    // all N snapshots (its OL uid is unchanged) — features were never recreated.
    await expect(mapEl).toHaveAttribute("data-trailer-uid", earlyUid ?? "");
  });
});
