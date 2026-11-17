import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import {
  type ProjectionDb,
  readExceptionKpi,
  readOpenExceptions,
} from "@mm/projections";
import type { ApiDb } from "./queries.js";

/**
 * Phase 3 (SNS-04/05) over HTTP — the DEMOABLE boundary. Three thin, read-only,
 * schema-validated routes that surface the OBSERVED layer + the detector's
 * output:
 *
 *  - `GET /exceptions`        — the open exception feed (severity + action).
 *  - `GET /exceptions/kpi`    — the false-positive-rate KPI (credibility metric).
 *  - `GET /packages/:id/zone` — a package's fused zone estimate (zone + conf).
 *
 * Design (KISS/DIP, mirrors `routes/queries.ts`): every handler is a THIN read —
 * it validates input via a Fastify JSON schema (threat T-03-19), runs ONE
 * parameterized Kysely query (or a projections read helper), and maps to a
 * stable DTO. There are NO mutation endpoints (T-03-22); the only writer remains
 * the sim/detector via the event store.
 *
 * Invariant carried to the wire (T-03-20): the zone DTO exposes ONLY the
 * estimated zone + a bounded confidence — NEVER an (x, y) coordinate. RFID is
 * not a positioning system; the API must not pretend otherwise.
 */

/** SNS-04/05 + COORD-03: one open exception row in the feed. */
export interface ExceptionDto {
  readonly exceptionId: string;
  readonly kind: "wrong-trailer" | "missed-unload" | "coordination-rejected";
  readonly packageId: string;
  /** The trailer the package was OBSERVED aboard. */
  readonly trailerId: string;
  /** The hub it should have unloaded at (missed-unload only; else null). */
  readonly hubId: string | null;
  readonly severity: string;
  readonly recommendedAction: string;
  /** Bounded observed confidence that triggered the exception (< 1.0). */
  readonly confidence: number;
  readonly occurredAt: string;
  // --- Phase-25 COORD-03 (coordination-rejected rows only; null otherwise) -----
  /** The closed reject reasonCode (`hos|fuel|dock|infeasible`), else null. */
  readonly reasonCode: string | null;
  /** The rejected suggestion's correlation id, else null. */
  readonly suggestionId: string | null;
  /** The operator-facing "won't …" label for the reject, else null. */
  readonly label: string | null;
}

/** SNS-04/05: the false-positive-rate KPI snapshot. */
export interface ExceptionKpiDto {
  readonly totalExceptions: number;
  readonly lowConfidenceExceptions: number;
  /** `lowConfidenceExceptions / totalExceptions`, or 0 when none opened. */
  readonly falsePositiveRate: number;
}

/**
 * SNS-02/03: a package's fused zone estimate (the OBSERVED layer surfaced).
 * ONLY zone + confidence — never coordinates (RFID-is-not-coordinates, T-03-20).
 */
export interface ZoneEstimateDto {
  readonly packageId: string;
  readonly trailerId: string;
  readonly estimatedZone: string;
  /** Bounded posterior mass of the estimated zone (STRICTLY < 1.0, anti-P5b). */
  readonly confidence: number;
  readonly lastReliableCheckpoint: string | null;
  readonly lastObservedAt: string;
}

/** Optional `?kind=` filter on the feed, validated against the closed enum. */
const exceptionsQuerySchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["wrong-trailer", "missed-unload", "coordination-rejected"],
    },
  },
} as const;

interface ExceptionsQuery {
  readonly kind?: "wrong-trailer" | "missed-unload" | "coordination-rejected";
}

/** A single string `:id` path param, validated non-empty (mirrors queries.ts). */
const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

interface IdParams {
  readonly id: string;
}

/** View the API handle as the projection read schema (same runtime instance). */
function projectionsView(db: ApiDb): Kysely<ProjectionDb> {
  return db as unknown as Kysely<ProjectionDb>;
}

/**
 * Register the Phase-3 exception/KPI/zone routes on `app`. `db` is the same
 * composition-root handle (`ApiDb`) the query routes use — it owns the event
 * store + projection tables.
 */
export function registerExceptionRoutes(app: FastifyInstance, db: ApiDb): void {
  // --- SNS-04/05: the open exception feed (optional ?kind= filter) ---------
  app.get<{ Querystring: ExceptionsQuery }>(
    "/exceptions",
    { schema: { querystring: exceptionsQuerySchema } },
    async (req: FastifyRequest<{ Querystring: ExceptionsQuery }>) => {
      const open = await readOpenExceptions(projectionsView(db));
      const filtered =
        req.query.kind === undefined
          ? open
          : open.filter((e) => e.kind === req.query.kind);
      const feed: ExceptionDto[] = filtered.map((e) => ({
        exceptionId: e.exceptionId,
        kind: e.kind,
        packageId: e.packageId,
        trailerId: e.trailerId,
        hubId: e.hubId,
        severity: e.severity,
        recommendedAction: e.recommendedAction,
        confidence: e.confidence,
        occurredAt: e.occurredAt,
        // Phase-25 COORD-03: the reject reason/label surface in the feed DTO (null
        // for detection rows). The DB-backed read path leaves these null this plan.
        reasonCode: e.reasonCode,
        suggestionId: e.suggestionId,
        label: e.label,
      }));
      return feed;
    },
  );

  // --- SNS-04/05: the false-positive-rate KPI -----------------------------
  app.get("/exceptions/kpi", async (): Promise<ExceptionKpiDto> => {
    const kpi = await readExceptionKpi(projectionsView(db));
    return {
      totalExceptions: kpi.totalExceptions,
      lowConfidenceExceptions: kpi.lowConfidenceExceptions,
      falsePositiveRate: kpi.falsePositiveRate,
    };
  });

  // --- SNS-02/03: a package's fused zone estimate (zone + confidence) ------
  // The latest estimate across trailers (deterministic: freshest, then trailer
  // id). An UNOBSERVED package is a 404 — absence is never a fabricated zone.
  app.get<{ Params: IdParams }>(
    "/packages/:id/zone",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const row = await db
        .selectFrom("zone_estimate")
        .selectAll()
        .where("package_id", "=", req.params.id)
        .orderBy("last_observed_at", "desc")
        .orderBy("trailer_id", "asc")
        .executeTakeFirst();
      if (row === undefined) return reply.code(404).send({ error: "not_found" });
      const dto: ZoneEstimateDto = {
        packageId: row.package_id,
        trailerId: row.trailer_id,
        estimatedZone: row.estimated_zone,
        confidence: row.confidence,
        lastReliableCheckpoint: row.last_reliable_checkpoint,
        lastObservedAt: toIso(row.last_observed_at),
      };
      return dto;
    },
  );
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
