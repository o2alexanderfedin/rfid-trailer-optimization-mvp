import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { registerQueryRoutes, type ApiDb } from "./routes/queries.js";
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

  let broadcast: Broadcast | undefined;
  if (deps.enableWs ?? true) {
    await app.register(fastifyWebsocket);
    broadcast = attachSnapshotSocket(app, deps.db);
  }

  await app.ready();
  return { app, broadcast };
}
