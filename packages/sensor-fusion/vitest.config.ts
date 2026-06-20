import { defineConfig } from "vitest/config";

/**
 * Per-package Vitest config for `@mm/sensor-fusion`. Enables running the
 * package's tests in isolation via `pnpm --filter @mm/sensor-fusion test`
 * (the root `vitest.config.ts` projects still pick these files up for the
 * monorepo-wide `pnpm test` / `pnpm test:all`).
 *
 * This module is PURE and needs no Postgres/Testcontainers: every test here is
 * a fast, deterministic unit/property test.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
