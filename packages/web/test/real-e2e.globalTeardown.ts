/**
 * F-08 — Playwright globalTeardown for the real web↔server e2e.
 *
 * Closes the Fastify server and stops the Postgres fixture booted in
 * `real-e2e.globalSetup.ts`. A no-op when the real backend was never booted
 * (hermetic suite), so the fast projects tear down instantly.
 */
import { readRealE2eHandles } from "./real-e2e.globalSetup.js";

export default async function globalTeardown(): Promise<void> {
  const handles = readRealE2eHandles();
  if (handles === undefined) return; // hermetic suite — nothing booted.

  await handles.built.app.close();
  await handles.fx.stop();
}
