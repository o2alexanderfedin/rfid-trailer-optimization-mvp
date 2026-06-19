import { type RouteStop, routeStopSchema } from "@mm/domain";

/**
 * The route unload-order map (LOAD-02) — the single bridge from route stop
 * sequence to depth target.
 *
 * `buildUnloadOrderMap(route)` returns `Map<hubId, orderIndex>` where an EARLIER
 * stop ⇒ a LOWER order index. Per the canonical invariant
 * (`lifo-invariant.ts`), a lower order ⇒ the block belongs at a LOWER depth
 * (nearer the rear door). The order index is a DENSE rank `0 .. k-1` over the
 * distinct hubs (not the raw, possibly-sparse `stopIndex`), so it drops straight
 * into the depth target without gaps.
 *
 * Determinism (PITFALLS P3): hubs are ranked by `stopIndex` ascending with a
 * stable first-occurrence tie-break; duplicate hubs collapse to their earliest
 * occurrence. Same input ⇒ same map. Pure: imports only `@mm/domain`, no clock,
 * no RNG.
 */

/**
 * Build the unload-order map from an ordered (or unordered) `RouteStop[]`.
 *
 * Each stop is validated against the domain `routeStopSchema` (non-empty hub id,
 * non-negative integer `stopIndex`). Stops are ranked by `stopIndex` ascending;
 * ties and duplicate hubs are broken by first occurrence in the input. The first
 * time a hub is seen (in ranked order) fixes its order index; later occurrences
 * of the same hub are ignored.
 *
 * @returns a `Map<hubId, number>` with a dense `0 .. distinctHubCount-1` ranking.
 */
export function buildUnloadOrderMap(route: readonly RouteStop[]): Map<string, number> {
  // Validate + keep the original input index for a stable tie-break.
  const indexed = route.map((raw, inputIndex) => ({
    stop: routeStopSchema.parse(raw),
    inputIndex,
  }));

  // Rank by stopIndex ascending; break ties by original input order (stable,
  // deterministic — no reliance on Array.sort tie behaviour for equal keys).
  const ranked = [...indexed].sort((a, b) => {
    if (a.stop.stopIndex !== b.stop.stopIndex) {
      return a.stop.stopIndex - b.stop.stopIndex;
    }
    return a.inputIndex - b.inputIndex;
  });

  const orderMap = new Map<string, number>();
  let nextOrder = 0;
  for (const { stop } of ranked) {
    // Collapse duplicates to the earliest (lowest-ranked) occurrence.
    if (!orderMap.has(stop.hubId)) {
      orderMap.set(stop.hubId, nextOrder);
      nextOrder += 1;
    }
  }
  return orderMap;
}
