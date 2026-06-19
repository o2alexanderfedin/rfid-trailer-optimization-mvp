/**
 * `@mm/optimizer` — the weighted-objective barrel (OPT-08).
 *
 * Placeholder for the Wave-2 single weighted-objective scorer. Feasibility (the
 * Phase-2 `validatePlan` HARD gate) stays a SEPARATE output, checked first and
 * never folded into the objective (anti-P2). The root `src/index.ts` re-exports
 * this barrel; the owning plan FILLS this file and never touches the root.
 */
export {};
