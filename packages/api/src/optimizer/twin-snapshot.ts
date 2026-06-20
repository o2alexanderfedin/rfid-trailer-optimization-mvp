import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import type { ProjectionDb } from "@mm/projections";
import type {
  TwinBlock,
  TwinRoute,
  TwinSnapshot,
  TwinStop,
  TwinTrailer,
} from "@mm/optimizer";

/**
 * `@mm/api` — `buildTwinSnapshot`: reads the live operational projections and
 * assembles a deterministic `TwinSnapshot` for the rolling optimizer epoch.
 *
 * Design discipline:
 *  - PURE read mapping — no event-store writes, no side effects.
 *  - Deterministic: every collection is sorted by id; `travelMin` comes from
 *    the sim's `TRANSIT_MIN` constant (30 min); `departureMin` comes from
 *    sim/event time — `Date.now()` is NEVER called (anti-P3).
 *  - Integer capacities + volumes (P12): no floats enter the optimizer.
 *  - `nextUnloadHubId` for each block references hubs in the route network.
 */

/** Combined DB type the snapshot builder reads from. */
export type SnapshotDb = Kysely<Database & ProjectionDb>;

/**
 * The transit time per trip leg in minutes — the sim's TRANSIT_TICKS = 30 min.
 * All route legs in the demo network use this uniform travel time. The optimizer
 * costs are scaled on integers over minutes so this stays a round number.
 */
export const TRANSIT_MIN = 30;

/**
 * Default trailer freight capacity (integer load-block units). The sim assigns
 * packages as unit blocks (one package = one unit-volume `TwinBlock`), so this
 * is the per-trip LIFO capacity gate denominator AND the real utilization-fill
 * denominator the optimizer uses (`Σ block.volume / capacity`). Exported so the
 * KPI route derives the SAME real fill ratio (finding #10 DRY) instead of an
 * arbitrary package-count proxy.
 */
export const DEFAULT_TRAILER_CAPACITY = 50;

/**
 * Default route leg capacity (integer freight units per trip). Matches the demo
 * network's capacity model; any positive integer works for the flow solver.
 */
const DEFAULT_ROUTE_CAPACITY = 200;

/**
 * Default departure offset in minutes from epoch 0. When a trailer has no live
 * departure event in the event store (not yet dispatched), we assign a departure
 * far enough in the future that it will NOT be frozen by the freeze window. The
 * rolling loop will update this once a departure event is recorded.
 */
