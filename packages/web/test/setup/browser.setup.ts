/**
 * Browser-mode setup for the `browser` Vitest project (`*.browser.test.tsx`).
 *
 * Registers `@testing-library/jest-dom` matchers in the real browser context.
 * The MSW browser worker is intentionally NOT auto-started here: the only
 * current browser test (`MapView.browser.test.tsx`) is a mount smoke test that
 * relies on MapView's graceful geo-fetch degradation. Browser tests that need
 * deterministic API data should `await worker.start({ quiet: true })` from the
 * `test/msw/worker.ts` module in their own `beforeAll`.
 */
import "@testing-library/jest-dom/vitest";
