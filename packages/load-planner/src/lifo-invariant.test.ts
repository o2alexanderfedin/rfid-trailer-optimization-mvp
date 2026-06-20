import { describe, expect, it } from "vitest";
import type { TrailerSlice } from "@mm/domain";
import {
  canonicalInvariantHolds,
  countBlockers,
  isBlocker,
  lifoOk,
} from "./lifo-invariant.js";
import type {
  FeasibilityResult,
  LoadPlan,
  Placement,
  ScoreResult,
  Violation,
} from "./types.js";

/**
 * Task 1 — THE canonical LIFO invariant + blocker predicate (the P1 single source).
 *
 * Every assertion here pins the ONE invariant the planner, the independent
 * validator, and all downstream tests import — `unloadOrder(A) < unloadOrder(B)
 * ⟹ depth(A) ≤ depth(B)` (earlier unload ⇒ closer to the rear door, depth 0).
 * The blocker predicate is the security-critical seam (T-02-07): a sign flip
 * here silently inverts the whole product, so the boundary cases (strict `>`,
 * depth direction, same-hub/same-depth) and a DELIBERATELY-REVERSED plan are all
 * pinned. The reversed fixture proves the invariant is falsifiable — not a
 * tautology that an inverted validator would also "pass".
 */

/** Minimal placement constructor for the fixtures. */
function place(loadBlockId: string, depth: number, unloadOrder: number): Placement {
  return { loadBlockId, depth, unloadOrder };
}

describe("isBlocker (the canonical blocker predicate)", () => {
  // target unloads at order 5 sitting at depth 3 (mid-trailer).
  const target = place("TARGET", 3, 5);

  it("is TRUE when other is closer to rear (smaller depth) AND unloads LATER", () => {
    // other at depth 1 (nearer rear, in front of target) for a LATER stop (8 > 5)
    const other = place("OTHER", 1, 8);
    expect(isBlocker(target, other)).toBe(true);
  });

  it("is FALSE when other unloads at the SAME order (strict > — same hub never blocks)", () => {
    const other = place("OTHER", 1, 5);
    expect(isBlocker(target, other)).toBe(false);
  });

  it("is FALSE when other unloads EARLIER (smaller order), even if nearer rear", () => {
    const other = place("OTHER", 1, 2);
    expect(isBlocker(target, other)).toBe(false);
  });

  it("is FALSE when other is DEEPER than target (other.depth > target.depth)", () => {
    // behind the target (toward nose) — cannot block the target's unload
    const other = place("OTHER", 5, 9);
    expect(isBlocker(target, other)).toBe(false);
  });

  it("is FALSE when other is at the SAME depth (must be strictly closer to rear)", () => {
    const other = place("OTHER", 3, 9);
    expect(isBlocker(target, other)).toBe(false);
  });

  it("never reports a block as its own blocker", () => {
    expect(isBlocker(target, target)).toBe(false);
  });
});

describe("countBlockers", () => {
  it("counts only the placements that are blockers of the target", () => {
    const target = place("T", 4, 5);
    const placements: Placement[] = [
      target,
      place("B1", 1, 8), // blocker: nearer rear, later
      place("B2", 2, 9), // blocker: nearer rear, later
      place("S", 0, 5), // same order ⇒ not a blocker
      place("E", 0, 1), // earlier ⇒ not a blocker
      place("D", 6, 9), // deeper ⇒ not a blocker
    ];
    expect(countBlockers(target, placements)).toBe(2);
  });

  it("returns 0 when nothing blocks the target", () => {
    const target = place("T", 0, 1); // earliest unload at the rear — nothing can block it
    const placements: Placement[] = [target, place("X", 2, 5), place("Y", 4, 9)];
    expect(countBlockers(target, placements)).toBe(0);
  });
});

