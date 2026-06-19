import { describe, expect, it } from "vitest";

import { buildTimeExpandedGraph } from "../graph/time-expanded.js";
import type {
  EdgeKind,
  FlowEdge,
  FlowNode,
  OptimizerNetwork,
  OptimizerSchedule,
  OptimizerScope,
  TimeExpandedGraph,
} from "../graph/types.js";
import { assignFreight } from "./assign-freight.js";
import { minCostFlow } from "./min-cost-flow.js";
import type { Supply } from "./types.js";

/**
 * `assignFreight` tests (OPT-02): freight blocks (positive supplies) are mapped
 * to leg-edge sequences over the time-expanded graph by min-cost flow. The sum of
 * per-block assignment costs must equal the `minCostFlow` optimum, and no edge may
 * be used beyond its capacity.
 */

/** Build a graph from `[id, from, to, capacity, cost]` edge tuples (test helper). */
function graphOf(
  edgeTuples: readonly (readonly [string, string, string, number, number])[],
): TimeExpandedGraph {
  const nodeIds = new Set<string>();
  const edges: FlowEdge[] = edgeTuples.map(([id, from, to, capacity, cost]) => {
    nodeIds.add(from);
    nodeIds.add(to);
    return { id, from, to, kind: "trip" satisfies EdgeKind, capacity, cost };
  });
  const nodes: FlowNode[] = [...nodeIds]
    .sort()
    .map((id) => ({ id, hubId: id, timeMin: 0 }));
  const nodeIndex = new Map<string, FlowNode>(nodes.map((n) => [n.id, n]));
  return { nodes, edges, nodeIndex };
}

describe("assignFreight — freight-to-leg assignment via min-cost flow (OPT-02)", () => {
  it("assigns a single block along its cheapest leg sequence", () => {
    // s→a→t cheap (1+1) vs s→t direct dear (5). 1-unit block ⇒ via a.
    const graph = graphOf([
      ["sa", "s", "a", 1, 1],
      ["at", "a", "t", 1, 1],
      ["st", "s", "t", 1, 5],
    ]);
    const supplies: readonly Supply[] = [
      { nodeId: "s", amount: 1 },
      { nodeId: "t", amount: -1 },
    ];

    const assignments = assignFreight(graph, supplies);

    expect(assignments).toHaveLength(1);
    const block = assignments[0]!;
    expect(block.legEdgeIds).toEqual(["sa", "at"]);
    expect(block.cost).toBe(2);
  });

  it("total assignment cost equals the minCostFlow optimum", () => {
    const graph = graphOf([
      ["e_SA", "S", "A", 2, 1],
      ["e_SB", "S", "B", 2, 3],
      ["e_AT", "A", "T", 1, 1],
      ["e_AB", "A", "B", 2, 1],
      ["e_BT", "B", "T", 3, 1],
    ]);
    const supplies: readonly Supply[] = [
      { nodeId: "S", amount: 3 },
      { nodeId: "T", amount: -3 },
    ];

    const assignments = assignFreight(graph, supplies);
    const flow = minCostFlow(graph, supplies);

    const totalAssigned = assignments.reduce((sum, a) => sum + a.cost, 0);
    expect(totalAssigned).toBe(flow.totalCost);
  });

  it("never routes more than an edge's capacity across all blocks", () => {
    const graph = graphOf([
      ["sa", "s", "a", 2, 1], // capacity 2 — shared by both blocks
      ["at", "a", "t", 2, 1],
    ]);
    const supplies: readonly Supply[] = [
      { nodeId: "s", amount: 2 },
      { nodeId: "t", amount: -2 },
    ];

    const assignments = assignFreight(graph, supplies);

    // Tally the flow each edge carries across all assignments.
    const usage = new Map<string, number>();
    for (const a of assignments) {
      for (const edgeId of a.legEdgeIds) {
        usage.set(edgeId, (usage.get(edgeId) ?? 0) + 1);
      }
    }
    for (const e of graph.edges) {
      expect(usage.get(e.id) ?? 0).toBeLessThanOrEqual(e.capacity);
    }
  });

  it("produces one assignment per positive-supply block", () => {
    const graph = graphOf([
      ["s1t", "s1", "t", 1, 1],
      ["s2t", "s2", "t", 1, 2],
    ]);
    const supplies: readonly Supply[] = [
      { nodeId: "s1", amount: 1 },
      { nodeId: "s2", amount: 1 },
      { nodeId: "t", amount: -2 },
    ];

    const assignments = assignFreight(graph, supplies);

    expect(assignments).toHaveLength(2);
    const byBlock = new Map(assignments.map((a) => [a.blockId, a]));
    expect(byBlock.get("s1")?.legEdgeIds).toEqual(["s1t"]);
    expect(byBlock.get("s2")?.legEdgeIds).toEqual(["s2t"]);
  });

  it("returns no assignments when the freight is infeasible", () => {
    const graph = graphOf([["e", "s", "t", 1, 1]]);
    const supplies: readonly Supply[] = [
      { nodeId: "s", amount: 2 },
      { nodeId: "t", amount: -2 },
    ];

    expect(assignFreight(graph, supplies)).toEqual([]);
  });

  it("works over a real Plan-02 time-expanded graph", () => {
    const network: OptimizerNetwork = {
      hubs: [{ hubId: "A" }, { hubId: "B" }],
      routes: [{ routeId: "RAB", fromHubId: "A", toHubId: "B", travelMin: 15, capacity: 5 }],
    };
    const schedule: OptimizerSchedule = {
      trips: [{ tripId: "t1", trailerId: "T1", routeId: "RAB", departMin: 0 }],
    };
    const scope: OptimizerScope = {
      hubIds: ["A", "B"],
      trailerIds: ["T1"],
      horizonStartMin: 0,
      horizonEndMin: 30,
      timeStepMin: 15,
    };
    const graph = buildTimeExpandedGraph(network, schedule, scope);
    const trip = graph.edges.find((e) => e.kind === "trip")!;

    // One block at the trip's tail node, delivered to its head node.
    const supplies: readonly Supply[] = [
      { nodeId: trip.from, amount: 1 },
      { nodeId: trip.to, amount: -1 },
    ];

    const assignments = assignFreight(graph, supplies);
    const flow = minCostFlow(graph, supplies);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.legEdgeIds).toContain(trip.id);
    expect(assignments.reduce((s, a) => s + a.cost, 0)).toBe(flow.totalCost);
  });
});
