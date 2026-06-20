/**
 * KEYSTONE (a): multi-minute flat-memory soak (VIZ-02 / Q5 / P10).
 *
 * Proves that the animated, colored live map does NOT leak memory over a
 * prolonged run. Streams `tick` envelopes every ~250ms for ~2.5 minutes,
 * forces GC before and after, and asserts that heap growth is bounded
 * (after - before < before * 0.25).
 *
 * Also asserts structural invariants after the full run:
 *   - `data-map-instances == 1`         (map created once)
 *   - `data-trailer-source-instances == 1` (source created once)
 *   - `data-map-net-live == 1`          (no leaked live maps)
 *   - `data-trailer-count == FLEET_SIZE` (bounded feature count, not growing)
 *
 * Requires Chromium launched with `--enable-precise-memory-info` and
 * `--js-flags=--expose-gc` (see `playwright.config.ts` `soak` project).
 *
 * Per 05-RESEARCH.md Q5 open question 6: keep the full soak in a SEPARATE
 * slow suite (this file), run nightly/on-demand. A short ~30s flat-heap
 * smoke test is in `leak.e2e.ts` (per-PR).
 */
import { expect, test } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared geo fixtures
// ---------------------------------------------------------------------------

const HUBS = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { hubId: "DFW", name: "Dallas", lat: 32.7767, lon: -96.797 },
];

const ROUTES = [
  {
    routeId: "MEM-ORD",
    fromHubId: "MEM",
    toHubId: "ORD",
    geometry: [[-90.049, 35.1495], [-88.0, 38.5], [-87.6298, 41.8781]],
  },
  {
    routeId: "MEM-DFW",
    fromHubId: "MEM",
    toHubId: "DFW",
    geometry: [[-90.049, 35.1495], [-93.4, 33.9], [-96.797, 32.7767]],
  },
];

/** Fleet of trailers for the soak run. */
const FLEET = ["T-1", "T-2", "T-3", "T-4", "T-5"] as const;
const FLEET_SIZE = FLEET.length;

const ZERO_KPIS = {
  utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
  missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  baseline: {
    utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
    missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  },
};

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function snapshotEnvelope(seq: number, simMs: number): string {
  const routes = ROUTES.map((r) => ({ id: r.routeId, loadBucket: 0, slaRiskBucket: 0 }));
  const hubs = HUBS.map((h) => ({
    id: h.hubId, volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0,
  }));
  const trailers = FLEET.map((id) => ({
    id,
    routeId: "MEM-ORD",
    departMs: simMs,
    etaMs: simMs + 3_600_000, // 1 sim-hour leg
    state: "onTime" as const,
  }));
  return JSON.stringify({
    v: 1,
    type: "snapshot",
    seq,
    simMs,
    payload: {
      trailers,
      hubs,
      routes,
      kpis: ZERO_KPIS,
      exceptionsOpen: [],
    },
  });
}

/** Build a tick envelope with moving trailers and churning hub/route buckets. */
function tickEnvelope(seq: number, simMs: number): string {
  // Advance sim time: all trailers progress along their leg.
  const trailers = FLEET.map((id, i) => ({
    id,
    routeId: "MEM-ORD",
    departMs: simMs - 1_800_000 + i * 60_000,
    etaMs: simMs + 1_800_000,
    state: (["onTime", "slaRisk", "late", "idle"] as const)[i % 4],
  }));
  // Churn hub buckets (cycles 0→4).
  const hubs = HUBS.map((h, i) => ({
    id: h.hubId,
    volumeBucket: (seq + i) % 5,
    slaRiskBucket: (seq + i + 1) % 5,
    congestionBucket: (seq + i + 2) % 5,
  }));
  // Churn route buckets.
  const routes = ROUTES.map((r, i) => ({
    id: r.routeId,
    loadBucket: (seq + i) % 5,
    slaRiskBucket: (seq + i + 1) % 5,
  }));
  return JSON.stringify({
    v: 1,
    type: "tick",
    seq,
    simMs,
    payload: { trailers, hubs, routes },
  });
}

// ---------------------------------------------------------------------------
// Soak test
// ---------------------------------------------------------------------------

// The soak runs for ~2.5 minutes = 150 seconds.
// 250ms per tick → ~600 ticks total.
const SOAK_DURATION_MS = 150_000;
const TICK_INTERVAL_MS = 250;
const WARMUP_MS = 10_000;

test.describe("KEYSTONE (a): flat-memory soak over multi-minute animated run", () => {
  test.setTimeout(SOAK_DURATION_MS + WARMUP_MS + 60_000); // extra 60s buffer

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

  test("heap stays flat after forced GC across the full animated run", async ({ page }) => {
    let tickCount = 0;
    let simMs = Date.now();

    await page.routeWebSocket(/\/api\/ws$/, (ws: WebSocketRoute) => {
      // Initial snapshot.
      ws.send(snapshotEnvelope(1, simMs));
      tickCount = 1;

      // Push a tick every TICK_INTERVAL_MS for the soak duration.
      const timer = setInterval(() => {
        if (tickCount > (SOAK_DURATION_MS + WARMUP_MS) / TICK_INTERVAL_MS + 50) {
          clearInterval(timer);
          return;
        }
        tickCount += 1;
        simMs += 1_000; // advance sim time by 1s per tick
        ws.send(tickEnvelope(tickCount, simMs));
      }, TICK_INTERVAL_MS);

      ws.onClose(() => clearInterval(timer));
    });

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // Wait for the initial snapshot + a few ticks to arrive.
    await expect
      .poll(
        async () => Number(await mapEl.getAttribute("data-snapshot-count")),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(5);

    // Trailers appear and settle at fleet size.
    await expect(mapEl).toHaveAttribute("data-trailer-count", String(FLEET_SIZE));

    // ---- Warm-up period: let the animation loop run for a bit ----
    await page.waitForTimeout(WARMUP_MS);

    // Force GC and take baseline heap measurement.
    await page.evaluate(() => { (globalThis as Record<string, unknown>)["gc"]?.(); });
    await page.waitForTimeout(500); // let GC settle
    const heapBefore = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): number => (performance as any).memory?.usedJSHeapSize ?? 0,
    );

    // ---- Main soak period: ~2.5 minutes of animation + ticks ----
    await page.waitForTimeout(SOAK_DURATION_MS);

    // Force GC and take final heap measurement.
    await page.evaluate(() => { (globalThis as Record<string, unknown>)["gc"]?.(); });
    await page.waitForTimeout(500); // let GC settle
    const heapAfter = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): number => (performance as any).memory?.usedJSHeapSize ?? 0,
    );

    // ---- Memory assertion: bounded growth (not monotonic climb) ----
    const growth = heapAfter - heapBefore;
    const growthPct = heapBefore > 0 ? growth / heapBefore : 0;

    console.log(`Soak heap: before=${Math.round(heapBefore / 1024)}KB after=${Math.round(heapAfter / 1024)}KB growth=${Math.round(growth / 1024)}KB (${Math.round(growthPct * 100)}%)`);

    if (heapBefore > 0) {
      // Allow at most 25% growth after forced GC — a monotonic leak would be much higher.
      expect(growthPct).toBeLessThan(0.25);
    }
    // If heapBefore == 0 (browser doesn't support performance.memory), skip the
    // assertion (the structural invariants below still run).

    // ---- Structural invariants must hold after the full soak ----
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");
    await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "1");
    await expect(mapEl).toHaveAttribute("data-map-net-live", "1");

    // Feature count must still equal fleet size (no unbounded source growth).
    await expect(mapEl).toHaveAttribute("data-trailer-count", String(FLEET_SIZE));
  });
});
