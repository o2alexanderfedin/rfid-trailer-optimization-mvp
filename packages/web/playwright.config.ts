import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Two browser projects against two builds of the same app:
 *
 *  - `chromium` (PROD)  : `vite preview` serves the built/minified bundle on
 *    :4173, where React StrictMode's double-invoke is a no-op. Runs every
 *    `*.e2e.ts` EXCEPT the StrictMode-specific spec.
 *  - `chromium-dev` (DEV): `vite dev` serves the un-minified app on :5173 with
 *    React StrictMode ACTIVE (mount→cleanup→remount). Runs ONLY
 *    `strictmode.e2e.ts`, which verifies the OL Map leak guard survives the dev
 *    double-mount (M-6) — the place it actually matters.
 *
 * Both webServers boot; Playwright routes each project to its own `baseURL`.
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
      testIgnore: /strictmode\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4173" },
    },
    {
      name: "chromium-dev",
      testMatch: /strictmode\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5173" },
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
