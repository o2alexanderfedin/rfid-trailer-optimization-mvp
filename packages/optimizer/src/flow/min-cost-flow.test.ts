import { describe, expect, it } from "vitest";

import type { EdgeKind, FlowEdge, FlowNode, TimeExpandedGraph } from "../graph/types.js";
import { minCostFlow } from "./min-cost-flow.js";
import type { Supply } from "./types.js";

/**
 * Min-cost-flow (SSP) solver tests (OPT-02).
 *
 * The solver operates on the GENERIC {@link TimeExpandedGraph} shape, so these
 * fixtures build tiny abstract graphs by hand (the time-expanded semantics are
 * irrelevant to the flow math — only `from`/`to`/`capacity`/`cost` matter). All
 * costs/capacities/supplies are small INTEGERS (anti-P12), and the same inputs
 * must always yield the same result (anti-P3 determinism).
 */

/** Build a tiny graph from `[id, from, to, capacity, cost]` edge tuples. */
function graphOf(
  edgeTuples: readonly (readonly [string, string, string, number, number])[],
): TimeExpandedGraph {
  const nodeIds = new Set<string>();
  const edges: FlowEdge[] = edgeTuples.map(([id, from, to, capacity, cost]) => {
    nodeIds.add(from);
    nodeIds.add(to);
    // `kind` is irrelevant to the flow math; a fixed value keeps it deterministic.
    return { id, from, to, kind: "trip" satisfies EdgeKind, capacity, cost };
  });
  const nodes: FlowNode[] = [...nodeIds]
    .sort()
    .map((id) => ({ id, hubId: id, timeMin: 0 }));
  const nodeIndex = new Map<string, FlowNode>(nodes.map((n) => [n.id, n]));
  return { nodes, edges, nodeIndex };
}

/**
 * The per-node net SUPPLY (outflow − inflow) from a flow result + graph. At
 * optimality this must equal each node's supply: `> 0` at a source, `< 0` at a
 * sink, `0` at a pass-through (flow conservation).
 */
function netSupplyByNode(
  graph: TimeExpandedGraph,
  flowByEdgeId: ReadonlyMap<string, number>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const n of graph.nodes) net.set(n.id, 0);
  for (const e of graph.edges) {
    const f = flowByEdgeId.get(e.id) ?? 0;
    net.set(e.from, (net.get(e.from) ?? 0) + f); // outflow
    net.set(e.to, (net.get(e.to) ?? 0) - f); // inflow
  }
  return net;
}

/**
 * The hand-computed 4-node diamond fixture (S, A, B, T).
 *
 * Sending 3 units S→T, the unique cheapest routing is:
 *   1× S→A→T   (cost 1+1 = 2)
 *   1× S→A→B→T (cost 1+1+1 = 3)  — cheaper than S→B→T (3+1 = 4)
 *   1× S→B→T   (cost 3+1 = 4)    — S→A is now saturated (cap 2)
 * ⇒ optimum cost 9 with the per-edge flows asserted below.
 */
const DIAMOND = graphOf([
  ["e_SA", "S", "A", 2, 1],
  ["e_SB", "S", "B", 2, 3],
  ["e_AT", "A", "T", 1, 1],
  ["e_AB", "A", "B", 2, 1],
  ["e_BT", "B", "T", 3, 1],
]);
const DIAMOND_SUPPLIES: readonly Supply[] = [
  { nodeId: "S", amount: 3 },
  { nodeId: "T", amount: -3 },
];

describe("minCostFlow — Successive Shortest Path solver (OPT-02)", () => {
  it("returns the hand-computed optimum + per-edge flow on the diamond fixture", () => {
    const res = minCostFlow(DIAMOND, DIAMOND_SUPPLIES);

    expect(res.feasible).toBe(true);
    expect(res.totalCost).toBe(9);
    expect(res.flowByEdgeId.get("e_SA")).toBe(2);
    expect(res.flowByEdgeId.get("e_SB")).toBe(1);
    expect(res.flowByEdgeId.get("e_AT")).toBe(1);
    expect(res.flowByEdgeId.get("e_AB")).toBe(1);
    expect(res.flowByEdgeId.get("e_BT")).toBe(2);
  });

  it("conserves flow at every node (outflow − inflow == supply)", () => {
    const res = minCostFlow(DIAMOND, DIAMOND_SUPPLIES);
    const net = netSupplyByNode(DIAMOND, res.flowByEdgeId);

    expect(net.get("S")).toBe(3); // source supplies +3
    expect(net.get("A")).toBe(0); // pass-through conserves
    expect(net.get("B")).toBe(0);
    expect(net.get("T")).toBe(-3); // sink absorbs 3
  });

  it("routes a single unit along the cheaper of two parallel paths", () => {
    // s→t with a cheap (cost 2) and a dear (cost 5) path; 1 unit ⇒ cost 2.
    const g = graphOf([
      ["cheap", "s", "t", 1, 2],
      ["dear", "s", "t", 1, 5],
    ]);
    const res = minCostFlow(g, [
      { nodeId: "s", amount: 1 },
      { nodeId: "t", amount: -1 },
    ]);

    expect(res.feasible).toBe(true);
    expect(res.totalCost).toBe(2);
    expect(res.flowByEdgeId.get("cheap")).toBe(1);
    expect(res.flowByEdgeId.get("dear") ?? 0).toBe(0);
  });

  it("flags infeasible when demand exceeds the min cut capacity", () => {
    // Only 1 unit of capacity out of s, but 2 units demanded ⇒ infeasible.
    const g = graphOf([["e", "s", "t", 1, 1]]);
    const res = minCostFlow(g, [
      { nodeId: "s", amount: 2 },
      { nodeId: "t", amount: -2 },
    ]);

    expect(res.feasible).toBe(false);
  });

  it("is feasible (cost 0) for zero net supply", () => {
    const res = minCostFlow(DIAMOND, [
      { nodeId: "S", amount: 0 },
      { nodeId: "T", amount: 0 },
    ]);
    expect(res.feasible).toBe(true);
    expect(res.totalCost).toBe(0);
  });

  it("is deterministic: identical inputs ⇒ identical totalCost + flowByEdgeId", () => {
    const a = minCostFlow(DIAMOND, DIAMOND_SUPPLIES);
    const b = minCostFlow(DIAMOND, DIAMOND_SUPPLIES);

    expect(a.totalCost).toBe(b.totalCost);
    expect([...a.flowByEdgeId.entries()].sort()).toEqual(
      [...b.flowByEdgeId.entries()].sort(),
    );
  });

  it("splits flow across multiple sources and sinks (multi-commodity-free)", () => {
    // Two sources s1,s2 each +1; two sinks t1,t2 each -1; direct edges only.
    const g = graphOf([
      ["s1t1", "s1", "t1", 1, 1],
      ["s2t2", "s2", "t2", 1, 1],
      ["s1t2", "s1", "t2", 1, 5],
    ]);
    const res = minCostFlow(g, [
      { nodeId: "s1", amount: 1 },
      { nodeId: "s2", amount: 1 },
      { nodeId: "t1", amount: -1 },
      { nodeId: "t2", amount: -1 },
    ]);

    expect(res.feasible).toBe(true);
    expect(res.totalCost).toBe(2);
    expect(res.flowByEdgeId.get("s1t1")).toBe(1);
    expect(res.flowByEdgeId.get("s2t2")).toBe(1);
  });
});
