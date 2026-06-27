import type { TwinSnapshot } from "@mm/optimizer";

/**
 * Phase-26 COORD-06 (Plan 01) — the PURE in-fold adapter between one center's
 * engine fold state and the proven `@mm/optimizer` core (RED stub).
 */

/** One in-region trailer's plain-data fold slice (integer/string only). */
export interface CenterFoldTrailer {
  readonly trailerId: string;
  readonly currentHubId: string;
  readonly departureOffsetMin: number;
  readonly capacity: number;
  readonly routeStops: readonly { readonly hubId: string; readonly stopIndex: number }[];
  readonly blocks: readonly {
    readonly blockId: string;
    readonly nextUnloadHubId: string;
    readonly volume: number;
  }[];
}

/** One in-scope route leg's plain-data fold slice. */
export interface CenterFoldRouteLeg {
  readonly routeId: string;
  readonly fromHubId: string;
  readonly toHubId: string;
  readonly travelMin: number;
  readonly capacity: number;
  readonly distanceMiles?: number;
}

/** One center's partitioned, plain-data fold slice. */
export interface CenterFoldSlice {
  readonly centerId: string;
  readonly spokeHubIds: readonly string[];
  readonly trailers: readonly CenterFoldTrailer[];
  readonly routeLegs: readonly CenterFoldRouteLeg[];
}

export function buildCenterTwinFromFold(
  _slice: CenterFoldSlice,
  _nowMin: number,
): TwinSnapshot {
  // RED stub — intentionally wrong; the GREEN implementation follows.
  return { hubs: [], routes: [], trailers: [] };
}
