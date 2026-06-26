import { haversineKm, type Hub } from "@mm/domain";
import type { BigCityHub } from "./hubs.js";

/**
 * Phase 23 (NET-02..04) — pure multi-center topology functions.
 *
 * These generalize the legacy single-center (Memphis) hub-and-spoke star into a
 * parameterized set of regional sort centers over a near-full-mesh backbone, with
 * stable, explainable, leg-capped spoke assignment. Everything here is a PURE
 * function of its inputs — NO clock, NO RNG, NO I/O — so the continental-topology
 * bootstrap (plan 23-04) is byte-reproducible. All id-keyed outputs are sorted and
 * every tie breaks by the LOWEST stable `hubId` (never array index / insertion
 * order), the anti-P12 determinism guard.
 *
 * The great-circle primitive is the shared `@mm/domain` {@link haversineKm} (the
 * SAME basis as the routes/twin/optimizer) — deliberately NOT a new geodesy dep,
 * which would threaten the flags-off golden.
 */

/**
 * Coordinate rounding precision (decimal places) applied before any distance
 * compare that could FLIP an assignment. Mirrors `hubCoordsChecksum`'s 6-dp
 * (~0.1 m) canonicalization (anti-P12 / T-23-06): sub-6dp float noise must never
 * re-partition a spoke or change the chosen center set.
 */
const COORD_DP = 6;

/**
 * Default number of regional centers. PARAMETERIZED, never hard-coded into the
 * selection logic — this constant is only a sensible default inside the locked
 * 4-8 empirical envelope; the CONCRETE production value is chosen empirically in
 * plan 23-05 (the center-count checkpoint). Callers pass an explicit `count`.
 */
export const DEFAULT_CENTER_COUNT = 6;

/**
 * Default spoke→center leg-length cap (km). A spoke whose nearest in-partition
 * center exceeds this falls back to the global nearest center within the cap
 * (documented overflow rule in {@link assignSpokesToNearestCenter}). 2500 km
 * comfortably spans the continental USA (coast-to-coast great-circle ≈ 4000 km,
 * but every spoke→nearest-center leg is far shorter), so no continental spoke is
 * orphaned while a pathological far-flung point would still be flagged.
 */
export const DEFAULT_LEG_CAP_KM = 2500;

/** Round a coordinate to {@link COORD_DP} dp (anti-P12 flip guard). */
function round6(n: number): number {
  const f = 10 ** COORD_DP;
  return Math.round(n * f) / f;
}

/** A `Hub` with 6-dp-rounded coordinates (stable distance basis). */
function canonHub<T extends Hub>(h: T): T {
  return { ...h, lat: round6(h.lat), lon: round6(h.lon) };
}

/** The freight-corridor partition key: Census region + IANA timezone band. */
function partitionKey(h: BigCityHub): string {
  return `${h.region}|${h.timezone}`;
}

/** Stable ascending `hubId` comparator. */
function byHubId(a: { hubId: string }, b: { hubId: string }): number {
  return a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0;
}

/**
 * Pick `count` regional centers as the largest-population hub per freight-corridor
 * (`region` + `timezone`) partition.
 *
 * Algorithm (deterministic, stable under input reordering):
 *  1. Group hubs by `region|timezone`; within each partition the representative is
 *     the MAX-population hub (tie → lowest `hubId`).
 *  2. Order the partition representatives by population DESC (tie → lowest
 *     `hubId`) — the documented "biggest corridors first" rule.
 *  3. Take the first `count` of them; clamp into `[2, partitionCount]` so it NEVER
 *     collapses to a single center and never asks for more than the partitions
 *     supply.
 *  4. Return them sorted ascending by `hubId`.
 *
 * `count` is a plain parameter (never a literal inside this module); the concrete
 * production default is {@link DEFAULT_CENTER_COUNT}, finalized in plan 23-05.
 */
export function pickRegionalCenters(
  hubs: readonly BigCityHub[],
  count: number,
): readonly BigCityHub[] {
  // 1. Largest-population representative per partition (tie -> lowest hubId).
  const repByPartition = new Map<string, BigCityHub>();
  for (const hub of hubs) {
    const key = partitionKey(hub);
    const current = repByPartition.get(key);
    if (
      current === undefined ||
      hub.population > current.population ||
      (hub.population === current.population && hub.hubId < current.hubId)
    ) {
      repByPartition.set(key, hub);
    }
  }

  // 2. Order representatives: population DESC, tie -> lowest hubId.
  const reps = [...repByPartition.values()].sort((a, b) =>
    b.population !== a.population ? b.population - a.population : byHubId(a, b),
  );

  // 3. Clamp the requested count into [2, partitionCount] (never < 2).
  const want = Math.max(2, Math.min(count, reps.length));

  // 4. Take the top `want`, return sorted by hubId (stable id-keyed output).
  return reps.slice(0, want).sort(byHubId);
}

