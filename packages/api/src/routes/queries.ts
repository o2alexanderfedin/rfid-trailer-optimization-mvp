import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import {
  type CatchupDb,
  type ProjectionDb,
  readAuditTimeline,
} from "@mm/projections";
import type { Hub, LonLat } from "@mm/domain";

/**
 * Read-only query endpoints over the operational + audit projections
 * (FND-05/06/07/08) plus the geo data the map needs.
 *
 * Design (KISS/DIP): every handler is a THIN pure read — it validates the `:id`
 * path param via a Fastify JSON schema (threat T-01-18), runs ONE parameterized
 * Kysely query (no string-concatenated SQL), and maps the row to a stable DTO.
 * There are no mutation endpoints (threat T-01-21); the only writer is the sim
 * via the event store.
 */

/** The database surface the query routes read: event store + all projections. */
export type ApiDb = Kysely<Database & ProjectionDb>;

// --- DTOs (the public, stable wire shapes) ----------------------------------

/** FND-05: a package's last-known location. */
export interface PackageLocationDto {
  readonly packageId: string;
  readonly hubId: string;
  readonly confidence: number;
  readonly lastSeenAt: string;
}

/** FND-06: a trailer's current state / assignment. */
export interface TrailerDto {
  readonly trailerId: string;
  readonly status: string;
  readonly currentHubId: string | null;
  readonly tripId: string | null;
  readonly assignedPackageIds: readonly string[];
}

/** FND-07: a hub's bucketed inventory. */
export interface HubInventoryDto {
  readonly hubId: string;
  readonly inbound: readonly string[];
  readonly outbound: readonly string[];
  readonly staged: readonly string[];
}

/** FND-08: one ordered audit-timeline entry. */
export interface AuditEntryDto {
  readonly globalSeq: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly hubId: string | null;
  readonly scanType: string | null;
  /** Captured system recommendation at plan-lifecycle events; null otherwise (UI-02). */
  readonly recommendation: string | null;
}

/** A route geometry for the map (`[lon, lat]` GeoJSON-axis vertices). */
export interface RouteDto {
  readonly routeId: string;
  readonly fromHubId: string;
  readonly toHubId: string;
  readonly geometry: readonly LonLat[];
}

/** A single string `:id` path param, validated non-empty by Fastify schema. */
const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

interface IdParams {
  readonly id: string;
}

/** View the API handle as the catch-up read schema (same runtime instance). */
function catchupView(db: ApiDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/**
 * Register the FND query routes on `app`. `db` is the composition-root handle
 * that owns both the event-store and projection tables.
 */
export function registerQueryRoutes(app: FastifyInstance, db: ApiDb): void {
  // --- FND-05: package last-known location --------------------------------
  app.get<{ Params: IdParams }>(
    "/packages/:id/location",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const row = await db
        .selectFrom("package_location")
        .selectAll()
        .where("package_id", "=", req.params.id)
        .executeTakeFirst();
      if (row === undefined) return reply.code(404).send({ error: "not_found" });
      const dto: PackageLocationDto = {
        packageId: row.package_id,
        hubId: row.hub_id,
        confidence: row.confidence,
        lastSeenAt: toIso(row.last_seen_at),
      };
      return dto;
    },
  );

  // --- FND-06: trailer current state / assignment -------------------------
  app.get<{ Params: IdParams }>(
    "/trailers/:id",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const row = await db
        .selectFrom("trailer_state")
        .selectAll()
        .where("trailer_id", "=", req.params.id)
        .executeTakeFirst();
      if (row === undefined) return reply.code(404).send({ error: "not_found" });
      const dto: TrailerDto = {
        trailerId: row.trailer_id,
        status: row.status,
        currentHubId: row.current_hub_id,
        tripId: row.trip_id,
        assignedPackageIds: row.assigned_package_ids,
      };
      return dto;
    },
  );

  // --- FND-07: hub inventory ----------------------------------------------
  app.get<{ Params: IdParams }>(
    "/hubs/:id/inventory",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>) => {
      const row = await db
        .selectFrom("hub_inventory")
        .selectAll()
        .where("hub_id", "=", req.params.id)
        .executeTakeFirst();
      // An unseen hub has empty inventory (a valid, stable answer — not a 404).
      const dto: HubInventoryDto = {
        hubId: req.params.id,
        inbound: row?.inbound ?? [],
        outbound: row?.outbound ?? [],
        staged: row?.staged ?? [],
      };
      return dto;
    },
  );

  // --- FND-08: package audit timeline (ordered by global_seq) --------------
  app.get<{ Params: IdParams }>(
    "/packages/:id/history",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>) => {
      const timeline = await readAuditTimeline(catchupView(db), req.params.id);
      const dto: AuditEntryDto[] = timeline.map((e) => ({
        globalSeq: e.globalSeq.toString(),
        eventType: e.eventType,
        occurredAt: e.occurredAt,
        hubId: e.hubId,
        scanType: e.scanType,
        recommendation: e.recommendation,
      }));
      return dto;
    },
  );

  // --- Geo: hubs (supersedes the Plan 01 skeleton /hubs) ------------------
  app.get("/hubs", (): Promise<Hub[]> => readHubsFromLog(db));

  // --- Geo: route geometries for the map ----------------------------------
  app.get("/routes", async (): Promise<RouteDto[]> => {
    const rows = await db
      .selectFrom("events")
      .select(["data"])
      .where("event_type", "=", "RouteRegistered")
      .orderBy("global_seq", "asc")
      .execute();
    return rows.map((r) => routeDtoFromPayload(r.data));
  });
}

/**
 * Read the hub geo list from the immutable log (`HubRegistered` events) — the
 * uniform source for both `GET /hubs` and the ws snapshot. The latest event per
 * hub wins. Shared so the REST and ws surfaces never disagree (DRY).
 */
export async function readHubsFromLog(db: ApiDb): Promise<Hub[]> {
  const rows = await db
    .selectFrom("events")
    .select(["data"])
    .where("event_type", "=", "HubRegistered")
    .orderBy("global_seq", "asc")
    .execute();
  const byId = new Map<string, Hub>();
  for (const r of rows) {
    const hub = r.data as Hub;
    byId.set(hub.hubId, { hubId: hub.hubId, name: hub.name, lat: hub.lat, lon: hub.lon });
  }
  return [...byId.values()].sort((a, b) =>
    a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0,
  );
}

/** Narrow a JSONB `RouteRegistered` payload to a `RouteDto` (read-side guard). */
function routeDtoFromPayload(data: unknown): RouteDto {
  const p = data as {
    routeId: string;
    fromHubId: string;
    toHubId: string;
    geometry: LonLat[];
  };
  return {
    routeId: p.routeId,
    fromHubId: p.fromHubId,
    toHubId: p.toHubId,
    geometry: p.geometry,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
