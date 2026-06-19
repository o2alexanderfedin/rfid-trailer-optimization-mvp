import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type DeadlineBucket,
  deadlineBucketSchema,
  type HandlingClass,
  handlingClassSchema,
  type PlannerConfig,
  plannerConfigSchema,
  type PlanningPackage,
  planningPackageSchema,
  type RouteStop,
  routeStopSchema,
  type SizeWeightClass,
  sizeWeightClassSchema,
  SLA_CLASS_WEIGHT,
  type SlaClass,
  slaClassSchema,
} from "../src/index.js";

/**
 * Task 1 (RED first): the Phase-2 planning value types — the SINGLE shared
 * contract `@mm/aggregation` and `@mm/load-planner` import. Pure zod schemas +
 * inferred types; deterministic; no clock, no RNG. AGG-01/AGG-02 block-key
 * vocabulary + LOAD-01 planning input.
 */

const validPackage: PlanningPackage = {
  packageId: "P1",
  currentHubId: "MEM",
  nextUnloadHubId: "ORD",
  finalDestHubId: "DEN",
  slaClass: "express",
  handlingClass: "fragile",
  sizeWeightClass: "small",
  deadline: 1_700_000_000_000,
  deadlineBucket: 4,
  volume: 1.5,
  weight: 4.2,
};

describe("SlaClass enum + SLA_CLASS_WEIGHT (AGG-04 single-sourced priority)", () => {
  it("parses the closed SLA enum and rejects unknown members", () => {
    expect(slaClassSchema.parse("express")).toBe("express");
    expect(slaClassSchema.parse("priority")).toBe("priority");
    expect(slaClassSchema.parse("standard")).toBe("standard");
    expect(slaClassSchema.parse("economy")).toBe("economy");
    expect(() => slaClassSchema.parse("overnight")).toThrow();
  });

  it("SlaClass is the union of the four literals", () => {
    expectTypeOf<SlaClass>().toEqualTypeOf<
      "express" | "priority" | "standard" | "economy"
    >();
  });

  it("exposes a stable integer weight per class — higher = more urgent", () => {
    expect(Number.isInteger(SLA_CLASS_WEIGHT.express)).toBe(true);
    expect(Number.isInteger(SLA_CLASS_WEIGHT.economy)).toBe(true);
    // Strict ordering express > priority > standard > economy (AGG-04).
    expect(SLA_CLASS_WEIGHT.express).toBeGreaterThan(SLA_CLASS_WEIGHT.priority);
    expect(SLA_CLASS_WEIGHT.priority).toBeGreaterThan(
      SLA_CLASS_WEIGHT.standard,
    );
    expect(SLA_CLASS_WEIGHT.standard).toBeGreaterThan(SLA_CLASS_WEIGHT.economy);
  });

  it("SLA_CLASS_WEIGHT is a total Record over SlaClass", () => {
    expectTypeOf(SLA_CLASS_WEIGHT).toEqualTypeOf<Record<SlaClass, number>>();
    // Exactly the four keys — no missing/extra class.
    expect(Object.keys(SLA_CLASS_WEIGHT).sort()).toEqual(
      ["economy", "express", "priority", "standard"].sort(),
    );
  });
});

describe("HandlingClass enum (AGG-03 fragile vs heavy split)", () => {
  it("parses at least standard/fragile/heavy and rejects unknowns", () => {
    expect(handlingClassSchema.parse("standard")).toBe("standard");
    expect(handlingClassSchema.parse("fragile")).toBe("fragile");
    expect(handlingClassSchema.parse("heavy")).toBe("heavy");
    expect(() => handlingClassSchema.parse("explosive")).toThrow();
  });

  it("HandlingClass includes the three split-relevant members", () => {
    const all: HandlingClass[] = ["standard", "fragile", "heavy"];
    expect(all).toHaveLength(3);
  });
});

describe("SizeWeightClass enum (coarse closed taxonomy)", () => {
  it("parses a coarse closed enum and rejects unknowns", () => {
    expect(sizeWeightClassSchema.parse("small")).toBe("small");
    expect(sizeWeightClassSchema.parse("medium")).toBe("medium");
    expect(sizeWeightClassSchema.parse("large")).toBe("large");
    expect(() => sizeWeightClassSchema.parse("gigantic")).toThrow();
  });

  it("SizeWeightClass is the coarse literal union", () => {
    expectTypeOf<SizeWeightClass>().toEqualTypeOf<
      "small" | "medium" | "large"
    >();
  });
});

describe("DeadlineBucket (coarse non-negative integer bucket, no wall clock)", () => {
  it("accepts non-negative integers", () => {
    expect(deadlineBucketSchema.parse(0)).toBe(0);
    expect(deadlineBucketSchema.parse(7)).toBe(7);
  });

  it("rejects negative and non-integer buckets", () => {
    expect(() => deadlineBucketSchema.parse(-1)).toThrow();
    expect(() => deadlineBucketSchema.parse(2.5)).toThrow();
  });

  it("DeadlineBucket is a number", () => {
    expectTypeOf<DeadlineBucket>().toEqualTypeOf<number>();
  });
});

describe("RouteStop (LOAD-02 unload-order vocabulary; stop 0 = earliest)", () => {
  it("parses { hubId, stopIndex } with a non-negative integer index", () => {
    const stop: RouteStop = routeStopSchema.parse({ hubId: "MEM", stopIndex: 0 });
    expect(stop).toEqual({ hubId: "MEM", stopIndex: 0 });
  });

  it("rejects negative / non-integer stop indices and empty hubId", () => {
    expect(() => routeStopSchema.parse({ hubId: "MEM", stopIndex: -1 })).toThrow();
    expect(() => routeStopSchema.parse({ hubId: "MEM", stopIndex: 1.5 })).toThrow();
    expect(() => routeStopSchema.parse({ hubId: "", stopIndex: 0 })).toThrow();
  });
});

