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
