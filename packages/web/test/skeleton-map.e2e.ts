import { expect, test } from "@playwright/test";

/**
 * VIZ-01 web e2e: the map renders an OSM USA basemap and exactly one real hub
 * marker (Memphis) from /hubs, with NO vector-source leak across re-renders.
 *
 * The API is mocked at the network boundary so the e2e is hermetic (no DB):
 *   GET /api/hubs -> exactly the Memphis hub.
 */
const MEMPHIS = { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 };

test.describe("SkeletonMap (VIZ-01)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/hubs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([MEMPHIS]),
      });
    });
  });

  test("renders OSM tiles + exactly one Memphis hub marker, no leak", async ({ page }) => {
    const osmRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("tile.openstreetmap.org") || url.includes("/osm/")) {
        osmRequests.push(url);
      }
    });

    await page.goto("/");

    // The header reflects the single hub from the API.
    await expect(page.locator(".app__header")).toContainText("1 hub");

    // The map container exposes a bounded feature count == 1 (single source).
    const mapEl = page.getByTestId("map");
    await expect(mapEl).toHaveAttribute("data-hub-count", "1");

    // OSM basemap tiles were requested.
    await expect.poll(() => osmRequests.length).toBeGreaterThan(0);

    // No leak: re-trigger a re-render (resize) and confirm the feature count is
    // still exactly 1 on the SAME single vector source.
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(300);
    await expect(mapEl).toHaveAttribute("data-hub-count", "1");
  });
});
