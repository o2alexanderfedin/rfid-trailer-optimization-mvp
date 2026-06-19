import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. Two projects separate fast unit tests from
 * integration tests that require a real Postgres container (OrbStack).
 *
 *  - `unit`        : every `*.test.ts` EXCEPT `*.int.test.ts`
 *  - `integration` : only `*.int.test.ts` (longer timeout for Testcontainers)
 *
 * `pnpm test`      -> unit only            (vitest run --project unit)
 * `pnpm test:all`  -> unit + integration   (vitest run)
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
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
    ],
  },
});
