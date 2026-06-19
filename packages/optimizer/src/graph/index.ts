/**
 * `@mm/optimizer` — the time-expanded-graph barrel (OPT-01).
 *
 * Re-exports the Wave-2 consumer CONTRACT (`TimeExpandedGraph`, `FlowEdge`,
 * `FlowNode`, `EdgeKind` + the input shapes / config) and the builder
 * `buildTimeExpandedGraph`. The root `src/index.ts` re-exports ONLY this barrel;
 * this plan owns this file and Plan 03 imports the contract from here.
 */

// --- The Wave-2 consumer contract (the stable interface Plan 03 builds on) ---
export type {
  EdgeKind,
  FlowEdge,
  FlowNode,
  GraphConfig,
  OptimizerHub,
  OptimizerNetwork,
  OptimizerRoute,
  OptimizerSchedule,
  OptimizerScope,
  ScheduledTrip,
  TimeExpandedGraph,
} from "./types.js";
export { DEFAULT_GRAPH_CONFIG } from "./types.js";

// --- The time-expanded hub-network graph builder (OPT-01) --------------------
export { buildTimeExpandedGraph, nodeId } from "./time-expanded.js";