/**
 * Assign each spoke to exactly one center under a leg-length cap, returning a
 * `ReadonlyMap<spokeHubId, centerHubId>`.
 *
 * Rule (deterministic, stable, id-tie-broken):
 *  - Iterate spokes in sorted `hubId` order (output order independent of input).
 *  - Compute the great-circle ({@link haversineKm}) distance to every center on
 *    6-dp-rounded coordinates (anti-P12: a sub-6dp nudge can never flip the pick).
 *  - PREFER the nearest center in the SAME `region|timezone` partition; if that
 *    in-partition nearest is within `legCapKm`, take it.
 *  - OTHERWISE fall back to the GLOBAL nearest center within `legCapKm`
 *    (documented overflow rule — keeps an off-corridor spoke connected).
 *  - If no center is within the cap at all, assign the global nearest anyway (a
 *    spoke must have a center; the over-cap leg is the explainable last resort).
 *  - All distance ties break by the LOWEST center `hubId`.
 */
export function assignSpokesToNearestCenter(
  spokes: readonly BigCityHub[],
  centers: readonly BigCityHub[],
  legCapKm: number,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (centers.length === 0) return out;

  const canonCenters = centers.map(canonHub);
  const sortedSpokes = [...spokes].sort(byHubId);

  for (const rawSpoke of sortedSpokes) {
    const spoke = canonHub(rawSpoke);

    // Best (nearest, id-tie-broken) center over a candidate subset.
    const bestOf = (candidates: readonly BigCityHub[]): BigCityHub | undefined => {
      let best: BigCityHub | undefined;
      let bestDist = Infinity;
      for (const c of candidates) {
        const d = haversineKm(spoke, c);
        if (d < bestDist || (d === bestDist && best !== undefined && c.hubId < best.hubId)) {
          best = c;
          bestDist = d;
        }
      }
      return best;
    };

    // 1. In-partition nearest within the cap.
    const inPartition = canonCenters.filter((c) => partitionKey(c) === partitionKey(spoke));
    const partitionBest = bestOf(inPartition);
    if (partitionBest !== undefined && haversineKm(spoke, partitionBest) <= legCapKm) {
      out.set(rawSpoke.hubId, partitionBest.hubId);
      continue;
    }

    // 2. Global nearest within the cap (overflow fallback).
    const globalBest = bestOf(canonCenters)!;
    out.set(rawSpoke.hubId, globalBest.hubId);
  }

  return out;
}

/** One directed backbone leg between two centers (geometry is built in 23-04). */
export interface BackboneLeg {
  readonly fromHubId: string;
  readonly toHubId: string;
}

/**
 * Build the near-FULL-MESH inter-center backbone: every ordered (directed) pair of
 * distinct centers. For `n` centers this is `n*(n-1)` directed legs — cheap at the
 * ≤8 centers NET-04 envelope (≤56 legs) — and gives ≤2-hop coast-to-coast routing
 * (any center reaches any other in one direct leg). Returned in a stable sorted
 * order (by `fromHubId`, then `toHubId`); no self-pairs. Geometry (the
 * `greatCircle` arc) is attached by the route builder in plan 23-04.
 */
export function buildBackbone(centers: readonly BigCityHub[]): readonly BackboneLeg[] {
  const sorted = [...centers].sort(byHubId);
  const legs: BackboneLeg[] = [];
  for (const from of sorted) {
    for (const to of sorted) {
      if (from.hubId === to.hubId) continue;
      legs.push({ fromHubId: from.hubId, toHubId: to.hubId });
    }
  }
  return legs;
}

/**
 * Anti-SPOF (NET-04, T-23-07): `true` iff removing ANY single center leaves the
 * remaining center graph CONNECTED. A near-full mesh passes; a hub-of-hubs star
 * FAILS (removing the central hub shatters the rest), which is exactly the
 * re-centralization / single-point-of-failure regression this guards against.
 *
 * Pure BFS over the undirected backbone adjacency, looping the removal of each
 * center. Connectivity is checked over the REMAINING centers only (each removal
 * leaves `n-1` nodes; with `n <= 2`, removing one leaves a single node, which is
 * trivially connected — so a 2-center mesh passes).
 */
export function isConnectedWithoutAnyCenter(
  centers: readonly BigCityHub[],
  backbone: readonly BackboneLeg[],
): boolean {
  const ids = centers.map((c) => c.hubId).sort();
  if (ids.length <= 1) return true;

  // Undirected adjacency from the (directed) backbone legs.
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set<string>());
  for (const leg of backbone) {
    adj.get(leg.fromHubId)?.add(leg.toHubId);
    adj.get(leg.toHubId)?.add(leg.fromHubId);
  }

  for (const removed of ids) {
    const remaining = ids.filter((id) => id !== removed);
    if (remaining.length <= 1) continue; // single node is trivially connected

    // BFS from a deterministic start over the remaining graph.
    const start = remaining[0]!;
    const seen = new Set<string>([start]);
    const queue: string[] = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const neighbor of adj.get(node) ?? new Set<string>()) {
        if (neighbor === removed || seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    if (seen.size !== remaining.length) return false; // disconnected without `removed`
  }
  return true;
}
