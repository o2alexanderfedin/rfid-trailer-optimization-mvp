import {
  type BlockKey,
  type LoadBlock,
  type TrailerSlice,
} from "@mm/domain";
import { describe, expect, it } from "vitest";
import { instructions } from "./instructions.js";
import type { LoadPlan } from "./types.js";

/**
 * Task 2a — zone-ordered loading instructions (LOAD-08).
 *
 * `instructions(plan, blocks)` renders the dock-worker loading card: placements
 * grouped by `zoneForDepth` into nose/middle/rear, listed in PHYSICAL LOAD ORDER
 * (nose loaded first → rear last), each line naming the block + its destination
 * hub. Deterministic for a given plan.
 */

function keyFor(nextUnloadHubId: string): BlockKey {
  return {
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass: "standard",
    deadlineBucket: 0,
    handlingClass: "standard",
    sizeWeightClass: "small",
  };
}

function block(loadBlockId: string, nextUnloadHubId: string): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume: 1,
    totalWeight: 1,
    priority: 0,
  };
}

function slice(depth: number, loadBlockIds: string[]): TrailerSlice {
  return {
    depth,
    capacityVolume: 100,
    capacityWeight: 1000,
    usedVolume: loadBlockIds.length,
    usedWeight: loadBlockIds.length,
    loadBlockIds,
  };
}

describe("instructions — zone-ordered loading card (LOAD-08)", () => {
  // A 3-slice trailer: depth 0 = rear, depth 1 = middle, depth 2 = nose.
  // Earliest-unload (H1) at the rear, latest (H3) at the nose — correct LIFO.
  const plan: LoadPlan = {
    trailerId: "TR-1",
    slices: [
      slice(0, ["LB-H1"]),
      slice(1, ["LB-H2"]),
      slice(2, ["LB-H3"]),
    ],
    placements: [],
  };
  const blocks = [
    block("LB-H1", "H1"),
    block("LB-H2", "H2"),
    block("LB-H3", "H3"),
  ];

  it("returns one entry per zone in nose→middle→rear physical load order", () => {
    const card = instructions(plan, blocks);
    expect(card.zones.map((z) => z.zone)).toEqual(["nose", "middle", "rear"]);
  });

  it("places each block under its correct zone with its destination hub", () => {
    const card = instructions(plan, blocks);
    const nose = card.zones.find((z) => z.zone === "nose");
    const middle = card.zones.find((z) => z.zone === "middle");
    const rear = card.zones.find((z) => z.zone === "rear");
    expect(nose?.lines).toEqual([{ loadBlockId: "LB-H3", destHubId: "H3" }]);
    expect(middle?.lines).toEqual([{ loadBlockId: "LB-H2", destHubId: "H2" }]);
    expect(rear?.lines).toEqual([{ loadBlockId: "LB-H1", destHubId: "H1" }]);
  });

  it("renders a human-readable text card naming blocks + hubs by zone", () => {
    const card = instructions(plan, blocks);
    expect(card.text).toContain("Nose");
    expect(card.text).toContain("Middle");
    expect(card.text).toContain("Rear");
    expect(card.text).toContain("LB-H3");
    expect(card.text).toContain("H3");
    // load order: nose appears before rear in the rendered card.
    expect(card.text.indexOf("Nose")).toBeLessThan(card.text.indexOf("Rear"));
  });

  it("is deterministic (same plan ⇒ identical card)", () => {
    expect(instructions(plan, blocks)).toEqual(instructions(plan, blocks));
  });

  it("lists multiple blocks in one slice deterministically (id-ordered)", () => {
    const multi: LoadPlan = {
      trailerId: "TR-1",
      slices: [slice(0, ["LB-B", "LB-A"])], // single slice ⇒ all 'rear'
      placements: [],
    };
    const b = [block("LB-A", "H1"), block("LB-B", "H1")];
    const card = instructions(multi, b);
    const rear = card.zones.find((z) => z.zone === "rear");
    expect(rear?.lines.map((l) => l.loadBlockId)).toEqual(["LB-A", "LB-B"]);
  });

  it("omits empty zones (only zones with placed blocks appear)", () => {
    const single: LoadPlan = {
      trailerId: "TR-1",
      slices: [slice(0, ["LB-H1"])],
      placements: [],
    };
    const card = instructions(single, [block("LB-H1", "H1")]);
    expect(card.zones.map((z) => z.zone)).toEqual(["rear"]);
  });
});
