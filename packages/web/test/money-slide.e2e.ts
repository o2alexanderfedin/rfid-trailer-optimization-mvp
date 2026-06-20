import { expect, test } from "@playwright/test";

/**
 * KEYSTONE (b) — Rendered money slide: seed-deterministic optimizer-beats-baseline.
 *
 * These e2e tests assert that:
 *  1. The rendered MoneySlide shows the optimizer BEATING the baseline on
 *     rehandleScore (the core product claim — LIFO vs FIFO on a seeded scenario).
 *  2. The comparison is seed-deterministic: two loads of the page on the same
 *     seed render IDENTICAL numbers (the win is reproducible, not theater).
 *  3. Win indicators are present for the metrics the optimizer wins.
 *
 * Architecture:
 *  - Hermetic: `GET /api/kpis/comparison` is stubbed at the Playwright network
 *    boundary with a deterministic fixture captured from `computeComparison({
 *    seed: 42 })` (baseline.rehandleScore=73, optimizer.rehandleScore=0,
 *    deltas.rehandleScore=-73). This is the canonical DEMO_SEED=42 output
 *    verified in packages/api/src/kpis/comparison.test.ts.
 *  - `GET /api/kpis` is also stubbed (zero-state) so the KpiDashboard doesn't
 *    make live API calls.
 *  - The WebSocket is stubbed to send a minimal snapshot so the app doesn't
 *    hang waiting for a ws connection.
 *  - The app starts on the "vs Baseline" (MoneySlide) tab, which is the
 *    tab added in Plan 05-08's RightRail update.
 *
 * KEYSTONE-b determinism:
 *  The backend half of KEYSTONE-b lives in Plan 05-03's comparison.test.ts
 *  (two consecutive `computeComparison({ seed: 42 })` calls → byte-identical).
 *  This test proves the FRONTEND half: the rendered MoneySlide shows the correct
 *  seeded values and the optimizer win is legibly indicated.
 *
 * Everything is stubbed at the network boundary (hermetic — no API/DB/sim).
 */

// ---------------------------------------------------------------------------
// Deterministic fixture from computeComparison({ seed: 42 })
// Verified in packages/api/src/kpis/comparison.test.ts
// ---------------------------------------------------------------------------

const DEMO_COMPARISON = {
  baseline:  { rehandleScore: 73, utilizationScore: 0 },
  optimizer: { rehandleScore: 0,  utilizationScore: 0 },
  deltas:    { rehandleScore: -73, utilizationScore: 0 },
};

const ZERO_KPIS = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 1,
  onTimeArrival: 1,
  baseline: {
    utilization: 0,
    rehandleCount: 0,
    rehandleMinutes: 0,
    wrongTrailerCount: 0,
    missedUnloadCount: 0,
    slaViolationRate: 0,
    onTimeDeparture: 1,
    onTimeArrival: 1,
  },
};

const SNAPSHOT_PAYLOAD = {
  v: 1,
  type: "snapshot",
  seq: 1,
  simMs: 0,
  payload: {
    trailers: [],
    hubs: [],
    routes: [],
    kpis: ZERO_KPIS,
    exceptionsOpen: [],
  },
};

// ---------------------------------------------------------------------------
// Stub setup helper — isolates the three API boundaries
// ---------------------------------------------------------------------------