describe("canonicalInvariantHolds", () => {
  it("holds for a correctly-ordered plan (earlier unload ⇒ lower depth)", () => {
    // unloadOrder 0,1,2 placed at depth 0,1,2 — monotone, LIFO-correct.
    const placements: Placement[] = [
      place("A", 0, 0),
      place("B", 1, 1),
      place("C", 2, 2),
    ];
    expect(canonicalInvariantHolds(placements)).toBe(true);
  });

  it("holds when ties in depth are allowed for distinct unload orders (≤, not <)", () => {
    // earlier-unload at depth 0; two later blocks share depth 1 — still ≤.
    const placements: Placement[] = [
      place("A", 0, 0),
      place("B", 1, 1),
      place("C", 1, 2),
    ];
    expect(canonicalInvariantHolds(placements)).toBe(true);
  });

  it("FAILS for a DELIBERATELY-REVERSED plan (earliest unload buried at the nose)", () => {
    // The single most important fixture: earliest unload (order 0) is at the
    // DEEPEST depth (2, the nose) and the latest unload (order 2) is at the rear
    // (depth 0). This is the exact inverse of LIFO-correct — the invariant MUST
    // reject it. If this ever returns true, the system is silently lying (P1).
    const reversed: Placement[] = [
      place("A", 2, 0), // earliest unload, buried at the nose
      place("B", 1, 1),
      place("C", 0, 2), // latest unload, at the rear door
    ];
    expect(canonicalInvariantHolds(reversed)).toBe(false);
  });

  it("treats same-hub (same unloadOrder) blocks at different depths as valid", () => {
    // Two blocks for the SAME stop never block each other; any depth ordering is fine.
    const placements: Placement[] = [place("A", 0, 3), place("B", 2, 3)];
    expect(canonicalInvariantHolds(placements)).toBe(true);
  });

  it("is vacuously true for the empty and singleton plans", () => {
    expect(canonicalInvariantHolds([])).toBe(true);
    expect(canonicalInvariantHolds([place("A", 7, 4)])).toBe(true);
  });
});

describe("lifoOk (convenience wrapper over a LoadPlan)", () => {
  function emptySlice(depth: number): TrailerSlice {
    return {
      depth,
      capacityVolume: 10,
      capacityWeight: 100,
      usedVolume: 0,
      usedWeight: 0,
      loadBlockIds: [],
    };
  }

  it("is true for a plan whose placements satisfy the invariant; zero blockers", () => {
    const plan: LoadPlan = {
      trailerId: "TR-1",
      slices: [emptySlice(0), emptySlice(1), emptySlice(2)],
      placements: [place("A", 0, 0), place("B", 1, 1), place("C", 2, 2)],
    };
    expect(lifoOk(plan)).toBe(true);
    // a correctly-ordered plan has zero blockers for every placement
    const total = plan.placements.reduce(
      (n, p) => n + countBlockers(p, plan.placements),
      0,
    );
    expect(total).toBe(0);
  });

  it("is false for a reversed plan; blocker counts are positive", () => {
    const plan: LoadPlan = {
      trailerId: "TR-1",
      slices: [emptySlice(0), emptySlice(1), emptySlice(2)],
      placements: [place("A", 2, 0), place("B", 1, 1), place("C", 0, 2)],
    };
    expect(lifoOk(plan)).toBe(false);
    const total = plan.placements.reduce(
      (n, p) => n + countBlockers(p, plan.placements),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});

describe("P2 type separation (FeasibilityResult vs ScoreResult are distinct)", () => {
  it("FeasibilityResult carries hard/soft violations and nothing scoring-related", () => {
    const violation: Violation = {
      loadBlockId: "X",
      kind: "accessibility",
      blockerCount: 3,
      severity: "HARD",
      detail: "3 blockers exceed the max",
    };
    const feasibility: FeasibilityResult = {
      hardViolations: [violation],
      softViolations: [],
    };
    expect(feasibility.hardViolations).toHaveLength(1);
    expect(feasibility.softViolations).toHaveLength(0);
    // structural: a FeasibilityResult has NO score fields (P2 — never merged)
    expect("rehandleScore" in feasibility).toBe(false);
    expect("utilizationScore" in feasibility).toBe(false);
  });

  it("ScoreResult carries scores and nothing feasibility-related", () => {
    const score: ScoreResult = { rehandleScore: 42, utilizationScore: 7 };
    expect(score.rehandleScore).toBe(42);
    expect(score.utilizationScore).toBe(7);
    // structural: a ScoreResult has NO violation fields (P2 — never merged)
    expect("hardViolations" in score).toBe(false);
    expect("softViolations" in score).toBe(false);
  });
});