describe("PlanningPackage (LOAD-01 / AGG planning input view)", () => {
  it("parses a fully-specified package round-trip (determinism)", () => {
    const a = planningPackageSchema.parse(validPackage);
    const b = planningPackageSchema.parse(validPackage);
    expect(a).toEqual(validPackage);
    expect(a).toEqual(b);
  });

  it("carries the block-key dimensions + volume/weight/deadline", () => {
    expectTypeOf<PlanningPackage>().toMatchObjectType<{
      packageId: string;
      currentHubId: string;
      nextUnloadHubId: string;
      finalDestHubId: string;
      slaClass: SlaClass;
      handlingClass: HandlingClass;
      sizeWeightClass: SizeWeightClass;
      deadline: number;
      deadlineBucket: number;
      volume: number;
      weight: number;
    }>();
  });

  it("rejects non-positive volume", () => {
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, volume: 0 }),
    ).toThrow();
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, volume: -3 }),
    ).toThrow();
  });

  it("rejects non-positive weight", () => {
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, weight: 0 }),
    ).toThrow();
  });

  it("rejects an unknown SLA / handling enum member", () => {
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, slaClass: "vip" }),
    ).toThrow();
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, handlingClass: "wet" }),
    ).toThrow();
  });

  it("rejects a non-integer deadlineBucket", () => {
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, deadlineBucket: 1.1 }),
    ).toThrow();
  });

  it("rejects empty hub ids", () => {
    expect(() =>
      planningPackageSchema.parse({ ...validPackage, currentHubId: "" }),
    ).toThrow();
  });
});

describe("PlannerConfig + DEFAULT_PLANNER_CONFIG (spec §7/§12 defaults)", () => {
  it("DEFAULT_PLANNER_CONFIG matches the spec-derived defaults", () => {
    expect(DEFAULT_PLANNER_CONFIG.maxAllowedBlockers).toBe(2);
    expect(DEFAULT_PLANNER_CONFIG.targetUtil).toBe(0.8);
    expect(DEFAULT_PLANNER_CONFIG.utilLow).toBe(0.75);
    expect(DEFAULT_PLANNER_CONFIG.utilHigh).toBe(0.9);
  });

  it("carries every config knob the two pure packages consume", () => {
    expectTypeOf<PlannerConfig>().toEqualTypeOf<{
      maxAllowedBlockers: number;
      maxBlockVolume: number;
      unloadReloadMin: number;
      volCost: number;
      fragilePenalty: number;
      dockDelayPenalty: number;
      slaImpactPenalty: number;
      targetUtil: number;
      utilLow: number;
      utilHigh: number;
      wLow: number;
      wHigh: number;
    }>();
  });

  it("DEFAULT_PLANNER_CONFIG is itself a valid PlannerConfig (parse round-trip)", () => {
    expect(plannerConfigSchema.parse(DEFAULT_PLANNER_CONFIG)).toEqual(
      DEFAULT_PLANNER_CONFIG,
    );
  });

  it("all weight knobs are positive and the util band is ordered low<target<high", () => {
    const c = DEFAULT_PLANNER_CONFIG;
    expect(c.maxBlockVolume).toBeGreaterThan(0);
    expect(c.unloadReloadMin).toBeGreaterThan(0);
    expect(c.volCost).toBeGreaterThan(0);
    expect(c.fragilePenalty).toBeGreaterThan(0);
    expect(c.dockDelayPenalty).toBeGreaterThan(0);
    expect(c.slaImpactPenalty).toBeGreaterThan(0);
    expect(c.wLow).toBeGreaterThan(0);
    expect(c.wHigh).toBeGreaterThan(0);
    expect(c.utilLow).toBeLessThan(c.targetUtil);
    expect(c.targetUtil).toBeLessThan(c.utilHigh);
  });

  it("maxAllowedBlockers must be a non-negative integer; util fractions in (0,1)", () => {
    expect(() =>
      plannerConfigSchema.parse({ ...DEFAULT_PLANNER_CONFIG, maxAllowedBlockers: 2.5 }),
    ).toThrow();
    expect(() =>
      plannerConfigSchema.parse({ ...DEFAULT_PLANNER_CONFIG, utilLow: -0.1 }),
    ).toThrow();
    expect(() =>
      plannerConfigSchema.parse({ ...DEFAULT_PLANNER_CONFIG, targetUtil: 1.5 }),
    ).toThrow();
  });

  it("rejects non-positive weight knobs (tamper guard T-02-01)", () => {
    expect(() =>
      plannerConfigSchema.parse({ ...DEFAULT_PLANNER_CONFIG, maxBlockVolume: 0 }),
    ).toThrow();
    expect(() =>
      plannerConfigSchema.parse({ ...DEFAULT_PLANNER_CONFIG, volCost: -1 }),
    ).toThrow();
  });

  it("rejects an INVERTED utilization band (utilLow > utilHigh) — L7 cross-field", () => {
    // Each edge is individually a valid (0,1] fraction, but the BAND is inverted.
    // A per-field schema accepts this; the cross-field refinement must reject it.
    expect(() =>
      plannerConfigSchema.parse({
        ...DEFAULT_PLANNER_CONFIG,
        utilLow: 0.9,
        utilHigh: 0.75,
      }),
    ).toThrow();
  });

  it("accepts an equal band edge (utilLow === utilHigh) — boundary is inclusive", () => {
    expect(() =>
      plannerConfigSchema.parse({
        ...DEFAULT_PLANNER_CONFIG,
        utilLow: 0.8,
        utilHigh: 0.8,
      }),
    ).not.toThrow();
  });
});
