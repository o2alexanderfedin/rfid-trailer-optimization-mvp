/**
 * F-08 — Playwright globalSetup for the ONE real web↔server e2e.
 *
 * Boots the REAL backend ONCE, programmatically, before the `chromium-real`
 * Playwright project runs:
 *
 *   1. `startPgFixture()` — an ephemeral Postgres (testcontainers `postgres:17`,
 *      or a per-run db on `MM_PG_URL` / `DATABASE_URL` when provided).
 *   2. `buildServer({ db, enableWs:true, simSeed:4242, baselineTicks:120 })` —
 *      the exact composition root used by `main.ts` (REST + ws + rolling loop).
 *   3. `driveSimulation({ db, seed:4242, durationTicks:120, rfid:DEMO_RFID_CONFIG,
 *      broadcast, loop })` — drives the REAL demo path SYNCHRONOUSLY so all
 *      projections are populated and the ws snapshot is non-empty by the time the
 *      browser connects (deterministic; no race vs a paced stream).
 *   4. `app.listen({ port: MM_E2E_API_PORT ?? 3101, host:'127.0.0.1' })`.
 *
 * The Fastify server serves its routes at ROOT (`/hubs`, `/kpis`, `/ws`, …).
 * The web bundle talks same-origin `/api/*`; `vite.preview-real.config.ts` adds a
 * `preview.proxy` that strips the `/api` prefix and forwards to this server.
 *
 * GATING: this heavy boot (which requires Docker) MUST NOT run for the fast
 * hermetic suite. `globalSetup` is a single global hook, so we gate the boot on
 * the real project being selected. We detect that via the `MM_E2E_REAL=1` env
 * (set by the `test:e2e:real` / `preview:real` scripts) OR a `--project`
 * containing `chromium-real` on the Playwright argv. When neither is present we
 * return immediately — the hermetic projects run with ZERO Docker dependency.
 *
 * The booted handles are stashed on `globalThis` for `real-e2e.globalTeardown.ts`.
 */
import {
  buildServer,
  DEMO_RFID_CONFIG,
  driveSimulation,
  type ApiDb,
} from "@mm/api";
import type { BuiltServer } from "@mm/api";
// pg-fixture lives in the api package's test dir; imported via a relative path
// across packages (see real-e2e test-utils note). Resolves under the Playwright
// node runtime because @testcontainers/postgresql + pg are devDeps of @mm/web.
import { startPgFixture, type PgFixture } from "../../api/test/pg-fixture.js";

const SEED = 4242;
const DURATION = 120;

/** Default port for the real API; overridable via `MM_E2E_API_PORT`. */
export function realApiPort(): number {
  const raw = process.env.MM_E2E_API_PORT;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3101;
}

/** Handles stashed between setup and teardown. */
export interface RealE2eHandles {
  readonly fx: PgFixture;
  readonly built: BuiltServer;
}

/** Symbol-keyed stash on globalThis so teardown can find the live handles. */
const STASH_KEY = "__MM_REAL_E2E__";

interface StashGlobal {
  [STASH_KEY]?: RealE2eHandles;
}

/**
 * Decide whether the heavy real-backend boot should run.
 *
 * Returns true ONLY when the real project is the target — either the
 * `MM_E2E_REAL=1` env flag is set, or `--project=chromium-real` is on argv.
 * This keeps the fast hermetic suite (chromium / chromium-dev / chromium-soak)
 * free of any Docker / testcontainer dependency.
 */
export function shouldBootRealBackend(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env.MM_E2E_REAL === "1") return true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--project" && argv[i + 1] === "chromium-real") return true;
    if (a.startsWith("--project=") && a.slice("--project=".length) === "chromium-real") {
      return true;
    }
  }
  return false;
}

export default async function globalSetup(): Promise<void> {
  if (!shouldBootRealBackend()) {
    // Hermetic suite — do not boot the real backend (no Docker needed).
    return;
  }

  const fx = await startPgFixture();
  // `PgFixture.db` is `Kysely<Database & ProjectionDb>`, structurally identical
  // to `ApiDb` — assign directly (no cast needed).
  const db: ApiDb = fx.db;

  const built = await buildServer({
    db,
    enableWs: true,
    simSeed: SEED,
    baselineTicks: DURATION,
  });

  // Drive the REAL demo path synchronously: populates every projection and
  // produces a non-empty ws snapshot for the very first browser connect.
  await driveSimulation({
    db,
    seed: SEED,
    durationTicks: DURATION,
    rfid: DEMO_RFID_CONFIG,
    broadcast: built.broadcast,
    loop: built.loop,
  });

  await built.app.listen({ port: realApiPort(), host: "127.0.0.1" });

  (globalThis as StashGlobal)[STASH_KEY] = { fx, built };
}

/** Read the stashed handles (used by globalTeardown). */
export function readRealE2eHandles(): RealE2eHandles | undefined {
  return (globalThis as StashGlobal)[STASH_KEY];
}
