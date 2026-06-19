import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type HandlingClass,
  type PlannerConfig,
  type PlanningPackage,
} from "@mm/domain";
import { aggregate } from "./aggregate.js";
import { splitBlock } from "./split.js";

/**
 * AGG-03 / splitBlock: split a block into feasible sub-blocks when its aggregate
 * volume exceeds `config.maxBlockVolume` OR when it mixes incompatible handling
 * (fragile members must not share a block with heavy members). Deterministic,
 * stable, idempotent. A block already feasible returns `[block]` unchanged.
 */

let seq = 0;
function pkg(over: Partial<PlanningPackage> = {}): PlanningPackage {
  seq += 1;
  return {
    packageId: `P${String(seq).padStart(3, "0")}`,
    currentHubId: "H1",
    nextUnloadHubId: "H2",
    finalDestHubId: "H3",
    slaClass: "standard",
    handlingClass: "standard",
    sizeWeightClass: "small",
    deadline: 1_000_000,
    deadlineBucket: 0,
    volume: 5,
    weight: 10,
    ...over,
  };
}

const cfg: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, maxBlockVolume: 20 };

/** Build a single (one-key) block from packages via aggregate; assert it is one. */
function oneBlock(packages: PlanningPackage[]) {
  const blocks = aggregateNoSplit(packages);
  expect(blocks).toHaveLength(1);
  return { block: blocks[0]!, packages };
}

/**
 * Aggregate WITHOUT the all-feasible split, so split tests control splitting
 * directly. We reuse the public aggregate then "merge back" only when the input
 * is small enough not to split — for over-volume fixtures we build the raw block
 * via a tiny helper instead.
 */
function aggregateNoSplit(packages: PlanningPackage[]) {
  // For split tests we want the pre-split grouping. `aggregate` already splits,
  // so we instead construct the combined block by aggregating a feasible subset
  // is not possible; use the exported raw grouping via aggregate with a huge cap.
  return aggregate(packages, { ...cfg, maxBlockVolume: Number.MAX_SAFE_INTEGER });
}

describe("splitBlock — volume", () => {
  it("returns the block unchanged when already feasible", () => {
    const ps = [pkg({ volume: 5 }), pkg({ volume: 5 })]; // total 10 ≤ 20
    const { block, packages } = oneBlock(ps);
    const out = splitBlock(block, packages, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toStrictEqual(block);
  });

  it("splits an over-volume block into >=2 sub-blocks each <= maxBlockVolume", () => {
    const ps = [
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
    ]; // total 32 > 20
    const { block, packages } = oneBlock(ps);
    const out = splitBlock(block, packages, cfg);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const b of out) {
      expect(b.totalVolume).toBeLessThanOrEqual(cfg.maxBlockVolume);
    }
  });

  it("preserves the key and conserves packages/volume/weight across the split", () => {
    const ps = [
      pkg({ volume: 9, weight: 11 }),
      pkg({ volume: 9, weight: 12 }),
      pkg({ volume: 9, weight: 13 }),
    ]; // total vol 27 > 20
    const { block, packages } = oneBlock(ps);
    const out = splitBlock(block, packages, cfg);

    const totalPkgs = out.flatMap((b) => b.packageIds).sort();
    expect(totalPkgs).toStrictEqual(packages.map((p) => p.packageId).sort());

    const sumVol = out.reduce((s, b) => s + b.totalVolume, 0);
    const sumWt = out.reduce((s, b) => s + b.totalWeight, 0);
    expect(sumVol).toBeCloseTo(27, 9);
    expect(sumWt).toBeCloseTo(36, 9);
    for (const b of out) {
      expect(b.key).toStrictEqual(block.key);
      expect(b.packageCount).toBe(b.packageIds.length);
    }
  });

  it("is deterministic and stable: same input => identical split (incl. order)", () => {
    const ps = [pkg({ volume: 8 }), pkg({ volume: 8 }), pkg({ volume: 8 })];
    const { block, packages } = oneBlock(ps);
    const a = splitBlock(block, packages, cfg);
    const b = splitBlock(block, packages, cfg);
    expect(a).toStrictEqual(b);
  });

  it("is idempotent: re-splitting each produced sub-block yields itself", () => {
    const ps = [
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
      pkg({ volume: 8 }),
    ];
    const { block, packages } = oneBlock(ps);
    const out = splitBlock(block, packages, cfg);
    for (const sub of out) {
      const members = packages.filter((p) => sub.packageIds.includes(p.packageId));
      const reSplit = splitBlock(sub, members, cfg);
      expect(reSplit).toStrictEqual([sub]);
    }
  });
});

describe("splitBlock — handling incompatibility (fragile ⊄ heavy)", () => {
  // A hand-built block whose members mix fragile + heavy (same key otherwise).
  function mixedBlock() {
    const fragile = pkg({ handlingClass: "fragile", volume: 2 });
    const heavy = pkg({ handlingClass: "heavy", volume: 2 });
    // Force a single block by aggregating with handlingClass NOT in the key —
    // but handlingClass IS a key axis, so instead we construct the block by hand.
    const packages: PlanningPackage[] = [fragile, heavy];
    const block = {
      loadBlockId: "LB-mixed",
      key: {
        currentHubId: "H1",
        nextUnloadHubId: "H2",
        finalDestHubId: "H3",
        slaClass: "standard" as const,
        deadlineBucket: 0,
        handlingClass: "fragile" as HandlingClass,
        sizeWeightClass: "small" as const,
      },
      packageIds: [fragile.packageId, heavy.packageId],
      packageCount: 2,
      totalVolume: 4,
      totalWeight: 20,
      priority: 0,
    };
    return { block, packages };
  }

  it("splits a fragile+heavy block so no sub-block mixes the two", () => {
    const { block, packages } = mixedBlock();
    const out = splitBlock(block, packages, cfg);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const sub of out) {
      const classes = new Set(
        packages
          .filter((p) => sub.packageIds.includes(p.packageId))
          .map((p) => p.handlingClass),
      );
      expect(classes.has("fragile") && classes.has("heavy")).toBe(false);
    }
  });

  it("does not split a fragile-only block (no heavy => no incompatibility)", () => {
    const ps = [pkg({ handlingClass: "fragile", volume: 2 }), pkg({ handlingClass: "fragile", volume: 2 })];
    const { block, packages } = oneBlock(ps);
    const out = splitBlock(block, packages, cfg);
    expect(out).toHaveLength(1);
  });
});
