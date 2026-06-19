import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint 9 flat config. The hard constraint: NO `any`.
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
);
