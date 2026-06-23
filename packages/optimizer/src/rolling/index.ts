/**
 * `@mm/optimizer` — the rolling-horizon barrel (OPT-04/05/06).
 *
 * The Wave-3 rolling shell's PURE core: scoped affected-slice detection
 * (`detectAffectedScope`), the `structuredClone` planning-twin sandbox
 * (`buildTwin`), the `(epochId, scopeHash)` idempotency key + freeze-window
 * predicate (`scopeHash` / `isFrozen`), and the composing epoch (`runEpoch`). The
 * stateful, side-effecting shell lives in `@mm/api`; everything here is a pure,
 * deterministic function of its inputs (anti-P3 replay, anti-P7 idempotency).
 *
 * The root `src/index.ts` re-exports this barrel; this plan FILLS this file and
 * never touches the root or another plan's barrel (the no-merge-conflict
 * convention).
 */

// --- Scoped affected-slice detection (OPT-05) --------------------------------
export { detectAffectedScope } from "./scope.js";

// --- The structuredClone planning-twin sandbox (OPT-04) ----------------------
export { buildTwin } from "./twin.js";

// --- Idempotency key + freeze-window predicate (OPT-06 keystone) -------------
export { scopeHash, isFrozen } from "./freeze-idempotency.js";

// --- The composing rolling epoch (OPT-04/05/06) ------------------------------
export { runEpoch } from "./epoch.js";

// --- Contracts ---------------------------------------------------------------
export type {
  Epoch,
  EpochInput,
  EpochRecommendation,
  EpochResult,
  TwinBlock,
  TwinDriver,
  TwinRoute,
  TwinSnapshot,
  TwinStop,
  TwinTrailer,
} from "./types.js";
