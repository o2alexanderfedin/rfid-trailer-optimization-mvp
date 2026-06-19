import type { FlowEdge, TimeExpandedGraph } from "../graph/types.js";
import { minCostFlow } from "./min-cost-flow.js";
import type { Supply } from "./types.js";

/**
 * One freight block's assignment: the leg-edge sequence its units travel and the
 * integer cost they incur. `legEdgeIds` is the block's flow decomposed into its
 * traversed edges in source→sink order (one entry per unit · edge it crosses), so
 * the multiset of all blocks' `legEdgeIds` is exactly the optimal flow, and
 * `Σ block.cost` equals the {@link minCostFlow} optimum.
 */
export interface FreightAssignment {
  /** The block's id — the {@link Supply.nodeId} of its (positive) source supply. */
  readonly blockId: string;
  /** The leg edges the block's units traverse, in source→sink path order. */
  readonly legEdgeIds: readonly string[];
  /** The block's total integer transport cost (`Σ edge.cost` over `legEdgeIds`). */
  readonly cost: number;
}

/**
 * OPT-02 — `assignFreight(graph, freightSupplies)`: map freight blocks to route
 * legs over the Plan-02 time-expanded graph by min-cost flow.
 *
 * Each POSITIVE supply is a freight block (its `nodeId` the origin node, `amount`
 * its unit size); negative supplies are the delivery sinks. We run {@link minCostFlow}
 * for the global optimum, then DECOMPOSE the optimal flow into per-block
 * source→sink paths — pulling `amount` unit-paths out of each block's source —
 * recording the legs each block traverses. Because we only ever consume the
 * already-optimal flow, no edge is used beyond its capacity and the assignments'
 * total cost equals the optimum. Infeasible freight ⇒ no assignments.
 *
 * Pure + deterministic (anti-P3): no clock, no RNG; flow is decomposed in a fixed
 * edge order (the graph's id-sorted edges), so the same inputs replay identically.
 *
 * @param graph           the time-expanded graph (Plan 02)
 * @param freightSupplies per-node integer supplies (`> 0` block, `< 0` sink)
 * @returns one {@link FreightAssignment} per positive-supply block (empty if infeasible)
 */
export function assignFreight(
  graph: TimeExpandedGraph,
  freightSupplies: readonly Supply[],
): readonly FreightAssignment[] {
  const flow = minCostFlow(graph, freightSupplies);
  if (!flow.feasible) return [];

  // Mutable copy of the optimal flow we will consume during decomposition.
  const remaining = new Map<string, number>(flow.flowByEdgeId);

  // Outgoing edges per node, in deterministic id order (graph.edges is id-sorted).
  const outEdges = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const list = outEdges.get(e.from);
    if (list === undefined) outEdges.set(e.from, [e]);
    else list.push(e);
  }

  // Sinks: nodes with negative supply absorb flow; a unit-path ends at any sink.
  const sinkNodes = new Set<string>();
  for (const s of freightSupplies) {
    if (s.amount < 0) sinkNodes.add(s.nodeId);
  }

  const assignments: FreightAssignment[] = [];
  for (const block of freightSupplies) {
    if (block.amount <= 0) continue;
    assignments.push(
      decomposeBlock(block, graph, remaining, outEdges, sinkNodes),
    );
  }
  return assignments;
}

/** Decompose one block's `amount` units into source→sink unit-paths. */
function decomposeBlock(
  block: Supply,
  graph: TimeExpandedGraph,
  remaining: Map<string, number>,
  outEdges: ReadonlyMap<string, FlowEdge[]>,
  sinkNodes: ReadonlySet<string>,
): FreightAssignment {
  const costOf = new Map<string, number>(graph.edges.map((e) => [e.id, e.cost]));
  const legEdgeIds: string[] = [];
  let cost = 0;

  for (let unit = 0; unit < block.amount; unit += 1) {
    const path = traceUnitPath(block.nodeId, remaining, outEdges, sinkNodes);
    for (const edgeId of path) {
      remaining.set(edgeId, (remaining.get(edgeId) ?? 0) - 1);
      legEdgeIds.push(edgeId);
      cost += costOf.get(edgeId) ?? 0;
    }
  }
  return { blockId: block.nodeId, legEdgeIds, cost };
}

/**
 * Trace ONE unit of flow from `start` to any sink, following residual flow.
 * Greedy DFS over edges with `remaining > 0`, in deterministic id order; returns
 * the edge-id path (which is non-empty for any block whose flow reaches a sink —
 * guaranteed by feasibility + flow conservation).
 */
function traceUnitPath(
  start: string,
  remaining: ReadonlyMap<string, number>,
  outEdges: ReadonlyMap<string, FlowEdge[]>,
  sinkNodes: ReadonlySet<string>,
): readonly string[] {
  const path: string[] = [];
  const visited = new Set<string>([start]);
  let node = start;

  while (!sinkNodes.has(node)) {
    const next = outEdges
      .get(node)
      ?.find((e) => (remaining.get(e.id) ?? 0) > 0 && !visited.has(e.to));
    if (next === undefined) break; // dead end (no remaining flow to a sink).
    path.push(next.id);
    visited.add(next.to);
    node = next.to;
  }
  return path;
}
