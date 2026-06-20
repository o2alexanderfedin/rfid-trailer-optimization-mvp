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
 * Both prod and dev webServers boot; Playwright routes each project to its own
 * `baseURL`.
 *
 * Note on `--expose-gc`: this flag is required to call `globalThis.gc()` from
 * inside `page.evaluate()`. Without it, GC is lazy and the heap measurement
 * after a potential leak may look flat (lazy GC masks the leak). See Q5 in
 * 05-RESEARCH.md for the full rationale.
 */
export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      testMatch: /.*\.e2e\.ts$/,
      testIgnore: [/strictmode\.e2e\.ts$/, /soak\.e2e\.ts$/],
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
  ],
});
