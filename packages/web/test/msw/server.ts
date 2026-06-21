/**
 * MSW node server for the jsdom `ui` project.
 *
 * `setupServer` intercepts `fetch` (and the MSW ws link) inside the Node/jsdom
 * test process. Lifecycle (listen/reset/close) is wired in the jsdom setup file
 * so every `*.test.tsx` and the `client.test.ts` fetch tests run against these
 * handlers with no real network.
 */
import { setupServer } from "msw/node";
import { handlers } from "./handlers.js";

/** The shared node-side MSW server for the jsdom project. */
export const server = setupServer(...handlers);
