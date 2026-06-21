/**
 * jsdom setup for the `ui` Vitest project (`*.test.tsx` + `client.test.ts`).
 *
 *  1. Registers `@testing-library/jest-dom` matchers (`toBeInTheDocument`, …).
 *  2. Starts the MSW node server before all tests, resets handlers between
 *     tests (so per-test `server.use(...)` overrides don't leak), and closes it
 *     after the suite.
 *  3. Auto-cleans the React Testing Library DOM after each test.
 */
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "../msw/server.js";

// MSW node lifecycle. `onUnhandledRequest: "error"` surfaces any endpoint a
// component calls that we forgot to model — keeping the harness honest.
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
