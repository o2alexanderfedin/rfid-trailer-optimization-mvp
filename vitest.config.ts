import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/**
 * Root Vitest config. Four projects:
 *
 *  - `unit`        : every `*.test.ts` EXCEPT `*.int.test.ts`        (node)
 *  - `integration` : only `*.int.test.ts` (real Postgres container)  (node)
 *  - `ui`          : web component `*.test.tsx` + fetch tests        (jsdom)
 *  - `browser`     : web `*.browser.test.tsx` (real OpenLayers)      (Playwright/Chromium)
 *
 * FILE ROUTING CONVENTION:
 *   `*.test.ts`          → `unit` (node, pure logic)
 *   `*.int.test.ts`      → `integration` (Testcontainers Postgres)
 *   `*.test.tsx`         → `ui` (jsdom, plain React panels + MSW fetch)
 *   `*.browser.test.tsx` → `browser` (real Chromium, OpenLayers map smoke)
 *
 * GATE COMPOSITION (deliberate):
 *   - `pnpm test`     → unit only.
 *   - `pnpm test:all` → unit + integration + ui (the jsdom UI lane is cheap, so
 *     it joins the per-PR gate; see the explicit --project list in package.json).
 *   - `browser` is NOT in the default gate (real Chromium launch is slow); it is
 *     runnable via `pnpm test:browser` and IS included in `pnpm coverage`.
 *     Both new projects are defined here so `--project ui|browser` resolves.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          // `packages/web/src/api/*.test.ts` is the MSW-backed fetch lane — it
          // belongs to the jsdom `ui` project, NOT the node `unit` lane.
          exclude: [
            "**/*.int.test.ts",
            "packages/web/src/api/*.test.ts",
            "**/node_modules/**",
            "**/dist/**",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "ui",
          include: [
            "packages/web/src/**/*.test.tsx",
            "packages/web/test/**/*.test.tsx",
            // Co-locate the MSW-backed fetch test (client.test.ts) in the jsdom
            // lane: it needs a DOM-ish fetch interception, not the node lane.
            "packages/web/src/api/*.test.ts",
          ],
          exclude: ["**/*.browser.test.tsx", "**/node_modules/**", "**/dist/**"],
          environment: "jsdom",
          setupFiles: ["packages/web/test/setup/jsdom.setup.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "browser",
          include: ["packages/web/src/**/*.browser.test.tsx"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          setupFiles: ["packages/web/test/setup/browser.setup.ts"],
          browser: {
            enabled: true,
            // Vitest 4 takes a provider FACTORY (not the "playwright" string).
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