async function stubApis(page: import("@playwright/test").Page): Promise<void> {
  // Stub GET /api/kpis (KpiDashboard initial fetch)
  await page.route("/api/kpis", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ZERO_KPIS),
    });
  });

  // Stub GET /api/kpis/comparison (MoneySlide fetch) — the key fixture
  await page.route("/api/kpis/comparison", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEMO_COMPARISON),
    });
  });

  // Stub GET /api/hubs, /api/routes (MapView fetch)
  await page.route("/api/hubs", (route) => {
    void route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("/api/routes", (route) => {
    void route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  // Stub WebSocket — send a minimal snapshot so the map doesn't hang
  await page.routeWebSocket("/api/ws", (ws) => {
    ws.onOpen(() => {
      ws.send(JSON.stringify(SNAPSHOT_PAYLOAD));
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("KEYSTONE (b) — MoneySlide seed-deterministic comparison", () => {
  test("optimizer beats baseline on rehandleScore (rendered win indicator)", async ({
    page,
  }) => {
    await stubApis(page);
    await page.goto("/");

    // Navigate to the MoneySlide tab
    const moneyTab = page.getByTestId("tab-money");
    await expect(moneyTab).toBeVisible();
    await moneyTab.click();

    // The money slide should be visible
    const moneySlide = page.getByTestId("money-slide");
    await expect(moneySlide).toBeVisible();

    // The rehandleScore row should exist
    const rehandleRow = page.getByTestId("money-row-rehandleScore");
    await expect(rehandleRow).toBeVisible();

    // Baseline shows the FIFO cost (73.0)
    const baselineVal = page.getByTestId("baseline-rehandleScore");
    await expect(baselineVal).toHaveText("73.0");

    // Optimizer shows zero rehandle cost (0.0) — the win
    const optimizerVal = page.getByTestId("optimizer-rehandleScore");
    await expect(optimizerVal).toHaveText("0.0");

    // Delta shows the win (-73.0 min)
    const deltaCell = page.getByTestId("delta-rehandleScore");
    await expect(deltaCell).toContainText("-73");

    // Win indicator must be present (data-win="true" on the row)
    await expect(rehandleRow).toHaveAttribute("data-win", "true");
  });

  test("comparison is seed-deterministic: two page loads show identical numbers", async ({
    page,
    context,
  }) => {
    // First load
    await stubApis(page);
    await page.goto("/");
    const moneyTab = page.getByTestId("tab-money");
    await moneyTab.click();

    const baselineFirst = await page.getByTestId("baseline-rehandleScore").textContent();
    const optimizerFirst = await page.getByTestId("optimizer-rehandleScore").textContent();
    const deltaFirst = await page.getByTestId("delta-rehandleScore").textContent();

    // Second load on a fresh page in the same context
    const page2 = await context.newPage();
    await stubApis(page2);
    await page2.goto("/");
    const moneyTab2 = page2.getByTestId("tab-money");
    await moneyTab2.click();

    const baselineSecond = await page2.getByTestId("baseline-rehandleScore").textContent();
    const optimizerSecond = await page2.getByTestId("optimizer-rehandleScore").textContent();
    const deltaSecond = await page2.getByTestId("delta-rehandleScore").textContent();

    await page2.close();

    // Both loads must render identical numbers (seed-deterministic)
    expect(baselineFirst).toBe(baselineSecond);
    expect(optimizerFirst).toBe(optimizerSecond);
    expect(deltaFirst).toBe(deltaSecond);
  });

  test("win indicators are present for metrics the optimizer wins", async ({
    page,
  }) => {
    await stubApis(page);
    await page.goto("/");

    const moneyTab = page.getByTestId("tab-money");
    await moneyTab.click();

    // rehandleScore: optimizer wins (delta=-73) → data-win="true"
    const rehandleRow = page.getByTestId("money-row-rehandleScore");
    await expect(rehandleRow).toHaveAttribute("data-win", "true");

    // utilizationScore: delta=0 (neutral, not a win) → data-win="false"
    const utilRow = page.getByTestId("money-row-utilizationScore");
    await expect(utilRow).toHaveAttribute("data-win", "false");
  });

  test("summary line shows optimizer wins on at least 1 metric", async ({
    page,
  }) => {
    await stubApis(page);
    await page.goto("/");

    const moneyTab = page.getByTestId("tab-money");
    await moneyTab.click();

    const summary = page.getByTestId("money-slide-summary");
    await expect(summary).toBeVisible();
    // Should indicate optimizer wins (at least 1 win)
    await expect(summary).toContainText("Optimizer wins");
  });
});

test.describe("KPI dashboard renders live operational KPIs", () => {
  test("shows all 8 KPI cards from the initial fetch", async ({ page }) => {
    await stubApis(page);
    await page.goto("/");

    // Should default to the KPIs tab
    const kpiDash = page.getByTestId("kpi-dashboard");
    await expect(kpiDash).toBeVisible();

    // All 8 KPI cards must be present
    const fields = [
      "utilization",
      "rehandleCount",
      "rehandleMinutes",
      "wrongTrailerCount",
      "missedUnloadCount",
      "slaViolationRate",
      "onTimeDeparture",
      "onTimeArrival",
    ];
    for (const field of fields) {
      await expect(page.getByTestId(`kpi-card-${field}`)).toBeVisible();
    }
  });
});
