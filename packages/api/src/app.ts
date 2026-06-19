import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { getHubs, type Database } from "@mm/event-store";
import type { Hub } from "@mm/domain";

/** Public hub DTO returned by `GET /hubs` (matches the domain Hub shape). */
export type HubDto = Hub;

/**
 * Build a Fastify app wired to a given Kysely DB. Kept as a factory (no global
 * state) so integration tests can `app.inject()` against a test container and
 * the real server (`server.ts`) can pass a live connection.
 */
export function buildApp(db: Kysely<Database>): FastifyInstance {
  const app = Fastify({ logger: false });

  // Minimal permissive CORS for the local demo (web dev server / e2e).
  app.addHook("onRequest", (_req, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    done();
  });

  app.get("/health", () => ({ status: "ok" }));

  app.get("/hubs", async (): Promise<HubDto[]> => {
    const rows = await getHubs(db);
    return rows.map((r) => ({
      hubId: r.hub_id,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
    }));
  });

  return app;
}