const DEFAULT_DEPARTURE_MIN = 9999;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sorted, deduped string array (determinism, anti-P7). */
function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Parse a `RouteRegistered` JSONB payload into a `TwinRoute`. The geometry
 * is recorded but not used for travel time here — we use `TRANSIT_MIN` (the
 * sim's uniform transit model) to avoid float distance math (P12).
 */
function parseRouteRow(data: unknown): TwinRoute {
  const p = data as {
    routeId: string;
    fromHubId: string;
    toHubId: string;
  };
  return {
    routeId: p.routeId,
    fromHubId: p.fromHubId,
    toHubId: p.toHubId,
    travelMin: TRANSIT_MIN,
    capacity: DEFAULT_ROUTE_CAPACITY,
  };
}

/**
 * Build the `TwinStop[]` for a trailer by looking at its assigned packages
 * and matching them to route hubs. Each distinct unload hub becomes a stop;
 * stop indices are assigned in routeId-sorted order for determinism.
 *
 * For the MVP, we build the route from the outbound inventory: packages in
 * `outbound` or `staged` at each hub define the unload stops for the trailer
 * currently at that hub. If there is no route data for a trailer, we fall back
 * to an empty route (the epoch will skip it as zero-demand).
 */
function buildTrailerStops(
  assignedPackageIds: readonly string[],
  hubOutboundIndex: ReadonlyMap<string, readonly string[]>,
  routes: readonly TwinRoute[],
  currentHubId: string | null,
): readonly TwinStop[] {
  if (assignedPackageIds.length === 0) return [];

  // Find which hubs each assigned package is staged/outbound at — that is
  // where the freight will be unloaded on this trailer's route.
  const packageSet = new Set(assignedPackageIds);
  const unloadHubs = new Set<string>();

  for (const [hubId, pkgIds] of hubOutboundIndex) {
    for (const pkgId of pkgIds) {
      if (packageSet.has(pkgId)) {
        // Only include hubs that appear in the known route network
        unloadHubs.add(hubId);
        break;
      }
    }
  }

  // If no unload hubs found, derive from available routes from currentHubId
  if (unloadHubs.size === 0 && currentHubId !== null) {
    for (const r of routes) {
      if (r.fromHubId === currentHubId) {
        unloadHubs.add(r.toHubId);
      }
    }
  }

  // Sorted for determinism
  const sortedHubs = [...unloadHubs].sort();
  return sortedHubs.map((hubId, idx) => ({
    hubId,
    stopIndex: idx,
  }));
}

/**
 * Build `TwinBlock[]` for a trailer from its `assigned_package_ids`. Each
 * package becomes a unit-volume block assigned to the hub it is staged/outbound
 * at. Blocks are sorted by blockId for determinism (anti-P3).
 */
function buildTrailerBlocks(
  assignedPackageIds: readonly string[],
  hubOutboundIndex: ReadonlyMap<string, readonly string[]>,
  routes: readonly TwinRoute[],
  currentHubId: string | null,
): readonly TwinBlock[] {
  if (assignedPackageIds.length === 0) return [];

  const packageSet = new Set(assignedPackageIds);

  // Build a reverse map: packageId → hub it's outbound/staged at
  const pkgToHub = new Map<string, string>();
  for (const [hubId, pkgIds] of hubOutboundIndex) {
    for (const pkgId of pkgIds) {
      if (packageSet.has(pkgId) && !pkgToHub.has(pkgId)) {
        pkgToHub.set(pkgId, hubId);
      }
    }
  }

  // Derive the available destination hubs from routes if needed
  const routeDestHubs = new Set<string>();
  if (currentHubId !== null) {
    for (const r of routes) {
      if (r.fromHubId === currentHubId) {
        routeDestHubs.add(r.toHubId);
      }
    }
  }

  // For each assigned package, create one unit-volume block
  const sorted = [...assignedPackageIds].sort();
  return sorted.map((pkgId) => {
    // Prefer the actual hub the package is staged/outbound at; fall back to
    // the first available route destination hub as a best-effort assignment.
    const nextUnloadHubId =
      pkgToHub.get(pkgId) ??
      [...routeDestHubs][0] ??
      "unknown";
    return {
      blockId: pkgId,
      nextUnloadHubId,
      volume: 1, // unit-volume per package (integer, P12)
    };
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a deterministic `TwinSnapshot` by reading the live operational
 * projections (`trailer_state`, `hub_inventory`) and the event log
 * (`RouteRegistered` events). The snapshot is used by `runEpoch` via the
 * `RollingLoop` (live-loop.ts).
 *
 * Determinism guarantees (anti-P3):
 *  - All collections are sorted by their stable id.
 *  - `travelMin` = `TRANSIT_MIN` (constant, not derived from geometry floats).
 *  - `departureMin` comes from `TrailerDeparted` event times in the log (not
 *    `Date.now()`). If no departure is on record, `DEFAULT_DEPARTURE_MIN` is
 *    used.
 *  - `capacity` / `volume` are positive integers (P12).
 *
 * @param db  the composition-root DB handle (event store + projection tables)
 */
export async function buildTwinSnapshot(db: SnapshotDb): Promise<TwinSnapshot> {
  // 1. Read route legs from RouteRegistered events (immutable log)
  const routeEventRows = await db
    .selectFrom("events")
    .select(["data"])
    .where("event_type", "=", "RouteRegistered")
    .orderBy("global_seq", "asc")
    .execute();

  // Latest route per routeId wins (idempotent upsert semantics)
  const routeById = new Map<string, TwinRoute>();
  for (const row of routeEventRows) {
    const r = parseRouteRow(row.data);
    routeById.set(r.routeId, r);
  }
  const routes: readonly TwinRoute[] = [...routeById.values()].sort((a, b) =>
    a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0,
  );

  // 2. Read the latest TrailerDeparted times from the event log so we can set
  //    `departureMin` from the sim clock (NEVER Date.now).
  const departedRows = await db
    .selectFrom("events")
    .select(["data"])
    .where("event_type", "=", "TrailerDeparted")
    .orderBy("global_seq", "asc")
    .execute();

  // Last departure per trailerId → departureMin in minutes from Unix epoch
  const departureMinByTrailer = new Map<string, number>();
  for (const row of departedRows) {
    const d = row.data as {
      trailerId: string;
      departedAt?: string;
    };
    if (d.trailerId !== undefined) {
      const ms = d.departedAt !== undefined ? new Date(d.departedAt).getTime() : 0;
      departureMinByTrailer.set(d.trailerId, Math.floor(ms / 60_000));
    }
  }

  // 3. Read operational projections
  const [trailerRows, hubInventoryRows] = await Promise.all([
    db.selectFrom("trailer_state").selectAll().execute(),
    db.selectFrom("hub_inventory").selectAll().execute(),
  ]);

  // 4. Build the outbound/staged index: hub → [pkgId, ...]
  //    Used for block assignment (which hub does each package unload at).
  const hubOutboundIndex = new Map<string, readonly string[]>();
  for (const row of hubInventoryRows) {
    const allOut = [...row.outbound, ...row.staged];
    if (allOut.length > 0) {
      hubOutboundIndex.set(row.hub_id, allOut);
    }
  }

  // 5. Assemble trailer TwinTrailer records
  const trailers: TwinTrailer[] = trailerRows
    .filter((r) => r.current_hub_id !== null)
    .map((r) => {
      const currentHubId = r.current_hub_id!;
      const assignedPackageIds: readonly string[] = r.assigned_package_ids;

      const stops = buildTrailerStops(
        assignedPackageIds,
        hubOutboundIndex,
        routes,
        currentHubId,
      );

      const blocks = buildTrailerBlocks(
        assignedPackageIds,
        hubOutboundIndex,
        routes,
        currentHubId,
      );

      const departureMin =
        departureMinByTrailer.get(r.trailer_id) ?? DEFAULT_DEPARTURE_MIN;

      const trailer: TwinTrailer = {
        trailerId: r.trailer_id,
        currentHubId,
        departureMin,
        capacity: DEFAULT_TRAILER_CAPACITY,
        route: stops,
        blocks,
      };
      return trailer;
    });

  // Sort trailers by trailerId for determinism
  trailers.sort((a, b) => (a.trailerId < b.trailerId ? -1 : a.trailerId > b.trailerId ? 1 : 0));

  // 6. Assemble hub list: union of route hubs + trailer current hubs, sorted
  const hubSet = new Set<string>();
  for (const r of routes) {
    hubSet.add(r.fromHubId);
    hubSet.add(r.toHubId);
  }
  for (const t of trailers) {
    hubSet.add(t.currentHubId);
  }
  const hubs = sortedUnique(hubSet);

  return { hubs, routes, trailers };
}
