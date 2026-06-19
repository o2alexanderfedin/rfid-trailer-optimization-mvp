/**
 * `@mm/optimizer` — the PURE, deterministic algorithmic core of the rolling
 * optimizer (Phase 4).
 *
 * It imports ONLY `@mm/domain` + `@mm/load-planner` (+ Node stdlib): no DB, no
 * clock (`Date.now()`), no RNG (`Math.random()`). Every export is a deterministic
 * function of its inputs, so a rolling epoch replays identically (PITFALLS P3)
 * and is idempotent per `(epoch, scopeHash)` (anti-P7 thrash). `glpk.js` is a
 * TEST-ONLY devDependency (the min-cost-flow correctness oracle) — NEVER a
 * runtime dependency.
 *
 * The DRY discipline: feasibility (the Phase-2 `validatePlan` HARD gate) and
 * soft scoring (`scorePlan`) are REUSED from `@mm/load-planner`, never
 * re-implemented here; feasibility stays a separate gate, checked first, never
 * folded into the weighted objective (anti-P2).
 *
 * BARREL CONVENTION (no concurrent edits to one file): this root re-exports ONLY
 * the per-subdirectory barrels. Each Wave-2 plan FILLS ITS OWN barrel and never
 * touches this root or another plan's barrel.
 */
export * from "./graph/index.js";
export * from "./flow/index.js";
export * from "./vrptw/index.js";
export * from "./objective/index.js";
export * from "./repair/index.js";
export * from "./rolling/index.js";
