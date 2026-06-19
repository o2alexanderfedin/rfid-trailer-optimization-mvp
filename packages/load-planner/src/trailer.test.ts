import { describe, expect, it } from "vitest";
import { trailerSliceSchema } from "@mm/domain";
import { emptyTrailer, zoneForDepth } from "./trailer.js";

/**
 * Task 2 — the trailer rear-to-nose slice model (LOAD-01).
 *
 * `emptyTrailer` builds the ordered slice sequence the planner places into;
 * `zoneForDepth` derives the human nose/middle/rear zone label (for the
 * dock-worker instructions, LOAD-08) from a slice's depth. The canonical
 * convention is asserted here: **depth 0 = rear** (easiest access), increasing
 * toward the nose.
 */

describe("emptyTrailer (LOAD-01 rear-to-nose slice model)", () => {
  it("returns sliceCount slices in ascending-depth order, depth 0..n-1", () => {
    const slices = emptyTrailer("TR-1", 4, 10, 100);
    expect(slices).toHaveLength(4);
    expect(slices.map((s) => s.depth)).toEqual([0, 1, 2, 3]);
  });

  it("places depth 0 first — the rear door (easiest access)", () => {
    const slices = emptyTrailer("TR-1", 3, 10, 100);
    expect(slices[0]?.depth).toBe(0);
  });

  it("gives every slice the supplied capacities and zero used vol/weight", () => {
    const slices = emptyTrailer("TR-1", 3, 12, 250);
    for (const s of slices) {
      expect(s.capacityVolume).toBe(12);
      expect(s.capacityWeight).toBe(250);
      expect(s.usedVolume).toBe(0);
      expect(s.usedWeight).toBe(0);
      expect(s.loadBlockIds).toEqual([]);
    }
  });

  it("produces slices that satisfy the @mm/domain TrailerSlice schema", () => {
    for (const s of emptyTrailer("TR-1", 5, 8, 80)) {
      expect(() => trailerSliceSchema.parse(s)).not.toThrow();
    }
  });

  it("each slice has an independent loadBlockIds array (no shared mutable state)", () => {
    const slices = emptyTrailer("TR-1", 3, 10, 100);
    slices[0]?.loadBlockIds.push("LB-X");
    expect(slices[1]?.loadBlockIds).toEqual([]);
    expect(slices[2]?.loadBlockIds).toEqual([]);
  });

  it("returns a single rear slice for sliceCount 1", () => {
    const slices = emptyTrailer("TR-1", 1, 10, 100);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.depth).toBe(0);
  });

  it("returns an empty trailer for sliceCount 0", () => {
    expect(emptyTrailer("TR-1", 0, 10, 100)).toEqual([]);
  });

  it("rejects a negative, non-integer, or capacity-non-positive trailer", () => {
    expect(() => emptyTrailer("TR-1", -1, 10, 100)).toThrow();
    expect(() => emptyTrailer("TR-1", 2.5, 10, 100)).toThrow();
    expect(() => emptyTrailer("TR-1", 3, 0, 100)).toThrow();
    expect(() => emptyTrailer("TR-1", 3, 10, 0)).toThrow();
    expect(() => emptyTrailer("", 3, 10, 100)).toThrow();
  });
});

describe("zoneForDepth (nose/middle/rear zone labels by depth thirds)", () => {
  it("labels the lowest third 'rear' and the highest third 'nose' (6 slices)", () => {
    // depths 0..5: thirds at [0,1]=rear, [2,3]=middle, [4,5]=nose
    expect(zoneForDepth(0, 6)).toBe("rear");
    expect(zoneForDepth(1, 6)).toBe("rear");
    expect(zoneForDepth(2, 6)).toBe("middle");
    expect(zoneForDepth(3, 6)).toBe("middle");
    expect(zoneForDepth(4, 6)).toBe("nose");
    expect(zoneForDepth(5, 6)).toBe("nose");
  });

  it("handles non-divisible counts deterministically (5 slices)", () => {
    // floor(depth*3/5): d0→0, d1→0 (rear); d2→1, d3→1 (middle); d4→2 (nose)
    expect(zoneForDepth(0, 5)).toBe("rear");
    expect(zoneForDepth(1, 5)).toBe("rear");
    expect(zoneForDepth(2, 5)).toBe("middle");
    expect(zoneForDepth(3, 5)).toBe("middle");
    expect(zoneForDepth(4, 5)).toBe("nose");
  });

  it("handles a count not divisible by 3 (4 slices) via the floor(depth*3/n) rule", () => {
    // floor(depth*3/4): d0→0 rear, d1→0 rear, d2→1 middle, d3→2 nose
    expect(zoneForDepth(0, 4)).toBe("rear");
    expect(zoneForDepth(1, 4)).toBe("rear");
    expect(zoneForDepth(2, 4)).toBe("middle");
    expect(zoneForDepth(3, 4)).toBe("nose");
  });

  it("labels a single-slice trailer 'rear' (the rear door)", () => {
    expect(zoneForDepth(0, 1)).toBe("rear");
  });

  it("labels a two-slice trailer rear then middle (floor(depth*3/2))", () => {
    // floor(depth*3/2): d0→0 rear, d1→floor(1.5)=1 middle
    expect(zoneForDepth(0, 2)).toBe("rear");
    expect(zoneForDepth(1, 2)).toBe("middle");
  });

  it("is monotone: zone never moves toward the rear as depth increases", () => {
    const order = { rear: 0, middle: 1, nose: 2 } as const;
    for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
      let prev = -1;
      for (let d = 0; d < n; d += 1) {
        const rank = order[zoneForDepth(d, n)];
        expect(rank).toBeGreaterThanOrEqual(prev);
        prev = rank;
      }
    }
  });

  it("rejects out-of-range or invalid arguments", () => {
    expect(() => zoneForDepth(-1, 5)).toThrow();
    expect(() => zoneForDepth(5, 5)).toThrow(); // depth must be < sliceCount
    expect(() => zoneForDepth(0, 0)).toThrow();
    expect(() => zoneForDepth(1.5, 5)).toThrow();
  });
});
