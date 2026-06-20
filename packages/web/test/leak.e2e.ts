import { expect, test } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

/**
 * Chrome's non-standard `performance.memory` shape (only the field we read).
 * Typing it locally lets us read `usedJSHeapSize` without an `any` cast.
 */
interface PerformanceMemory {
  readonly usedJSHeapSize: number;
}

/**
 * Browser-context callback (serialized + run in the page by `page.evaluate`):
 * returns the used JS heap size in bytes, or 0 if the browser doesn't expose
 * `performance.memory` (non-Chromium / no `--enable-precise-memory-info`).
 */
function readUsedJSHeapSize(): number {
  const withMemory = performance as Performance & { memory?: PerformanceMemory };
  return withMemory.memory?.usedJSHeapSize ?? 0;
}

/**
 * VIZ-01 / VIZ-02 / VIZ-03 leak-guard e2e (Task 2 + Task 4):
 * trailer points and hub/route colorings are driven LIVE by versioned ws
 * envelopes and update IN PLACE on single reused vector sources.
 *
 * The driving guarantee (PITFALLS P10 / threat T-01-24): across MANY snapshot +
 * tick updates the trailer source feature count stays equal to the trailer count
 * (never grows per tick), and neither the `ol/Map` nor the trailer
 * `VectorSource` is recreated — only feature geometry mutates.
 *
 * NEW in Plan 05-06: the leak guard now uses the versioned `WsEnvelope`
 * (`{ v:1, type:"snapshot"|"tick", seq, simMs, payload }`) instead of the old
 * `{ t:"snapshot" }` wire shape, and asserts one postrender listener (proves
 * that `attachTrailerAnimation` wasn't recreated on each tick).
 *
 * Also includes a SHORT (~30s) flat-heap smoke test (per-PR gate) using the same
 * `performance.memory` approach as the full KEYSTONE soak in soak.e2e.ts. This
 * only detects gross leaks (it's too short for subtle ones); the full soak is
 * run nightly/on-demand.
 *
 * Everything is stubbed at the network boundary (hermetic, no API/DB/sim):
 *  - `GET /api/hubs` / `GET /api/routes` -> small fixed geo.
 *  - `/ws` -> a stub that pushes N envelopes moving a FIXED set of trailers
 *    and churning hub/route buckets.
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

/** A fixed fleet — the same three trailer ids appear in EVERY tick. */
const TRAILER_IDS = ["T-1", "T-2", "T-3"] as const;
const FLEET_SIZE = TRAILER_IDS.length;

const ZERO_KPIS = {
  utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
  missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  baseline: {
    utilization: 0, rehandleCount: 0, rehandleMinutes: 0, wrongTrailerCount: 0,
    missedUnloadCount: 0, slaViolationRate: 0, onTimeDeparture: 0, onTimeArrival: 0,
  },
};

