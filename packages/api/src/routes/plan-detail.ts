import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { LoadingInstructions } from "@mm/load-planner";
import type { CatchupDb } from "@mm/projections";
import { readTrailerAuditTimeline } from "@mm/projections";
import type { ApiDb } from "./queries.js";
import {
  reconstructTrailerPlan,
  readHubOutboundIndex,
  readRouteDestHubs,
  type RearToNoseSlice,
} from "./load-plan-helper.js";

// Re-export the shared slice DTO so existing consumers keep importing it from here.
export type { RearToNoseSlice } from "./load-plan-helper.js";

/**
 * `GET /trailers/:id/plan` (VIZ-05) and `GET /trailers/:id/history` (UI-02).
 *
 * VIZ-05: Click a trailer → its rear→nose load plan + why.
 *  - Reads the trailer's current twin state (assigned packages, current hub).
 *  - Reconstructs the load plan via `planLoad` (the same deterministic Phase-2
 *    function the optimizer uses) from the current twin state.
 *  - Renders `instructions` + `planExplanation` via the reused Phase-2 renderers.
 *  - Returns a stable DTO: `{ rearToNose, instructions, explanation }`.
 *  - 404 on unknown trailer OR trailer with no packages assigned (absence is
 *    never a fabricated plan).
 *
 * UI-02: Read-only trailer audit timeline (trailer-keyed entries + captured
 * recommendation at each decision event):
 *  - Delegates to `readTrailerAuditTimeline` (from @mm/projections).
 *  - Returns an empty array for an unknown trailer (no history = empty, not 404).
 *
 * Design (KISS / DIP — mirrors queries.ts + plan.ts):
 *  - Thin handlers: validate `:id` via Fastify schema → pure read → stable DTO.
 *  - Read-only — no event-store writes (threat T-05-07/T-05-08).
 *  - `:id` is schema-validated non-empty (T-05-07 — mirrors T-01-18).
 *  - Single parameterized query per handler (no string-concat SQL).
 */

// ---------------------------------------------------------------------------
// Wire DTOs
// ---------------------------------------------------------------------------

/** The `GET /trailers/:id/plan` response (VIZ-05). */
export interface TrailerPlanDto {
  readonly trailerId: string;
  /** The trailer's load plan in rear→nose order (depth 0 = rear). */
  readonly rearToNose: readonly RearToNoseSlice[];
  /** Per-zone loading card (from the Phase-2 `instructions` renderer). */
  readonly instructions: LoadingInstructions;
  /** Plain-English plan explanation (from the Phase-2 `planExplanation` renderer). */
  readonly explanation: string;
  /**
   * HUBQ-04 — slice-aware utilization ratio in `[0, 1]`
   * (`Σ usedVolume / Σ capacityVolume`). ADDITIVE: VIZ-05 consumers that ignore
   * it are unaffected; the hub-detail endpoint surfaces the SAME field.
   */
  readonly utilization: number;
}

/**
 * One entry in the `GET /trailers/:id/history` (UI-02) response.
 */
export interface TrailerHistoryEntryDto {
  readonly globalSeq: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly hubId: string | null;
  readonly scanType: string | null;
  /** Captured system recommendation at plan-lifecycle events; null otherwise. */
  readonly recommendation: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The single string `:id` path param, validated non-empty by Fastify schema. */
const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

interface IdParams {
  readonly id: string;
}

/** View the API handle as the catch-up read schema. */
function catchupView(db: ApiDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/**
 * Map an `AuditTimelineEntry[]` (from `@mm/projections`) to the stable wire DTO
 * for the trailer-keyed history route.
 */
function toHistoryDto(
  timeline: Awaited<ReturnType<typeof readTrailerAuditTimeline>>,
): TrailerHistoryEntryDto[] {
  return timeline.map((e) => ({
    globalSeq: e.globalSeq.toString(),
    eventType: e.eventType,
    occurredAt: e.occurredAt,
    hubId: e.hubId,
    scanType: e.scanType,
    recommendation: e.recommendation,
  }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /trailers/:id/plan` (VIZ-05) and `GET /trailers/:id/history`
 * (UI-02) on `app`. `db` is the composition-root handle.
 */
export function registerPlanDetailRoutes(app: FastifyInstance, db: ApiDb): void {
  // --- VIZ-05: GET /trailers/:id/plan -------------------------------------
  app.get<{ Params: IdParams }>(
    "/trailers/:id/plan",
    { schema: { params: idParamsSchema } },
    async (
      req: FastifyRequest<{ Params: IdParams }>,
      reply: FastifyReply,
    ): Promise<TrailerPlanDto | undefined> => {
      const trailerId = req.params.id;

      // 1. Read the trailer's current state
      const trailerRow = await db
        .selectFrom("trailer_state")
        .selectAll()
        .where("trailer_id", "=", trailerId)
        .executeTakeFirst();

      if (trailerRow === undefined) {
        return reply.code(404).send({ error: "not_found" });
      }

      const assignedPackageIds: readonly string[] = trailerRow.assigned_package_ids;

      // 404 for trailers with no assigned packages — no plan exists yet
      if (assignedPackageIds.length === 0) {
        return reply.code(404).send({ error: "no_plan" });
      }

      // 2–6. Reconstruct via the SHARED helper (HUBQ-03 — same pipeline the
      // hub-detail endpoint uses; DRY). Reads the hub-inventory outbound index
      // and the route-leg fallback the planner needs.
      const [hubOutboundIndex, routeDestHubs] = await Promise.all([
        readHubOutboundIndex(db),
        readRouteDestHubs(db, trailerRow.current_hub_id ?? ""),
      ]);

      const plan = reconstructTrailerPlan(
        assignedPackageIds,
        hubOutboundIndex,
        routeDestHubs,
      );

      if (plan === null) {
        // No route can be derived → no valid plan
        return reply.code(404).send({ error: "no_route" });
      }

      // 7. Map to the stable wire DTO (HUBQ-04: utilization is additive).
      const dto: TrailerPlanDto = {
        trailerId,
        rearToNose: plan.rearToNose,
        instructions: plan.instructions,
        explanation: plan.explanation,
        utilization: plan.utilization,
      };
      return dto;
    },
  );

  // --- UI-02: GET /trailers/:id/history ------------------------------------
  app.get<{ Params: IdParams }>(
    "/trailers/:id/history",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>): Promise<TrailerHistoryEntryDto[]> => {
      const trailerId = req.params.id;
      const timeline = await readTrailerAuditTimeline(catchupView(db), trailerId);
      return toHistoryDto(timeline);
    },
  );
}
