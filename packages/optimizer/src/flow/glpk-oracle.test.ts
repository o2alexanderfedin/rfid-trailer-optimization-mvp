import { describe, expect, it } from "vitest";

// The Node (synchronous) WASM GLPK solver. This is a TEST-ONLY devDependency —
// THE Plan-03 min-cost-flow correctness ORACLE — and is NEVER imported from
// `src`, so glpk.js never becomes a runtime dependency of @mm/optimizer.
import GLPK, { type GLPK as GLPKInstance, type LP } from "glpk.js/node";

import type { EdgeKind, FlowEdge, FlowNode, TimeExpandedGraph } from "../graph/types.js";
import { minCostFlow } from "./min-cost-flow.js";
import type { Supply } from "./types.js";

/**
 * THE KEYSTONE TEST (OPT-02): the pure-TS Successive-Shortest-Path solver's
 * optimum must EQUAL the glpk.js exact-LP optimum on a battery of seeded random
 * small instances + the hand fixtures.
 *
 * Min-cost flow is the concentrated engineering risk of Phase 4 and there is no
 * maintained JS MCF library, so we gate our hand-rolled SSP against an
 * INDEPENDENT exact solver (GLPK, WASM). Integer costs/capacities (anti-P12) make
 * the comparison exact equality — no float tolerance. All randomness is seeded
 * INSIDE this test (deterministic), and glpk.js appears ONLY here, never in `src`.
 */

/** A tiny deterministic LCG (Numerical Recipes constants) — seeded in-test only. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Uniform integer in `[lo, hi]` from the seeded RNG. */
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

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

interface Instance {
  readonly graph: TimeExpandedGraph;
  readonly supplies: readonly Supply[];
}

/**
 * A seeded random small MCF instance: `nodes` laid out 0..n-1, a forward-only DAG
 * of edges `i→j (i<j)` so the graph is acyclic (no negative-cycle pathology) and
 * always time-window-respecting, with a single source (node 0, supply `+d`) and a
 * single sink (node n-1, demand `−d`). Small ints keep GLPK fast + exact.
 */
function randomInstance(rng: () => number): Instance {
  const n = randInt(rng, 3, 6);
  const tuples: (readonly [string, string, string, number, number])[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Sparse-ish: include each forward edge ~70% of the time.
      if (rng() < 0.7) {
        const cap = randInt(rng, 1, 4);
        const cost = randInt(rng, 0, 9);
        tuples.push([`e${i}_${j}`, `v${i}`, `v${j}`, cap, cost]);
      }
    }
  }
  // Guarantee a path 0→1→…→n-1 so feasibility is reachable for small demand.
  for (let i = 0; i + 1 < n; i += 1) {
    if (!tuples.some(([, from, to]) => from === `v${i}` && to === `v${i + 1}`)) {
      tuples.push([`p${i}`, `v${i}`, `v${i + 1}`, randInt(rng, 1, 4), randInt(rng, 0, 9)]);
    }
  }
  const graph = graphOf(tuples);
  const demand = randInt(rng, 1, 5);
  const supplies: Supply[] = [
    { nodeId: "v0", amount: demand },
    { nodeId: `v${n - 1}`, amount: -demand },
  ];
  return { graph, supplies };
}

/**
 * Translate an instance to the equivalent min-cost-flow LP and solve it exactly
 * with GLPK: minimise `Σ cost·flow` subject to per-node conservation
 * (`Σ out − Σ in = supply`, GLP_FX) and `0 ≤ flow ≤ capacity` bounds.
 */
