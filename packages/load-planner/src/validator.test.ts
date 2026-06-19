import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
  type TrailerSlice,
} from "@mm/domain";
import type { FeasibilityResult, LoadPlan } from "./types.js";
import { isFeasible, validatePlan } from "./validator.js";

/**
 * Task 2 — the INDEPENDENT validator (LOAD-04), a virtual unload simulation.
 *
 * `validatePlan(plan, blocks, route, config)` walks the route stop-by-stop and,
 * for every block, recomputes its blockers DIRECTLY from `plan.slices` contents
 * (depth + loadBlockIds) using the canonical `isBlocker` predicate — NEVER from
 * `plan.placements` (the planner's bookkeeping). `blockerCount > maxAllowedBlockers
 * ⇒ HARD`; `1..max ⇒ SOFT`; `0 ⇒ neither`. It returns a `FeasibilityResult` only
 * (no score). This is the anti-P1 (independent recompute) and anti-P2
 * (feasibility-vs-score) heart of the phase.
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

/** A linear k-hub route: hub Hk unloaded at stop k. */
function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

const config: PlannerConfig = DEFAULT_PLANNER_CONFIG; // maxAllowedBlockers = 2

describe("validatePlan — independent virtual unload simulation (LOAD-04)", () => {
  it("reports zero violations for a correctly-ordered plan (earlier ⇒ rear)", () => {
    const route = linearRoute(4);
    const blocks = [
      block("LB1", "H1"),
      block("LB2", "H2"),
      block("LB3", "H3"),
      block("LB4", "H4"),
    ];
    // correct: earliest unload (H1) at the rear (depth 0), latest (H4) at nose.
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [
        slice(0, ["LB1"]),
        slice(1, ["LB2"]),
        slice(2, ["LB3"]),
        slice(3, ["LB4"]),
      ],
      placements: [], // DELIBERATELY EMPTY: validator must not read placements
    };
    const result = validatePlan(plan, blocks, route, config);
    expect(result.hardViolations).toHaveLength(0);
    expect(result.softViolations).toHaveLength(0);
    expect(isFeasible(result)).toBe(true);
  });

  it("recomputes from slices, IGNORING plan.placements entirely", () => {
    const route = linearRoute(4);
    const blocks = [
      block("LB1", "H1"),
      block("LB4", "H4"),
    ];
    // slices say: H4 (latest) at the REAR (depth 0), H1 (earliest) at the NOSE
    // (depth 1) — a reversed layout. placements LIE that it is correct; the
    // validator must trust the SLICES, not the placements.
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB4"]), slice(1, ["LB1"])],
      placements: [
        { loadBlockId: "LB1", depth: 0, unloadOrder: 0 },
        { loadBlockId: "LB4", depth: 1, unloadOrder: 3 },
      ],
    };
    const result = validatePlan(plan, blocks, route, config);
    // LB1 (earliest) is buried behind LB4 (later) ⇒ a real blocker exists.
    const flagged = [...result.hardViolations, ...result.softViolations];
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((v) => v.loadBlockId === "LB1")).toBe(true);
  });

  it("HARD when blockerCount EXCEEDS maxAllowedBlockers (boundary at max+1)", () => {
    const route = linearRoute(5);
    // target LB-T (earliest, H1) buried at depth 3; three LATER blocks in front
    // of it (depths 0,1,2) ⇒ 3 blockers > max(2) ⇒ HARD.
    const blocks = [
      block("LB-T", "H1"),
      block("LB-A", "H2"),
      block("LB-B", "H3"),
      block("LB-C", "H4"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [
        slice(0, ["LB-A"]),
        slice(1, ["LB-B"]),
        slice(2, ["LB-C"]),
        slice(3, ["LB-T"]),
      ],
      placements: [],
    };
    const result = validatePlan(plan, blocks, route, config);
    const t = result.hardViolations.find((v) => v.loadBlockId === "LB-T");
    expect(t).toBeDefined();
    expect(t?.blockerCount).toBe(3);
    expect(t?.severity).toBe("HARD");
    expect(isFeasible(result)).toBe(false);
  });

  it("SOFT when 1..maxAllowedBlockers blockers (boundary exactly at max)", () => {
    const route = linearRoute(5);
    // target LB-T buried at depth 2 with exactly 2 LATER blocks in front ⇒ SOFT.
    const blocks = [
      block("LB-T", "H1"),
      block("LB-A", "H2"),
      block("LB-B", "H3"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-A"]), slice(1, ["LB-B"]), slice(2, ["LB-T"])],
      placements: [],
    };
    const result = validatePlan(plan, blocks, route, config);
    expect(result.hardViolations).toHaveLength(0);
    const t = result.softViolations.find((v) => v.loadBlockId === "LB-T");
    expect(t).toBeDefined();
    expect(t?.blockerCount).toBe(2);
    expect(t?.severity).toBe("SOFT");
    expect(isFeasible(result)).toBe(true); // SOFT does not break feasibility
  });

  it("treats two same-hub blocks (same unloadOrder) as NOT mutual blockers", () => {
    const route = linearRoute(2);
    // Two blocks for the SAME hub H1 at different depths — they unload together,
    // neither blocks the other (strict predicate).
    const blocks = [block("LB-A", "H1"), block("LB-B", "H1")];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-A"]), slice(1, ["LB-B"])],
      placements: [],
    };
    const result = validatePlan(plan, blocks, route, config);
    expect(result.hardViolations).toHaveLength(0);
    expect(result.softViolations).toHaveLength(0);
  });

  it("counts blockers correctly across MULTI-BLOCK slices", () => {
    const route = linearRoute(4);
    // Slice 0 (rear) holds TWO later-unload blocks (H3, H4) in front of the
    // target (H1) which sits at depth 1 ⇒ 2 blockers ⇒ SOFT (== max).
    const blocks = [
      block("LB-T", "H1"),
      block("LB-X", "H3"),
      block("LB-Y", "H4"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X", "LB-Y"]), slice(1, ["LB-T"])],
      placements: [],
    };
    const result = validatePlan(plan, blocks, route, config);
    const t = result.softViolations.find((v) => v.loadBlockId === "LB-T");
    expect(t).toBeDefined();
    expect(t?.blockerCount).toBe(2);
  });

  it("returns a FeasibilityResult with NO score fields (P2 separation)", () => {
    const route = linearRoute(2);
    const blocks = [block("LB1", "H1")];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB1"])],
      placements: [],
    };
    const result: FeasibilityResult = validatePlan(plan, blocks, route, config);
    expect("rehandleScore" in result).toBe(false);
    expect("utilizationScore" in result).toBe(false);
    // it carries exactly the two feasibility arrays and nothing else
    expect(Object.keys(result).sort()).toEqual(["hardViolations", "softViolations"]);
  });

  it("isFeasible is true iff there are zero hard violations (SOFT is tolerated)", () => {
    const noViolations: FeasibilityResult = { hardViolations: [], softViolations: [] };
    expect(isFeasible(noViolations)).toBe(true);

    const onlySoft: FeasibilityResult = {
      hardViolations: [],
      softViolations: [
        {
          loadBlockId: "X",
          kind: "accessibility",
          blockerCount: 1,
          severity: "SOFT",
          detail: "1 blocker",
        },
      ],
    };
    expect(isFeasible(onlySoft)).toBe(true);

    const hard: FeasibilityResult = {
      hardViolations: [
        {
          loadBlockId: "Y",
          kind: "accessibility",
          blockerCount: 3,
          severity: "HARD",
          detail: "3 blockers",
        },
      ],
      softViolations: [],
    };
    expect(isFeasible(hard)).toBe(false);
  });
});

describe("validator independence guard (T-02-10): no dependency on plan-load", () => {
  it("validator.ts source never IMPORTS the planner bookkeeping module", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./validator.ts", import.meta.url)),
      "utf8",
    );
    // Strip line + block comments so prose references ("must NOT import plan-load")
    // don't trip the guard — only real code is inspected.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // no ESM/CJS import of the planner module
    expect(/from\s+["'][^"']*plan-load/.test(code)).toBe(false);
    expect(/require\(\s*["'][^"']*plan-load/.test(code)).toBe(false);
    // no call into the planner's API
    expect(/\bplanLoad\s*\(/.test(code)).toBe(false);
  });
});
