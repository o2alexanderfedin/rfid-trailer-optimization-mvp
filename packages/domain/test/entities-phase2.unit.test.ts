import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BlockKey,
  blockKeySchema,
  type HandlingClass,
  type LoadBlock,
  loadBlockSchema,
  type SizeWeightClass,
  type SlaClass,
  type TrailerSlice,
  trailerSliceSchema,
} from "../src/index.js";

/**
 * Task 2 (RED first): the fleshed-out Phase-2 `LoadBlock` (AGG-01/AGG-02) and
 * `TrailerSlice` (LOAD-01) value types. Block-key vocabulary reuses the planning
 * enums; aggregate refinements (packageCount match, used ≤ capacity) are
 * enforced by zod. Depth 0 = rear/easiest access (the locked LOAD-01 decision).
 */

const validKey: BlockKey = {
  currentHubId: "MEM",
  nextUnloadHubId: "ORD",
  finalDestHubId: "DEN",
  slaClass: "express",
  deadlineBucket: 3,
  handlingClass: "fragile",
  sizeWeightClass: "small",
};

const validBlock: LoadBlock = {
  loadBlockId: "LB-1",
  key: validKey,
  packageIds: ["P1", "P2"],
  packageCount: 2,
  totalVolume: 3,
  totalWeight: 12,
  priority: 4,
};

const validSlice: TrailerSlice = {
  depth: 0,
  capacityVolume: 30,
  capacityWeight: 1000,
  usedVolume: 3,
  usedWeight: 12,
  loadBlockIds: ["LB-1"],
};

describe("BlockKey (AGG-01 7-part key over the planning enums)", () => {
  it("parses the full 7-part key round-trip", () => {
    expect(blockKeySchema.parse(validKey)).toEqual(validKey);
  });

  it("carries exactly the seven block-key dimensions", () => {
    expectTypeOf<BlockKey>().toEqualTypeOf<{
      currentHubId: string;
      nextUnloadHubId: string;
      finalDestHubId: string;
      slaClass: SlaClass;
      deadlineBucket: number;
      handlingClass: HandlingClass;
      sizeWeightClass: SizeWeightClass;
    }>();
  });

  it("rejects an unknown SLA / handling enum member and empty hub ids", () => {
    expect(() => blockKeySchema.parse({ ...validKey, slaClass: "vip" })).toThrow();
    expect(() =>
      blockKeySchema.parse({ ...validKey, handlingClass: "wet" }),
    ).toThrow();
    expect(() => blockKeySchema.parse({ ...validKey, currentHubId: "" })).toThrow();
  });

  it("rejects a non-integer deadlineBucket", () => {
    expect(() => blockKeySchema.parse({ ...validKey, deadlineBucket: 1.5 })).toThrow();
  });
});

describe("LoadBlock (AGG-02 aggregates + key + priority)", () => {
  it("parses a consistent block round-trip", () => {
    expect(loadBlockSchema.parse(validBlock)).toEqual(validBlock);
  });

  it("requires at least one package", () => {
    expect(() =>
      loadBlockSchema.parse({ ...validBlock, packageIds: [], packageCount: 0 }),
    ).toThrow();
  });

  it("rejects a packageCount that disagrees with packageIds.length (refinement)", () => {
    expect(() =>
      loadBlockSchema.parse({ ...validBlock, packageCount: 5 }),
    ).toThrow();
  });

  it("rejects non-positive aggregate volume / weight", () => {
    expect(() =>
      loadBlockSchema.parse({ ...validBlock, totalVolume: 0 }),
    ).toThrow();
    expect(() =>
      loadBlockSchema.parse({ ...validBlock, totalWeight: -1 }),
    ).toThrow();
  });

  it("carries the key, aggregates and a numeric priority", () => {
    expectTypeOf<LoadBlock>().toMatchObjectType<{
      loadBlockId: string;
      key: BlockKey;
      packageIds: string[];
      packageCount: number;
      totalVolume: number;
      totalWeight: number;
      priority: number;
    }>();
  });
});

describe("TrailerSlice (LOAD-01 depth model; 0 = rear/easiest access)", () => {
  it("parses a consistent slice round-trip", () => {
    expect(trailerSliceSchema.parse(validSlice)).toEqual(validSlice);
  });

  it("depth 0 is the rear (easiest access) and must be a non-negative integer", () => {
    expect(trailerSliceSchema.parse({ ...validSlice, depth: 0 }).depth).toBe(0);
    expect(() => trailerSliceSchema.parse({ ...validSlice, depth: -1 })).toThrow();
    expect(() => trailerSliceSchema.parse({ ...validSlice, depth: 1.5 })).toThrow();
  });

  it("allows an empty slice (used = 0, no blocks)", () => {
    const empty: TrailerSlice = {
      depth: 2,
      capacityVolume: 30,
      capacityWeight: 1000,
      usedVolume: 0,
      usedWeight: 0,
      loadBlockIds: [],
    };
    expect(trailerSliceSchema.parse(empty)).toEqual(empty);
  });

  it("rejects usedVolume exceeding capacityVolume (refinement)", () => {
    expect(() =>
      trailerSliceSchema.parse({ ...validSlice, usedVolume: 31 }),
    ).toThrow();
  });

  it("rejects usedWeight exceeding capacityWeight (refinement)", () => {
    expect(() =>
      trailerSliceSchema.parse({ ...validSlice, usedWeight: 1001 }),
    ).toThrow();
  });

  it("rejects non-positive capacities and negative used amounts", () => {
    expect(() =>
      trailerSliceSchema.parse({ ...validSlice, capacityVolume: 0 }),
    ).toThrow();
    expect(() =>
      trailerSliceSchema.parse({ ...validSlice, usedWeight: -1 }),
    ).toThrow();
  });

  it("exposes depth/capacity/used/blocks", () => {
    expectTypeOf<TrailerSlice>().toMatchObjectType<{
      depth: number;
      capacityVolume: number;
      capacityWeight: number;
      usedVolume: number;
      usedWeight: number;
      loadBlockIds: string[];
    }>();
  });
});
