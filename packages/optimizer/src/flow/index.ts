/**
 * `@mm/optimizer` — the min-cost-flow (SSP) barrel (OPT-02).
 *
 * The Wave-2 successive-shortest-path solver + the freight-assignment layer the
 * objective and repair loop build on. The root `src/index.ts` re-exports this
 * barrel; this plan OWNS this file and never touches the root or another plan's
 * barrel (the no-merge-conflict barrel convention).
 *
 * `glpk.js` is the TEST-ONLY correctness oracle (`flow/glpk-oracle.test.ts`) and
 * is never imported here or anywhere in shipped `src`.
 */

// --- The min-cost-flow contract (strong-typed solver boundary) ---------------
export type { FlowResult, Supply } from "./types.js";

// --- The Successive-Shortest-Path solver (OPT-02) ----------------------------
export { minCostFlow } from "./min-cost-flow.js";

// --- Freight-to-leg assignment over the time-expanded graph (OPT-02) ---------
export { assignFreight, type FreightAssignment } from "./assign-freight.js";

// --- Live freight stage: MCF wired into the rolling epoch (F-06 / OPT-02) -----
export {
  assignFreightForEpoch,
  type EpochFreightAssignment,
} from "./freight-stage.js";
