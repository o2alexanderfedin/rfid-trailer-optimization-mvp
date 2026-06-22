/**
 * F-08 — THE keystone real web↔server e2e (no stubbed boundaries).
 *
 * Every other `*.e2e.ts` in this package stubs `/api/*` (page.route) and the ws
 * channel (routeWebSocket), so no browser ever exercises the real
 * web → Fastify → projection → Postgres chain. This spec closes that gap:
 *
 *   - NO `page.route`. NO `page.routeWebSocket`. Every request hits the REAL
 *     Fastify server booted in `real-e2e.globalSetup.ts`.
 *   - The web bundle (served by `vite preview` on :4273) talks same-origin
 *     `/api/*`; `vite.preview-real.config.ts`'s `preview.proxy` strips the
 *     `/api` prefix and forwards to the real server (routes at ROOT), including
 *     the `/api/ws` upgrade.
 *
 * Three assertions — the live-path gates:
 *
 *   (A) The map renders the REAL hubs + routes. `data-hub-count` on the map
 *       element is cross-checked against a DIRECT `GET /hubs` to the real API
 *       (not a stub) — proving the browser fetched live data over the proxy.
 *
 *   (B) The KPI panel's `kpi-value-wrongTrailerCount` polls > 0 — the live
 *       projection pipeline produced a non-zero wrong-trailer KPI from the
 *       driven sim (DEMO_RFID_CONFIG, seed 4242, 120 ticks).
 *
 *   (C) The alert feed contains an entry `[data-kind="wrongTrailer"]` with the
 *       visible label "Wrong Trailer" — the F-01 end-to-end catcher: the
 *       exception travelled detector → projection → ws → React feed.
 *
 * RED proof (before `preview.proxy` exists): Test (A) FAILS because the
 * same-origin `GET /api/hubs` 404s at `vite preview` (no proxy) → the map never
 * gets hubs → `data-hub-count` stays "0" while the direct `GET /hubs` returns
 * the real count. That divergence proves the spec hits the live boundary.
 */
import { expect, test } from "@playwright/test";
import { realApiPort } from "./real-e2e.globalSetup.js";

// ws snapshot + projection settling can take a moment post-connect; be generous.
const POLL_TIMEOUT = 30_000;

/** The real API base (routes at ROOT — no `/api` prefix). */
function realApiBase(): string {
  return `http://127.0.0.1:${realApiPort()}`;
}

test.describe("F-08 — real web↔server e2e (no stubbed boundaries)", () => {
  test("(A) map renders REAL hubs + routes (cross-checked vs direct GET /hubs)", async ({
    page,
    request,
  }) => {
    // Direct hit on the REAL API (routes at ROOT) — the source of truth.
    const apiRes = await request.get(`${realApiBase()}/hubs`);
    expect(apiRes.ok()).toBe(true);
    const hubs = (await apiRes.json()) as ReadonlyArray<unknown>;
    const realHubCount = hubs.length;
    expect(
      realHubCount,
      "the real API must seed ≥1 hub for the map cross-check",
    ).toBeGreaterThan(0);

    await page.goto("/");

    const mapEl = page.getByTestId("map");
    await expect(mapEl).toBeVisible();

    // The browser's same-origin `GET /api/hubs` (proxied to the real `/hubs`)
    // must land EXACTLY the real hub count on the map. WITHOUT the proxy this
    // 404s and `data-hub-count` stays "0" → RED proof.
    await expect
      .poll(async () => mapEl.getAttribute("data-hub-count"), {
        timeout: POLL_TIMEOUT,
      })
      .toBe(String(realHubCount));

    // Routes must render too (non-zero) — proves `GET /api/routes` is also live.
    await expect
      .poll(
        async () => {
          const raw = await mapEl.getAttribute("data-route-count");
          return raw === null ? 0 : Number.parseInt(raw, 10);
        },
        { timeout: POLL_TIMEOUT },
      )
      .toBeGreaterThan(0);
  });

  test("(B) KPI panel wrongTrailerCount polls > 0 (live projection pipeline)", async ({
    page,
  }) => {
    await page.goto("/");

    const kpiValue = page.getByTestId("kpi-value-wrongTrailerCount");
    await expect(kpiValue).toBeVisible();

    // The KPI dashboard fetches `GET /api/kpis` on mount and re-fetches on every
    // ws envelope. After the driven sim, wrongTrailerCount must be > 0.
    await expect
      .poll(
        async () => {
          const text = (await kpiValue.textContent()) ?? "0";
          return Number.parseInt(text.replace(/[^0-9-]/g, ""), 10) || 0;
        },
        { timeout: POLL_TIMEOUT },
      )
      .toBeGreaterThan(0);
  });

  test('(C) alert feed shows a [data-kind="wrongTrailer"] entry labelled "Wrong Trailer" (F-01 catcher)', async ({
    page,
  }) => {
    await page.goto("/");

    // The alert feed is populated from the ws snapshot's `exceptionsOpen` and
    // subsequent tick deltas — the full detector → projection → ws → React path.
    const wrongTrailerEntry = page
      .locator('[data-testid="alert-feed-entry"][data-kind="wrongTrailer"]')
      .first();

    await expect(wrongTrailerEntry).toBeVisible({ timeout: POLL_TIMEOUT });
    await expect(wrongTrailerEntry).toContainText("Wrong Trailer");
  });
});