function solveWithGlpk(
  glpk: GLPKInstance,
  { graph, supplies }: Instance,
): { feasible: boolean; z: number } {
  const supplyByNode = new Map<string, number>();
  for (const s of supplies) supplyByNode.set(s.nodeId, s.amount);

  const lp: LP = {
    name: "mcf",
    objective: {
      direction: glpk.GLP_MIN,
      name: "cost",
      vars: graph.edges.map((e) => ({ name: e.id, coef: e.cost })),
    },
    subjectTo: graph.nodes.map((node) => {
      // outflow positive, inflow negative ⇒ net == supply.
      const vars = [
        ...graph.edges
          .filter((e) => e.from === node.id)
          .map((e) => ({ name: e.id, coef: 1 })),
        ...graph.edges
          .filter((e) => e.to === node.id)
          .map((e) => ({ name: e.id, coef: -1 })),
      ];
      const supply = supplyByNode.get(node.id) ?? 0;
      return {
        name: `c_${node.id}`,
        vars,
        bnds: { type: glpk.GLP_FX, lb: supply, ub: supply },
      };
    }),
    bounds: graph.edges.map((e) => ({
      name: e.id,
      type: glpk.GLP_DB,
      lb: 0,
      ub: e.capacity,
    })),
  };

  const res = glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });
  const feasible = res.result.status === glpk.GLP_OPT;
  return { feasible, z: feasible ? Math.round(res.result.z) : 0 };
}

// The hand fixtures from min-cost-flow.test.ts, re-asserted against the oracle.
const DIAMOND: Instance = {
  graph: graphOf([
    ["e_SA", "S", "A", 2, 1],
    ["e_SB", "S", "B", 2, 3],
    ["e_AT", "A", "T", 1, 1],
    ["e_AB", "A", "B", 2, 1],
    ["e_BT", "B", "T", 3, 1],
  ]),
  supplies: [
    { nodeId: "S", amount: 3 },
    { nodeId: "T", amount: -3 },
  ],
};
const PARALLEL: Instance = {
  graph: graphOf([
    ["cheap", "s", "t", 1, 2],
    ["dear", "s", "t", 1, 5],
  ]),
  supplies: [
    { nodeId: "s", amount: 1 },
    { nodeId: "t", amount: -1 },
  ],
};

describe("KEYSTONE: SSP optimum == glpk.js exact-LP optimum (OPT-02)", () => {
  it("matches glpk on the hand fixtures (diamond + parallel paths)", async () => {
    const glpk = await GLPK();
    for (const inst of [DIAMOND, PARALLEL]) {
      const ssp = minCostFlow(inst.graph, inst.supplies);
      const exact = solveWithGlpk(glpk, inst);
      expect(ssp.feasible).toBe(exact.feasible);
      expect(ssp.totalCost).toBe(exact.z);
    }
  });

  it("matches glpk on a battery of >= 20 seeded random small instances", async () => {
    const glpk = await GLPK();
    // Several seeds × instances each ⇒ well above the required 20, and a wider
    // spread of topologies/costs than one seed gives.
    const seeds = [0x5eed_1234, 0x0bad_f00d, 0x1357_9bdf, 0xdead_beef];
    const perSeed = 15;

    let feasibleCount = 0;
    for (const seed of seeds) {
      const rng = makeRng(seed);
      for (let i = 0; i < perSeed; i += 1) {
        const inst = randomInstance(rng);
        const ssp = minCostFlow(inst.graph, inst.supplies);
        const exact = solveWithGlpk(glpk, inst);
        const tag = `seed ${seed.toString(16)} #${i}`;

        // Feasibility agrees with the independent solver (anti-P2: a real gate).
        expect(ssp.feasible, `${tag}: feasibility must agree`).toBe(exact.feasible);
        if (ssp.feasible) {
          // Exact integer equality — no float tolerance (anti-P12).
          expect(ssp.totalCost, `${tag}: optimum must equal glpk`).toBe(exact.z);
          feasibleCount += 1;
        }
      }
    }
    // Sanity: the generator actually produced solvable instances to compare.
    expect(feasibleCount).toBeGreaterThanOrEqual(20);
  });

  it("agrees with glpk on a capacity-starved INFEASIBLE instance", async () => {
    const glpk = await GLPK();
    // 1 unit of capacity out of the source, but 3 demanded ⇒ no feasible flow.
    const inst: Instance = {
      graph: graphOf([
        ["e1", "s", "m", 1, 1],
        ["e2", "m", "t", 5, 1],
      ]),
      supplies: [
        { nodeId: "s", amount: 3 },
        { nodeId: "t", amount: -3 },
      ],
    };
    const ssp = minCostFlow(inst.graph, inst.supplies);
    const exact = solveWithGlpk(glpk, inst);

    expect(ssp.feasible).toBe(false);
    expect(exact.feasible).toBe(false);
  });
});
