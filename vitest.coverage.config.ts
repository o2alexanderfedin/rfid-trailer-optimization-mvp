import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/**
 * ISOLATED coverage config — used ONLY by `pnpm coverage`. The production gate
 * (`pnpm test` / `pnpm test:all`, via `vitest.config.ts`) is intentionally left
 * untouched: it runs against the built `dist` outputs.
 *
 * Why this exists — HONEST cross-package coverage:
 *   The workspace packages export `dist` (`@mm/x -> packages/x/dist/index.js`),
 *   so when an integration test exercises another package's code (e.g. the API
 *   driver calling `applyInline`/`runCatchup` in `@mm/projections`), that code
 *   runs from `dist` under a `node_modules` symlink. V8 coverage does NOT credit
 *   `node_modules`-resolved execution back to `src`, so heavily-integration-
 *   tested code (the projection runner, the event store) was reported at ~0-50%
 *   despite being thoroughly exercised — a measurement artifact, not a real gap.
 *
 *   Fix: alias every `@mm/*` to its `src` entry for the coverage run, so all
 *   first-party code executes as instrumented source and is credited correctly.
 *   All `@mm/*` imports are barrel-only, so a flat alias map is sufficient.
 *
 * Web coverage (test-coverage-90): the `ui` (jsdom) and `browser` (Playwright/
 * Chromium) projects are included here so the web src `.ts`/`.tsx` files are
 * measured. The `@mm/*`→src alias applies to them too, so `@mm/api` wire types
 * the web layer imports resolve to instrumented source.
 */

const pkgSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const mmAlias: Record<string, string> = {
  "@mm/domain": pkgSrc("domain"),
  "@mm/event-store": pkgSrc("event-store"),
  "@mm/projections": pkgSrc("projections"),
  "@mm/simulation": pkgSrc("simulation"),
  "@mm/aggregation": pkgSrc("aggregation"),
  "@mm/load-planner": pkgSrc("load-planner"),
  "@mm/sensor-fusion": pkgSrc("sensor-fusion"),
  "@mm/optimizer": pkgSrc("optimizer"),
  "@mm/api": pkgSrc("api"),
};

export default defineConfig({
  resolve: { alias: mmAlias },
  test: {
    projects: [
      {
        resolve: { alias: mmAlias },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
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
        resolve: { alias: mmAlias },
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
        resolve: { alias: mmAlias },
        test: {
          name: "ui",
          include: [
            "packages/web/src/**/*.test.tsx",
            "packages/web/test/**/*.test.tsx",
            "packages/web/src/api/*.test.ts",
          ],
          exclude: ["**/*.browser.test.tsx", "**/node_modules/**", "**/dist/**"],
          environment: "jsdom",
          setupFiles: ["packages/web/test/setup/jsdom.setup.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: mmAlias },
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
    coverage: {
      enabled: true,
      provider: "v8",
      // Vitest 4 removed the `all` flag; with the v8 provider, every file
      // matched by `include` is reported (untested files at 0%) by default —
      // so the web src `.tsx`/`.ts` files still show even with no test hitting
      // them. The `include` glob below is the single knob that scopes coverage.
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
