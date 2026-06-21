import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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

const projectExclude = ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"];

export default defineConfig({
  resolve: { alias: mmAlias },
  test: {
    projects: [
      {
        resolve: { alias: mmAlias },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          exclude: projectExclude,
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
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      all: true,
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
