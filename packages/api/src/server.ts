import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import fastifyWebsocket from "@fastify/websocket";
import { registerQueryRoutes, type ApiDb } from "./routes/queries.js";
import { registerPlanRoutes } from "./routes/plan.js";
import { registerOptimizerRoutes } from "./routes/optimizer.js";
import { RollingOptimizerService } from "./optimizer/rolling-service.js";
import { attachSnapshotSocket, type Broadcast } from "./ws/snapshots.js";

/**
 * The composition root: builds the full Fastify query API (FND-05/06/07/08) plus
 * the ws snapshot channel, wired to a single Kysely handle that owns the event
 * store + projection tables. Kept a factory (no global state) so integration
 * tests `app.inject()` / connect a ws client against a Testcontainer, and the
 * runnable entrypoint (`main.ts`) passes a live connection.
 *
 * This SUPERSEDES the Plan 01 skeleton server: `GET /hubs` is preserved (now
 * served from the projected `hubs` table), and the FND query + ws surfaces are
 * added. The API is the ONLY package wiring concrete infrastructure together,
 * keeping the lower packages free of HTTP/process concerns.
 */

/** Dependencies for {@link buildServer}: the composition-root DB handle. */
export interface ServerDeps {
  readonly db: ApiDb;
  /** Toggle the realtime ws channel (default true). */
  readonly enableWs?: boolean;
}

/** The built server plus the per-tick snapshot `broadcast` (when ws is enabled). */
export interface BuiltServer {
  readonly app: FastifyInstance;
  /** Push one batched snapshot to every ws client; `undefined` when ws is off. */
  readonly broadcast: Broadcast | undefined;
  /** The rolling optimizer shell (OPT-04/05/06) — the only stateful writer. */
  readonly optimizer: RollingOptimizerService;
}

/** Build the Fastify server (REST query routes + optional ws snapshots). */
export async function buildServer(deps: ServerDeps): Promise<BuiltServer> {
  const app = Fastify({ logger: false });

  // Minimal permissive CORS for the local demo (Vite dev origin / e2e).
  app.addHook("onRequest", (_req, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    done();
  });

  app.get("/health", () => ({ status: "ok" }));
  registerQueryRoutes(app, deps.db);
  // POST /plan — the pure load-planning pipeline (LOAD-08). Read-only, DB-free.
  registerPlanRoutes(app);

  // The rolling optimizer shell (OPT-04/05/06) + its read-only recommendations
  // endpoint. The service owns the ONE write path (PlanAccepted); the route reads.
  // The optimizer only appends to the event store, so it views the handle as the
  // event-store schema (the same narrowing the sim driver uses).
  const optimizer = new RollingOptimizerService({
    db: deps.db as unknown as Kysely<Database>,
  });
  registerOptimizerRoutes(app, optimizer);

  let broadcast: Broadcast | undefined;
  if (deps.enableWs ?? true) {
    await app.register(fastifyWebsocket);
    broadcast = attachSnapshotSocket(app, deps.db);
  }

  await app.ready();
  return { app, broadcast, optimizer };
}
