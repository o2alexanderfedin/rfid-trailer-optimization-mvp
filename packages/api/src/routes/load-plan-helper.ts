import type { LoadBlock, RouteStop, TrailerSlice } from "@mm/domain";
import { DEFAULT_PLANNER_CONFIG } from "@mm/domain";
import {
  instructions,
  planExplanation,
  planLoad,
  utilizationFraction,
  type LoadingInstructions,
  type LoadPlan,
} from "@mm/load-planner";
import type { ApiDb } from "./queries.js";

/**
 * Shared trailer load-plan reconstruction (v1.2 HUBQ-03 — DRY).
 *
 * The VIZ-05 `GET /trailers/:id/plan` route reconstructed a trailer's rear→nose
 * load plan inline. The Phase-14 hub-detail endpoint needs the SAME reconstruction
 * per trailer at a hub, so the pure pipeline (build blocks → build route → run the
 * deterministic Phase-2 `planLoad` → render instructions/explanation → derive the
 * slice-aware utilization ratio + next hub) is single-sourced HERE. Both the
 * trailer-plan route and the hub-detail route call {@link reconstructTrailerPlan};
 * neither re-implements the data shaping.
 *
 * Everything here is a PURE function of the inputs passed in (the DB reads stay in
 * the route handlers / the small reader helpers below) — no clock, no RNG — so the
 * reconstruction replays deterministically (PITFALLS P3), exactly as before.
 */

// ---------------------------------------------------------------------------
// Wire DTO fragments (shared by the plan + hub-detail routes)
// ---------------------------------------------------------------------------

/** One slice in the rear→nose order (depth 0 = rear, ascending to nose). */
export interface RearToNoseSlice {
  /** Slice depth from the rear door; 0 = rear (the door). */
  readonly depth: number;
  /** The load-block ids placed in this slice (stable alphabetical order). */
  readonly loadBlockIds: readonly string[];
}

/**
 * The reconstructed load-plan summary shared by the trailer-plan route (VIZ-05)
 * and the hub-detail route (HUBQ-03/04/06). It carries everything BOTH surfaces
 * need; each route maps the subset it exposes onto its own stable DTO.
 */
export interface ReconstructedPlan {
  /** The trailer's load plan in rear→nose order (depth 0 = rear). */
  readonly rearToNose: readonly RearToNoseSlice[];
  /** Per-zone loading card (from the Phase-2 `instructions` renderer). */
  readonly instructions: LoadingInstructions;
  /** Plain-English plan explanation (from the Phase-2 `planExplanation` renderer). */
  readonly explanation: string;
  /**
   * HUBQ-04 — the slice-aware utilization ratio in `[0, 1]`
   * (`Σ usedVolume / Σ capacityVolume` over the plan slices, via the shared
   * `utilizationFraction`). NOT a flat `volume / 50`.
   */
  readonly utilization: number;
  /**
   * HUBQ-06 — the next destination hub: the FIRST stop on the reconstructed
   * route (earliest unload). `null` when no onward route derives.
   */
  readonly nextHubId: string | null;
}

// ---------------------------------------------------------------------------
// Block / route reconstruction (lifted verbatim from plan-detail.ts — DRY)
// ---------------------------------------------------------------------------

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
export function buildBlocks(
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
 * ensures the same input always yields the same route (anti-P3). The FIRST stop
 * (`stopIndex === 0`) is the trailer's NEXT hub (HUBQ-06).
 */
export function buildRoute(blocks: readonly LoadBlock[]): RouteStop[] {
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
export function toRearToNose(plan: LoadPlan): RearToNoseSlice[] {
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

// ---------------------------------------------------------------------------
// The single reconstruction entry point (HUBQ-03)
// ---------------------------------------------------------------------------

/**
 * Reconstruct a trailer's load plan from its current twin state. Returns `null`
 * when there is no derivable plan (no packages assigned OR no route derivable) —
 * the caller decides whether that is a 404 (the single-trailer route) or simply a
 * trailer omitted/summarized (the hub-detail list).
 *
 * @param assignedPackageIds the trailer's `assigned_package_ids` (current twin)
 * @param hubOutboundIndex   hubId → outbound+staged package ids (hub_inventory)
 * @param routeDestHubs       fallback next-unload hubs from the current hub's legs
 */
export function reconstructTrailerPlan(
  assignedPackageIds: readonly string[],
  hubOutboundIndex: ReadonlyMap<string, readonly string[]>,
  routeDestHubs: readonly string[],
): ReconstructedPlan | null {
  if (assignedPackageIds.length === 0) return null;

  const blocks = buildBlocks(assignedPackageIds, hubOutboundIndex, routeDestHubs);
  const route = buildRoute(blocks);
  if (route.length === 0) return null;

  const plan = planLoad(blocks, route, DEFAULT_PLANNER_CONFIG);

  return {
    rearToNose: toRearToNose(plan),
    instructions: instructions(plan, blocks),
    explanation: planExplanation(plan, blocks, route, DEFAULT_PLANNER_CONFIG),
    // HUBQ-04: slice-aware Σ usedVolume / Σ capacityVolume (single-sourced).
    utilization: utilizationFraction(plan),
    // HUBQ-06: the first stop on the LIFO-ordered route = the next hub.
    nextHubId: route[0]?.hubId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared DB readers (the reconstruction inputs — used by both routes)
// ---------------------------------------------------------------------------

/**
 * Read every hub_inventory row into a `hubId → outbound+staged ids` index (the
 * package→next-unload-hub source the reconstruction needs). Mirrors the inline
 * read the trailer-plan route did, single-sourced so both routes index identically.
 */
export async function readHubOutboundIndex(
  db: ApiDb,
): Promise<Map<string, readonly string[]>> {
  const rows = await db.selectFrom("hub_inventory").selectAll().execute();
  const index = new Map<string, readonly string[]>();
  for (const row of rows) {
    const allOut = [...row.outbound, ...row.staged];
    if (allOut.length > 0) index.set(row.hub_id, allOut);
  }
  return index;
}

/**
 * Read the destination hubs reachable from `currentHubId` via the immutable
 * `RouteRegistered` log — the fallback next-unload resolution for packages absent
 * from the outbound index. Returns `[]` when the hub is unknown/has no legs.
 */
export async function readRouteDestHubs(
  db: ApiDb,
  currentHubId: string,
): Promise<string[]> {
  if (currentHubId.length === 0) return [];
  const rows = await db
    .selectFrom("events")
    .select(["data"])
    .where("event_type", "=", "RouteRegistered")
    .orderBy("global_seq", "asc")
    .execute();
  const dests: string[] = [];
  for (const row of rows) {
    const r = row.data as { fromHubId: string; toHubId: string };
    if (r.fromHubId === currentHubId) dests.push(r.toHubId);
  }
  return dests;
}