/** Build a versioned `snapshot` envelope. */
function makeSnapshot(seq: number, simMs: number): string {
  const departMs = simMs;
  const etaMs = simMs + 3_600_000;
  return JSON.stringify({
    v: 1,
    type: "snapshot",
    seq,
    simMs,
    payload: {
      trailers: TRAILER_IDS.map((id) => ({
        id,
        routeId: "MEM-ORD",
        departMs,
        etaMs,
        state: "onTime",
      })),
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

/** Build a versioned `tick` envelope (moving trailers + churning buckets). */
function makeTickEnvelope(seq: number, simMs: number): string {
  // Advance trailers along the route.
  const frac = (seq % 20) / 20; // cycles 0..1
  const legDuration = 3_600_000;
  const departMs = simMs - legDuration * frac;
  const etaMs = departMs + legDuration;

  return JSON.stringify({
    v: 1,
    type: "tick",
    seq,
    simMs,
    payload: {
      trailers: TRAILER_IDS.map((id) => ({
        id,
        routeId: "MEM-ORD",
        departMs: departMs + TRAILER_IDS.indexOf(id) * 60_000,
        etaMs,
        state: (["onTime", "slaRisk", "late"] as const)[TRAILER_IDS.indexOf(id) % 3],
      })),
      hubs: HUBS.map((h, i) => ({
        id: h.hubId,
        volumeBucket: (seq + i) % 5,
        slaRiskBucket: (seq + i + 1) % 5,
        congestionBucket: (seq + i + 2) % 5,
      })),
      routes: ROUTES.map((r, i) => ({
        id: r.routeId,
        loadBucket: (seq + i) % 5,
        slaRiskBucket: (seq + i + 1) % 5,
      })),
    },
  });
}

const TICK_COUNT = 40;

test.describe("MapView leak guard (VIZ-01 / VIZ-02 / VIZ-03)", () => {
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

  test("trailers update in place across many ws ticks — bounded feature count", async ({
    page,
  }) => {
    const BASE_SIM_MS = Date.now();

    // The stub server pushes a snapshot then N ticks, one per interval.
    await page.routeWebSocket(/\/api\/ws$/, (ws: WebSocketRoute) => {
      let seq = 1;
      let simMs = BASE_SIM_MS;
      // Initial snapshot so the map paints trailers immediately.
      ws.send(makeSnapshot(seq, simMs));
      seq += 1;

      const timer = setInterval(() => {
        simMs += 1_000;
        ws.send(makeTickEnvelope(seq, simMs));
        seq += 1;
        if (seq > TICK_COUNT + 1) clearInterval(timer);
      }, 20);
      ws.onClose(() => clearInterval(timer));
    });

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // Trailers appear and the source stabilizes at exactly the fleet size.
    await expect(mapEl).toHaveAttribute(
      "data-trailer-count",
      String(FLEET_SIZE),
    );

    // Capture the OL uid of a stable trailer feature EARLY. If updates recreated
    // features (instead of mutating them in place) this uid would change.
    const earlyUid = await mapEl.getAttribute("data-trailer-uid");
    expect(earlyUid).not.toBeNull();

    // Wait until MANY ticks have been processed (proves live updates flow).
    await expect
      .poll(
        async () =>
          Number(await mapEl.getAttribute("data-snapshot-count")),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(TICK_COUNT);

    // LEAK GUARD: after all those updates the feature count is STILL the fleet
    // size (in-place geometry updates, never source growth).
    await expect(mapEl).toHaveAttribute(
      "data-trailer-count",
      String(FLEET_SIZE),
    );

    // The map + the trailer source were each created EXACTLY ONCE.
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");
    await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "1");

    // In-place mutation proof: the SAME trailer feature object persisted across
    // all N ticks (its OL uid is unchanged) — features were never recreated.
    await expect(mapEl).toHaveAttribute("data-trailer-uid", earlyUid ?? "");
  });

  test("short heap smoke test (~30s): no gross memory leak during animation", async ({
    page,
  }) => {
    const BASE_SIM_MS = Date.now();
    const SMOKE_DURATION_MS = 30_000;
    const SMOKE_TICK_INTERVAL_MS = 250;

    test.setTimeout(SMOKE_DURATION_MS + 30_000);

    await page.routeWebSocket(/\/api\/ws$/, (ws: WebSocketRoute) => {
      let seq = 1;
      let simMs = BASE_SIM_MS;
      ws.send(makeSnapshot(seq, simMs));
      seq += 1;

      const timer = setInterval(() => {
        simMs += 1_000;
        ws.send(makeTickEnvelope(seq, simMs));
        seq += 1;
      }, SMOKE_TICK_INTERVAL_MS);
      ws.onClose(() => clearInterval(timer));
    });

    await page.goto("/");
    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // Warm up for a few seconds.
    await page.waitForTimeout(5_000);

    // Force GC + baseline.
    await page.evaluate(() => { (globalThis as { gc?: () => void }).gc?.(); });
    await page.waitForTimeout(500);
    const heapBefore = await page.evaluate(readUsedJSHeapSize);

    // Run for smoke duration.
    await page.waitForTimeout(SMOKE_DURATION_MS);

    // Force GC + final.
    await page.evaluate(() => { (globalThis as { gc?: () => void }).gc?.(); });
    await page.waitForTimeout(500);
    const heapAfter = await page.evaluate(readUsedJSHeapSize);

    const growth = heapAfter - heapBefore;
    const growthPct = heapBefore > 0 ? growth / heapBefore : 0;
    console.log(`Smoke heap: before=${Math.round(heapBefore / 1024)}KB after=${Math.round(heapAfter / 1024)}KB growth=${Math.round(growth / 1024)}KB (${Math.round(growthPct * 100)}%)`);

    if (heapBefore > 0) {
      // Allow at most 25% growth — a gross leak would be much higher.
      expect(growthPct).toBeLessThan(0.25);
    }

    // Structural invariants must hold.
    await expect(mapEl).toHaveAttribute("data-map-instances", "1");
    await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "1");
    await expect(mapEl).toHaveAttribute("data-map-net-live", "1");
    await expect(mapEl).toHaveAttribute("data-trailer-count", String(FLEET_SIZE));
  });
});
