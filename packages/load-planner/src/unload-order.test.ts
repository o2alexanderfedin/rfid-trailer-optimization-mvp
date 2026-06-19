import { describe, expect, it } from "vitest";
import type { RouteStop } from "@mm/domain";
import { buildUnloadOrderMap } from "./unload-order.js";

/**
 * Task 2 — the route unload-order map (LOAD-02).
 *
 * `buildUnloadOrderMap(route)` turns an ordered `RouteStop[]` into a
 * `Map<hubId, orderIndex>` where an EARLIER stop ⇒ a LOWER order index. Per the
 * canonical invariant, a lower order ⇒ the block belongs at a LOWER depth
 * (nearer the rear door). This is the single bridge from "route stop sequence"
 * to "depth target", so it is pinned exactly here.
 */

function stop(hubId: string, stopIndex: number): RouteStop {
  return { hubId, stopIndex };
}

describe("buildUnloadOrderMap (LOAD-02)", () => {
  it("maps an earlier stop to a lower order index", () => {
    const route: RouteStop[] = [stop("H1", 0), stop("H2", 1), stop("H3", 2)];
    const map = buildUnloadOrderMap(route);
    expect(map.get("H1")).toBe(0);
    expect(map.get("H2")).toBe(1);
    expect(map.get("H3")).toBe(2);
  });

  it("orders by stopIndex, not array position (input order independent)", () => {
    // Same route, supplied out of stopIndex order — earlier-unload must still win.
    const route: RouteStop[] = [stop("H3", 2), stop("H1", 0), stop("H2", 1)];
    const map = buildUnloadOrderMap(route);
    expect(map.get("H1")).toBeLessThan(map.get("H2") ?? Infinity);
    expect(map.get("H2")).toBeLessThan(map.get("H3") ?? Infinity);
    expect(map.get("H1")).toBe(0);
    expect(map.get("H2")).toBe(1);
    expect(map.get("H3")).toBe(2);
  });

  it("produces a dense 0..k-1 ranking even when stopIndex values are sparse", () => {
    // The order index is the RANK in the remaining route, not the raw stopIndex.
    const route: RouteStop[] = [stop("A", 10), stop("B", 20), stop("C", 99)];
    const map = buildUnloadOrderMap(route);
    expect(map.get("A")).toBe(0);
    expect(map.get("B")).toBe(1);
    expect(map.get("C")).toBe(2);
  });

  it("collapses duplicate hubs to their first (earliest) occurrence", () => {
    // A hub appearing twice (e.g., revisited) maps to its earliest unload rank.
    const route: RouteStop[] = [
      stop("H1", 0),
      stop("H2", 1),
      stop("H1", 2), // duplicate — must NOT override the order-0 mapping
    ];
    const map = buildUnloadOrderMap(route);
    expect(map.get("H1")).toBe(0);
    expect(map.get("H2")).toBe(1);
    expect(map.size).toBe(2);
  });

  it("is deterministic — identical input yields identical maps", () => {
    const route: RouteStop[] = [stop("H2", 1), stop("H1", 0), stop("H3", 2)];
    const a = buildUnloadOrderMap(route);
    const b = buildUnloadOrderMap(route);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("returns an empty map for an empty route", () => {
    expect(buildUnloadOrderMap([]).size).toBe(0);
  });

  it("handles a single-stop route", () => {
    const map = buildUnloadOrderMap([stop("ONLY", 0)]);
    expect(map.get("ONLY")).toBe(0);
    expect(map.size).toBe(1);
  });

  it("breaks stopIndex ties deterministically by first occurrence", () => {
    // Two stops sharing a stopIndex (degenerate input) — stable, deterministic order.
    const route: RouteStop[] = [stop("A", 1), stop("B", 1), stop("C", 0)];
    const map = buildUnloadOrderMap(route);
    expect(map.get("C")).toBe(0); // lowest stopIndex first
    // A and B tie; first-seen (A) ranks before B
    expect(map.get("A")).toBe(1);
    expect(map.get("B")).toBe(2);
  });

  it("rejects an invalid route (bad hubId or non-integer stopIndex)", () => {
    expect(() => buildUnloadOrderMap([stop("", 0)])).toThrow();
    expect(() => buildUnloadOrderMap([stop("H1", -1)])).toThrow();
    expect(() => buildUnloadOrderMap([stop("H1", 1.5)])).toThrow();
  });
});
