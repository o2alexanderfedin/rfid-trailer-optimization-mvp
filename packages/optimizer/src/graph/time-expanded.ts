import type {
  OptimizerNetwork,
  OptimizerScope,
  OptimizerSchedule,
  TimeExpandedGraph,
} from "./types.js";

/**
 * Canonical node id for a hub-at-time node: `${hubId}@${timeMin}`.
 * (Stub — real implementation lands in Task 2 via TDD.)
 */
export function nodeId(hubId: string, timeMin: number): string {
  return `${hubId}@${timeMin}`;
}

/**
 * Build the time-expanded hub-network graph (OPT-01). Stub — the real
 * RED→GREEN→REFACTOR implementation lands in Task 2.
 */
export function buildTimeExpandedGraph(
  _network: OptimizerNetwork,
  _schedule: OptimizerSchedule,
  _scope: OptimizerScope,
): TimeExpandedGraph {
  return { nodes: [], edges: [], nodeIndex: new Map() };
}
