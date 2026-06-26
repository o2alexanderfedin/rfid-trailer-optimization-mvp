import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint 9 flat config (TypeScript). The hard constraint: NO `any`.
 * `@typescript-eslint/no-explicit-any` is set to "error" and we also
 * forbid the unsafe-`any` family so values cannot leak in untyped.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // Vendored git submodule (`@alexanderfedin/async-queue`) — third-party
      // code with its own toolchain; not part of our typed program. It is
      // runtime-plumbing-only and is barred from the deterministic core by a
      // dedicated `no-restricted-imports` rule (added when it is wired in
      // Phase 27), not by linting its own sources.
      "vendor/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "packages/web/dist/**",
      // MSW-generated service worker (vendored by `npx msw init public`) — not
      // part of the typed program; the browser test harness serves it as-is.
      "packages/web/public/mockServiceWorker.js",
      // Local, untracked tooling/agent caches (mirrors .gitignore) — never
      // part of the typed project, so the typed linter must not pick them up.
      "**/.remember/**",
      "**/.turbo/**",
      "**/.playwright-mcp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Single flat program covering every src + test file (noEmit), so typed
        // linting resolves all cross-package imports without depending on the
        // composite `tsc -b` build graph.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Config & test-tooling files run outside the typed program.
    files: ["**/*.config.ts", "**/*.config.js", "**/playwright.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Fully detach the config files from the typed project AND keep ESM parsing
    // so `import.meta` (used in vitest.coverage.config.ts) parses as a module,
    // not a script. Separate block so it merges over disableTypeChecked above.
    files: ["**/*.config.ts", "**/*.config.js", "**/playwright.config.ts"],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
        sourceType: "module",
      },
    },
  },
  {
    // Build-asset helper scripts (`scripts/*.mjs`) run OUTSIDE the typed program
    // (plain Node ESM, not part of any tsconfig). Detach them from typed linting
    // and parse as ESM so `import.meta` resolves — same treatment as config files.
    files: ["**/scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
        sourceType: "module",
      },
    },
  },
  {
    // Phase-24 DET-03 — THE OODA DECISION-CORE STATIC GUARD.
    //
    // The decentralized OODA decision core (`packages/simulation/src/ooda/**`) MUST
    // be a pure, synchronous, seeded leaf: NO wall-clock (`Date.now`), NO ambient
    // randomness (`Math.random`), NO async-queue plumbing, and NO database access
    // (`kysely`). Any of these silently entering the core breaks byte-identical
    // replay (the determinism keystone). This rule FAILS the lint on a violation —
    // the CI gate that makes T-24-11 (tampering) structurally caught, not merely
    // discouraged. Test siblings (`*.test.ts`) are excluded: they legitimately
    // import seed constants from the engine and assert on the core's purity.
    //
    // (This is the concrete realization of the `no-restricted-imports` intent noted
    // for the deterministic core at the top of this file; the async-queue plumbing
    // ban widens engine-side in Phase 27.)
    files: ["packages/simulation/src/ooda/**/*.ts"],
    ignores: ["packages/simulation/src/ooda/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "kysely",
              message:
                "DET-03: the OODA decision core must not touch the database. Read frozen observations only.",
            },
            {
              name: "@alexanderfedin/async-queue",
              message:
                "DET-03: async-queue is runtime plumbing only — the OODA decision core stays synchronous + pure (Pitfall 5).",
            },
          ],
          patterns: [
            {
              group: ["*async-queue*"],
              message:
                "DET-03: async-queue is runtime plumbing only — the OODA decision core stays synchronous + pure (Pitfall 5).",
            },
            {
              group: ["kysely/*", "*/kysely", "pg", "@mm/persistence", "*/persistence"],
              message:
                "DET-03: the OODA decision core must not touch the database/driver layer.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "DET-03: no Date.now() in the OODA decision core — read the frozen virtual-clock observation (Pitfall 6).",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "DET-03: no wall-clock `new Date()` in the OODA decision core — use the frozen virtual-clock observation (Pitfall 6).",
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "DET-03: no Math.random() in the OODA decision core — draw from the seeded per-agent substream (deriveAgentRng) (Pitfall 6).",
        },
      ],
    },
  },
  {
    // Vitest Browser Mode tests (`*.browser.test.tsx`) execute in a real browser
    // type universe — their `vitest-browser-react` `render()` result and the
    // `@vitest/browser` `expect.element`/locator augmentations are not part of
    // the node-typed flat program (`tsconfig.eslint.json` uses `types:["node"]`).
    // Run them un-type-checked (same treatment as config files) so the locator
    // chains don't trip the unsafe-`any` family — NO `any` enters product code.
    files: ["**/*.browser.test.tsx"],
    ...tseslint.configs.disableTypeChecked,
  },
);
