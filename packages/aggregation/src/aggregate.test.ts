import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  loadBlockSchema,
  type PlannerConfig,
  type PlanningPackage,
  SLA_CLASS_WEIGHT,
} from "@mm/domain";
import { aggregate } from "./aggregate.js";
import { deadlineBucket } from "./deadline-bucket.js";

/**
 * AGG-01 / AGG-02 / AGG-04 — aggregate(packages, config):
 *  - groups by the 7-part BlockKey (deadlineBucket DERIVED from deadline+sla),
 *  - sums volume/weight, counts packages,
 *  - assigns priority via blockPriority,
 *  - returns LoadBlock[] in a STABLE deterministic order,
 *  - applies splitBlock so output is all-feasible.
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
    volume: 3,
    weight: 7,
    ...over,
  };
}

const cfg: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, maxBlockVolume: 1000 };

describe("aggregate — grouping (AGG-01)", () => {
  it("merges packages with identical keys into one block", () => {
    const ps = [pkg(), pkg(), pkg()];
    const blocks = aggregate(ps, cfg);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.packageIds.sort()).toStrictEqual(
      ps.map((p) => p.packageId).sort(),
    );
  });

  it.each([
    ["currentHubId", { currentHubId: "HX" }],
    ["nextUnloadHubId", { nextUnloadHubId: "HX" }],
    ["finalDestHubId", { finalDestHubId: "HX" }],
    ["slaClass", { slaClass: "express" as const }],
    ["handlingClass", { handlingClass: "heavy" as const }],
    ["sizeWeightClass", { sizeWeightClass: "large" as const }],
  ])("differing on %s splits into separate blocks", (_axis, diff) => {
    const blocks = aggregate([pkg(), pkg(diff)], cfg);
    expect(blocks).toHaveLength(2);
  });

  it("differing only on deadlineBucket (derived) splits into separate blocks", () => {
    // express width = 1h; deadlines 0 and 10h fall in different buckets.
    const a = pkg({ slaClass: "express", deadline: 0 });
    const b = pkg({ slaClass: "express", deadline: 10 * 3_600_000 });
    const blocks = aggregate([a, b], cfg);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((x) => x.key.deadlineBucket).sort((m, n) => m - n)).toStrictEqual(
      [deadlineBucket(0, "express"), deadlineBucket(10 * 3_600_000, "express")].sort(
        (m, n) => m - n,
      ),
    );
  });

  it("DERIVES deadlineBucket from deadline+sla, ignoring the input bucket field", () => {
    // Input carries a bogus deadlineBucket; aggregate must recompute it.
    const p = pkg({ slaClass: "standard", deadline: 24 * 3_600_000, deadlineBucket: 999 });
    const blocks = aggregate([p], cfg);
    expect(blocks[0]!.key.deadlineBucket).toBe(
      deadlineBucket(24 * 3_600_000, "standard"),
    );
    expect(blocks[0]!.key.deadlineBucket).not.toBe(999);
  });
});

describe("aggregate — aggregates (AGG-02)", () => {
  it("sums volume/weight and counts packages", () => {
    const ps = [
      pkg({ volume: 2, weight: 5 }),
      pkg({ volume: 3, weight: 6 }),
      pkg({ volume: 4, weight: 7 }),
    ];
    const [block] = aggregate(ps, cfg);
    expect(block!.totalVolume).toBeCloseTo(9, 9);
    expect(block!.totalWeight).toBeCloseTo(18, 9);
    expect(block!.packageCount).toBe(3);
    expect(block!.packageCount).toBe(block!.packageIds.length);
  });

  it("produces blocks that satisfy the domain loadBlockSchema", () => {
    const blocks = aggregate([pkg(), pkg({ slaClass: "express" })], cfg);
    for (const b of blocks) {
      expect(() => loadBlockSchema.parse(b)).not.toThrow();
    }
  });
});

describe("aggregate — priority (AGG-04)", () => {
  it("assigns a higher priority to the higher-SLA block", () => {
    const blocks = aggregate(
      [pkg({ slaClass: "economy" }), pkg({ slaClass: "express" })],
      cfg,
    );
    const express = blocks.find((b) => b.key.slaClass === "express")!;
    const economy = blocks.find((b) => b.key.slaClass === "economy")!;
    expect(express.priority).toBeGreaterThan(economy.priority);
  });

  it("uses the block's EARLIEST member deadline as the priority tiebreak", () => {
    // Same key, two deadlines in the same bucket but different ms: priority must
    // reflect the earliest. Compare against a later-only block in another key.
    const early = aggregate(
      [
        pkg({ slaClass: "standard", deadline: 1_000 }),
        pkg({ slaClass: "standard", deadline: 9_000 }),
      ],
      cfg,
    )[0]!;
    const late = aggregate(
      [pkg({ slaClass: "standard", currentHubId: "HZ", deadline: 9_000 })],
      cfg,
    )[0]!;
    // both same SLA + same bucket(0); earliest-deadline block ranks higher.
    expect(early.priority).toBeGreaterThan(late.priority);
  });

  it("priority is consistent with SLA_CLASS_WEIGHT ordering across all classes", () => {
    const blocks = aggregate(
      [
        pkg({ slaClass: "express", currentHubId: "A" }),
        pkg({ slaClass: "priority", currentHubId: "B" }),
        pkg({ slaClass: "standard", currentHubId: "C" }),
        pkg({ slaClass: "economy", currentHubId: "D" }),
      ],
      cfg,
    );
    const sorted = [...blocks].sort((a, b) => b.priority - a.priority);
    const weights = sorted.map((b) => SLA_CLASS_WEIGHT[b.key.slaClass]);
    expect(weights).toStrictEqual([...weights].sort((a, b) => b - a));
  });
});

describe("aggregate — determinism & stable ordering", () => {
  it("returns the SAME blocks (and order) for shuffled input", () => {
    const base = [
      pkg({ currentHubId: "A", slaClass: "express" }),
      pkg({ currentHubId: "B", slaClass: "economy" }),
      pkg({ currentHubId: "C", slaClass: "standard" }),
      pkg({ currentHubId: "A", slaClass: "express" }),
    ];
    const shuffled = [base[2]!, base[0]!, base[3]!, base[1]!];
    const a = aggregate(base, cfg);
    const b = aggregate(shuffled, cfg);
    // Compare by canonical projection independent of packageId ordering inside.
    const norm = (bs: typeof a) =>
      bs.map((x) => ({ key: x.key, ids: [...x.packageIds].sort() }));
    expect(norm(a)).toStrictEqual(norm(b));
  });

  it("orders blocks by a canonical key tuple (not input/Map order)", () => {
    const blocks = aggregate(
      [
        pkg({ currentHubId: "Z" }),
        pkg({ currentHubId: "A" }),
        pkg({ currentHubId: "M" }),
      ],
      cfg,
    );
    const hubs = blocks.map((b) => b.key.currentHubId);
    expect(hubs).toStrictEqual([...hubs].sort());
  });

  it("assigns distinct loadBlockIds derived deterministically from the key", () => {
    const a = aggregate([pkg({ currentHubId: "A" }), pkg({ currentHubId: "B" })], cfg);
    const b = aggregate([pkg({ currentHubId: "B" }), pkg({ currentHubId: "A" })], cfg);
    expect(a.map((x) => x.loadBlockId)).toStrictEqual(b.map((x) => x.loadBlockId));
    expect(new Set(a.map((x) => x.loadBlockId)).size).toBe(a.length);
  });
});

describe("aggregate — all-feasible output (AGG-03 composition)", () => {
  it("splits an over-volume group so every returned block is <= maxBlockVolume", () => {
    const tight: PlannerConfig = { ...cfg, maxBlockVolume: 10 };
    const ps = [
      pkg({ volume: 6 }),
      pkg({ volume: 6 }),
      pkg({ volume: 6 }),
      pkg({ volume: 6 }),
    ]; // total 24, one key
    const blocks = aggregate(ps, tight);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) {
      expect(b.totalVolume).toBeLessThanOrEqual(tight.maxBlockVolume);
    }
    // conservation
    const ids = blocks.flatMap((b) => b.packageIds).sort();
    expect(ids).toStrictEqual(ps.map((p) => p.packageId).sort());
  });

  it("empty input => empty output", () => {
    expect(aggregate([], cfg)).toStrictEqual([]);
  });
});
