import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Three browser projects:
 *
 *  - `chromium` (PROD)    : `vite preview` serves the built/minified bundle on
 *    :4173, where React StrictMode's double-invoke is a no-op. Runs all
 *    `*.e2e.ts` EXCEPT `strictmode.e2e.ts` and `soak.e2e.ts`.
 *
 *  - `chromium-dev` (DEV) : `vite dev` serves the un-minified app on :5173 with
 *    React StrictMode ACTIVE (mount→cleanup→remount). Runs ONLY
 *    `strictmode.e2e.ts`, which verifies the OL Map leak guard survives the dev
 *    double-mount (M-6) — the place it actually matters.
 *
 *  - `chromium-soak` (SOAK) : same as `chromium` (prod build) but with
 *    Chromium launched with `--enable-precise-memory-info` and
 *    `--js-flags=--expose-gc` so `performance.memory.usedJSHeapSize` is
 *    precise and `globalThis.gc()` is callable to force collection before each
 *    measurement. Runs ONLY `soak.e2e.ts` (KEYSTONE (a)). Long timeout.
 *    Run on-demand / nightly, not per-PR (too slow for CI).
 *
 *  - `chromium-real` (F-08) : THE one real web↔server e2e. NO stubbed
 *    boundaries — the browser drives the prod bundle on :4273 (its own
 *    `vite.preview-real.config.ts` preview, whose `preview.proxy` forwards
 *    `/api/*` to the REAL Fastify booted in `globalSetup`). Runs ONLY
 *    `real-e2e.e2e.ts`. Requires Docker (testcontainers PG), so the heavy
 *    backend boot in `globalSetup` is GATED on `MM_E2E_REAL=1` /
 *    `--project=chromium-real` — the fast hermetic projects above need no Docker.
 *
 * Both prod and dev webServers boot; Playwright routes each project to its own
 * `baseURL`. `globalSetup`/`globalTeardown` boot+stop the real backend, but only
 * when the real project is selected (see real-e2e.globalSetup.ts gating).
 *
 * Note on `--expose-gc`: this flag is required to call `globalThis.gc()` from
 * inside `page.evaluate()`. Without it, GC is lazy and the heap measurement
 * after a potential leak may look flat (lazy GC masks the leak). See Q5 in
 * 05-RESEARCH.md for the full rationale.
 */

/**
 * The real web<->server project (chromium-real) + its proxy webServer are
 * included ONLY when explicitly requested (MM_E2E_REAL=1 or --project=chromium-real),
 * matching the globalSetup gating — so the bare `test:e2e` (hermetic) run needs no
 * Docker and never runs real-e2e.e2e.ts against an un-booted backend.
 */
const realE2E =
  process.env.MM_E2E_REAL === "1" ||
  process.argv.some((a) => a.includes("chromium-real"));

export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  // Boot the REAL backend before the run and tear it down after. The boot is
  // GATED inside these hooks (MM_E2E_REAL=1 / --project=chromium-real) so the
  // fast hermetic projects pay no Docker cost.
  globalSetup: "./test/real-e2e.globalSetup.ts",
  globalTeardown: "./test/real-e2e.globalTeardown.ts",
  use: {
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      testMatch: /.*\.e2e\.ts$/,
      // Exclude the dev-only, soak-only, and real-path specs from the fast suite.
      testIgnore: [
        /strictmode\.e2e\.ts$/,
        /soak\.e2e\.ts$/,
        /real-e2e\.e2e\.ts$/,
      ],
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4173" },
    },
    {
      name: "chromium-dev",
      testMatch: /strictmode\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5173" },
    },
    {
      name: "chromium-soak",
      testMatch: /soak\.e2e\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:4173",
        // Required for `performance.memory.usedJSHeapSize` to be precise and
        // for `globalThis.gc()` to be callable in page.evaluate() (Q5 / P10).
        launchOptions: {
          args: [
            "--enable-precise-memory-info",
            "--js-flags=--expose-gc",
          ],
        },
      },
    },
    // F-08: the one real web↔server e2e. Included ONLY when explicitly requested
    // (realE2E) so the hermetic suite never runs it against an un-booted backend.
    ...(realE2E
      ? [
          {
            name: "chromium-real",
            testMatch: /real-e2e\.e2e\.ts$/,
            use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4273" },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: "pnpm build && pnpm preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // `vite dev` keeps React StrictMode's intentional double-invoke (M-6).
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // F-08: prod bundle + the `/api`→real-Fastify proxy preview on :4273. Only
    // booted when the real project is selected (realE2E).
    ...(realE2E
      ? [
          {
            command: "pnpm build && pnpm preview:real",
            url: "http://localhost:4273",
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ]
      : []),
  ],
});
