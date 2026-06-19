/**
 * `@mm/optimizer` — the local-repair barrel (OPT-07).
 *
 * The split / reassign / hold / over-carry recovery loop: ranked feasible
 * recommendations (each with a §17.4 rationale) for an infeasible/high-cost plan,
 * gated by the REUSED Phase-2 `validatePlan` HARD gate and ranked by the §12
 * objective. The root `src/index.ts` re-exports this barrel; this plan FILLS this
 * file and never touches the root or another plan's barrel.
 */
export { localRepair } from "./local-repair.js";
export type {
  Recommendation,
  RepairKind,
  RepairScope,
  RepairSlice,
} from "./local-repair.js";
