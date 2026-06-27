import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { getHubs, type Database } from "@mm/event-store";
import type { Hub } from "@mm/domain";
import {
  deriveCenterPartition,
  DEFAULT_CENTER_COUNT,
  generateBigCityHubs,
} from "@mm/simulation";
import { registerPlanRoutes } from "./routes/plan.js";

/**
 * Public hub DTO returned by `GET /hubs` (static topology, sent once on map
 * init — VIZ-16). Extends the domain `Hub` shape with:
 *  - `kind`: `"center"` for regional sort centers, `"spoke"` for field hubs.
 *  - `tier`: optional numeric tier (1 = center, 2 = spoke) for downstream style
 *    branching. Absent for legacy/non-continental runs (kind defaults to spoke).
 *
 * These are STATIC topology fields — they do NOT appear on the ws `HubState`
 * tick payload (topology is REST-only; per-tick bytes carry only metric buckets).
 */
export interface HubDto extends Hub {
  readonly kind: "center" | "spoke";
  readonly tier?: number;
}

/**
 * Derive the set of center hub ids for the current hub set.
 *
 * Uses `deriveCenterPartition` from `@mm/simulation` — the single source of
 * truth for the Phase-23 topology. For the continental hub set (92+ hubs) this
 * returns the 6 empirically-chosen regional sort center ids.
 *
 * For the legacy 10-hub set (`USA_HUBS`) the function is still called but with
 * `generateBigCityHubs()` — if the hub ids in the DB are the big-city ids, they
 * get enriched; if they are the legacy Memphis-centric ids none will match the
 * center partition and they all default to `"spoke"` (safe fallback).
 */
function buildCenterSet(): Set<string> {
  try {
    const partition = deriveCenterPartition(DEFAULT_CENTER_COUNT, undefined, generateBigCityHubs());
    return new Set(partition.centerHubIds);
  } catch {
    return new Set<string>();
  }
}

/** Center hub ids derived once at module load (pure, no I/O). */
const CENTER_HUB_IDS: Set<string> = buildCenterSet();

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
    return rows.map((r) => {
      const isCenter = CENTER_HUB_IDS.has(r.hub_id);
      return {
        hubId: r.hub_id,
        name: r.name,
        lat: r.lat,
        lon: r.lon,
        kind: isCenter ? "center" : "spoke",
        tier: isCenter ? 1 : 2,
      };
    });
  });

  // POST /plan — the pure load-planning pipeline (LOAD-08). Read-only, DB-free.
  registerPlanRoutes(app);

  return app;
}
