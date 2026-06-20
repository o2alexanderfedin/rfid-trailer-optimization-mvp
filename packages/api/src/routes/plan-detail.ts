import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { LoadBlock, RouteStop, TrailerSlice } from "@mm/domain";
import { DEFAULT_PLANNER_CONFIG } from "@mm/domain";
import {
  instructions,
  planExplanation,
  planLoad,
  type LoadingInstructions,
  type LoadPlan,
} from "@mm/load-planner";
import type { CatchupDb } from "@mm/projections";
import { readTrailerAuditTimeline } from "@mm/projections";
import type { ApiDb } from "./queries.js";

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

/** One slice in the rear→nose order (depth 0 = rear, ascending to nose). */
export interface RearToNoseSlice {
  /** Slice depth from the rear door; 0 = rear (the door). */
  readonly depth: number;
  /** The load-block ids placed in this slice (stable alphabetical order). */
  readonly loadBlockIds: readonly string[];
}

/** The `GET /trailers/:id/plan` response (VIZ-05). */
export interface TrailerPlanDto {
  readonly trailerId: string;
  /** The trailer's load plan in rear→nose order (depth 0 = rear). */
  readonly rearToNose: readonly RearToNoseSlice[];
  /** Per-zone loading card (from the Phase-2 `instructions` renderer). */
  readonly instructions: LoadingInstructions;
  /** Plain-English plan explanation (from the Phase-2 `planExplanation` renderer). */
  readonly explanation: string;
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
 * Build a minimal `LoadBlock[]` from the assigned package IDs, the hub-inventory
 * outbound index, and the known route legs.
 *
 * Each assigned package becomes a unit block. The `key.nextUnloadHubId` is the
 * hub the package is staged/outbound at (from the hub-inventory index). If a
 * package is not found in the outbound index, we fall back to the first route
 * destination from the trailer's current hub — this ensures the planner always
 * has a valid block, even in sparse demo data.
 *
 * This approach mirrors `twin-snapshot.ts:buildTrailerBlocks` (DRY: both read the
 * same data source; we can't import twin-snapshot here because it is in `@mm/api`'s
 * internal optimizer module, but the pattern is identical).
 */
function buildBlocks(
  assignedPackageIds: readonly string[],
  hubOutboundIndex: ReadonlyMap<string, readonly string[]>,
  routeDestHubs: readonly string[],
): LoadBlock[] {
  const pkgToHub = new Map<string, string>();
  for (const [hubId, pkgIds] of hubOutboundIndex) {
    for (const pkgId of pkgIds) {
      if (!pkgToHub.has(pkgId)) {
        pkgToHub.set(pkgId, hubId);
      }
    }
  }

  const fallbackHub = routeDestHubs[0] ?? "unknown";
  const sorted = [...assignedPackageIds].sort();

  return sorted.map((pkgId) => {
    const nextUnloadHubId = pkgToHub.get(pkgId) ?? fallbackHub;
    // Build a minimal LoadBlock shape for the planner.
    // Each package is its own unit-volume block (the MVP aggregation model).
    const block: LoadBlock = {
      loadBlockId: pkgId,
      key: {
        currentHubId: "unknown", // not used by planLoad/instructions/planExplanation
        nextUnloadHubId,
        finalDestHubId: nextUnloadHubId, // simplified: final dest = next unload
        slaClass: "standard",
        deadlineBucket: 0,
        handlingClass: "standard",
        sizeWeightClass: "small",
      },
      packageIds: [pkgId],
      packageCount: 1,
      totalVolume: 1,
      totalWeight: 1,
      priority: 0,
    };
    return block;
  });
}

/**
 * Build the `RouteStop[]` for the planner from the distinct next-unload hubs
 * of the assigned blocks, sorted deterministically.
 *
 * `stopIndex` is a zero-based integer: earlier stop → smaller index → LIFO
 * invariant places it nearer the rear (depth 0). The stable sort by hubId
 * ensures the same input always yields the same route (anti-P3).
 */
function buildRoute(blocks: readonly LoadBlock[]): RouteStop[] {
  const unloadHubs = new Set<string>();
  for (const b of blocks) {
    unloadHubs.add(b.key.nextUnloadHubId);
  }
  const sorted = [...unloadHubs].sort();
  return sorted.map((hubId, idx) => ({ hubId, stopIndex: idx }));
}

/**
 * Convert a `LoadPlan`'s `slices` to the rear→nose DTO (ascending depth).
 * Non-empty slices only; stable inner order (alphabetical block ids).
 */
function toRearToNose(plan: LoadPlan): RearToNoseSlice[] {
  return [...plan.slices]
    .filter((s) => s.loadBlockIds.length > 0)
    .sort((a, b) => a.depth - b.depth)
    .map(
      (s: TrailerSlice): RearToNoseSlice => ({
        depth: s.depth,
        loadBlockIds: [...s.loadBlockIds].sort(),
      }),
    );
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

      // 2. Read hub inventory to find each package's next-unload hub
      const hubInventoryRows = await db
        .selectFrom("hub_inventory")
        .selectAll()
        .execute();

      const hubOutboundIndex = new Map<string, readonly string[]>();
      for (const row of hubInventoryRows) {
        const allOut = [...row.outbound, ...row.staged];
        if (allOut.length > 0) {
          hubOutboundIndex.set(row.hub_id, allOut);
        }
      }

      // 3. Read route legs from the event log for fallback hub resolution
      const routeEventRows = await db
        .selectFrom("events")
        .select(["data"])
        .where("event_type", "=", "RouteRegistered")
        .orderBy("global_seq", "asc")
        .execute();

      const currentHubId = trailerRow.current_hub_id ?? "";
      const routeDestHubs: string[] = [];
      for (const row of routeEventRows) {
        const r = row.data as { fromHubId: string; toHubId: string };
        if (r.fromHubId === currentHubId) routeDestHubs.push(r.toHubId);
      }

      // 4. Build blocks + route for the planner
      const blocks = buildBlocks(assignedPackageIds, hubOutboundIndex, routeDestHubs);
      const route = buildRoute(blocks);

      if (route.length === 0) {
        // No route can be derived → no valid plan
        return reply.code(404).send({ error: "no_route" });
      }

      // 5. Reconstruct the plan using the deterministic Phase-2 planner
      const plan = planLoad(blocks, route, DEFAULT_PLANNER_CONFIG);

      // 6. Render instructions + explanation via Phase-2 renderers
      const loadingInstructions = instructions(plan, blocks);
      const explanation = planExplanation(plan, blocks, route, DEFAULT_PLANNER_CONFIG);

      // 7. Map to the stable wire DTO
      const dto: TrailerPlanDto = {
        trailerId,
        rearToNose: toRearToNose(plan),
        instructions: loadingInstructions,
        explanation,
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
