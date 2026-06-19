import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Builds nothing here; assumes `vite preview` serves the built app
 * on :4173. The webServer block builds + previews automatically.
 */
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
