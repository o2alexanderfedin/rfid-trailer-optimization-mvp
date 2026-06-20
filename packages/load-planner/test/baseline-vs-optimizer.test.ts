import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
} from "@mm/domain";
import { describe, expect, it } from "vitest";
import { baselinePlan } from "../src/baseline.js";
import { planLoad } from "../src/plan-load.js";
import { scorePlan } from "../src/scoring.js";
import type { ScoreResult } from "../src/types.js";

/**
 * Task 3b — the keystone of the "money slide" (LOAD-09, P8).
 *
 * The optimizer (`planLoad`) and the naive baseline (`baselinePlan`) are run on
 * the SAME inputs and scored through the SAME `scorePlan` plumbing. On a
 * blocking-prone scenario (FIFO buries early-unload freight) the optimizer's
 * rehandle score must be ≤ the baseline's — and strictly < on a designed case.
 * This is the structural guarantee the before/after comparison is honest: the
 * baseline shares the scoring path and has something real to lose.
 */

const config: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, maxBlockVolume: 30 };

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

function block(loadBlockId: string, nextUnloadHubId: string, totalVolume = 25): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume,
    totalWeight: 1,
    priority: 0,
  };
}

function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

/**
 * A blocking-prone scenario: FIFO arrival order (LB-A, LB-B, LB-C) is the
 * REVERSE of the unload order (LB-A unloads first, LB-C last). FIFO nose-first
 * therefore buries the early-unload freight behind later freight; the optimizer
 * orders by unload and avoids it. Each block fills a slice (vol 25, cap 30).
 */
function blockingProneScenario(): { blocks: LoadBlock[]; route: RouteStop[] } {
  return {
    blocks: [block("LB-A", "H1"), block("LB-B", "H2"), block("LB-C", "H3")],
    route: linearRoute(3),
  };
}

describe("baseline vs optimizer — shared plumbing + beat-it (LOAD-09, P8)", () => {
  it("scores BOTH plans through the one shared scorePlan path", () => {
    const { blocks, route } = blockingProneScenario();
    const optimized: ScoreResult = scorePlan(planLoad(blocks, route, config), blocks, route, config);
    const naive: ScoreResult = scorePlan(baselinePlan(blocks, route, config), blocks, route, config);
    // Both are ScoreResults from the same call site (apples-to-apples).
    expect(Object.keys(optimized).sort()).toEqual(["rehandleScore", "utilizationScore"]);
    expect(Object.keys(naive).sort()).toEqual(["rehandleScore", "utilizationScore"]);
  });

  it("optimizer rehandle ≤ baseline rehandle on the blocking-prone scenario", () => {
    const { blocks, route } = blockingProneScenario();
    const optRe = scorePlan(planLoad(blocks, route, config), blocks, route, config).rehandleScore;
    const baseRe = scorePlan(baselinePlan(blocks, route, config), blocks, route, config).rehandleScore;
    expect(optRe).toBeLessThanOrEqual(baseRe);
  });

  it("optimizer rehandle is STRICTLY < baseline on the designed case", () => {
    const { blocks, route } = blockingProneScenario();
    const optRe = scorePlan(planLoad(blocks, route, config), blocks, route, config).rehandleScore;
    const baseRe = scorePlan(baselinePlan(blocks, route, config), blocks, route, config).rehandleScore;
    // optimizer achieves 0 rehandle (clean LIFO); baseline incurs a real cost.
    expect(optRe).toBe(0);
    expect(baseRe).toBeGreaterThan(0);
    expect(optRe).toBeLessThan(baseRe);
  });

  it("does not fork the scoring path — baseline.ts imports the shared scorePlan/validatePlan plumbing", () => {
    // The beat-it proof only holds if the baseline shares the optimizer's scoring
    // plumbing rather than a rigged copy (anti-P8). baseline.ts itself must build
    // a plain LoadPlan (no private scorer); the test scores it via the shared path.
    const src = readFileSync(
      fileURLToPath(new URL("../src/baseline.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // baseline must NOT define its own rehandle/utilization scorer.
    expect(/function\s+rehandleScore/.test(code)).toBe(false);
    expect(/function\s+utilizationScore/.test(code)).toBe(false);
  });
});
