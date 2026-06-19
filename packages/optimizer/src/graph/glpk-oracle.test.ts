import { describe, expect, it } from "vitest";

// The Node (synchronous) entry of the WASM GLPK solver. This is a TEST-ONLY
// devDependency — the Plan-03 min-cost-flow correctness ORACLE — and is NEVER
// imported from `src`, so it never becomes a runtime dependency of @mm/optimizer.
import GLPK, { type LP } from "glpk.js/node";

import { buildTimeExpandedGraph } from "./time-expanded.js";
import {
  DEFAULT_GRAPH_CONFIG,
  type OptimizerNetwork,
  type OptimizerSchedule,
  type OptimizerScope,
} from "./types.js";

/**
 * glpk.js oracle wiring smoke test (pre-wires the Plan-03 correctness oracle).
 *
 * Proves the test-only WASM LP solver loads and solves, and that the
 * INTEGER-costed time-expanded graph (OPT-01) translates cleanly into a GLPK
 * min-cost-flow LP — the exact-optimum oracle Plan 03's successive-shortest-path
 * solver is validated against. glpk.js stays a devDependency; this file lives
 * under `src/**.test.ts`, never in shipped `src`.
 */
describe("glpk.js oracle wiring (test-only devDependency)", () => {
  it("loads the GLPK WASM factory and exposes the min-cost-flow constants", async () => {
    const glpk = await GLPK();
    expect(typeof glpk.solve).toBe("function");
    expect(typeof glpk.GLP_MIN).toBe("number");
    expect(typeof glpk.GLP_FX).toBe("number");
  });

  it("solves a hand-computed min-cost-flow LP to its known optimum", async () => {
    const glpk = await GLPK();

    // One unit of flow s→t, two paths: cheap (cost 2) vs dear (cost 5).
    // Optimal = route the unit along the cheap path ⇒ objective 2.
    const lp: LP = {
      name: "mcf",
      objective: {
        direction: glpk.GLP_MIN,
        name: "cost",
        vars: [
          { name: "cheap", coef: 2 },
          { name: "dear", coef: 5 },
        ],
      },
      subjectTo: [
        {
          name: "supply",
          vars: [
            { name: "cheap", coef: 1 },
            { name: "dear", coef: 1 },
          ],
          bnds: { type: glpk.GLP_FX, lb: 1, ub: 1 },
        },
      ],
      bounds: [
        { name: "cheap", type: glpk.GLP_DB, lb: 0, ub: 1 },
        { name: "dear", type: glpk.GLP_DB, lb: 0, ub: 1 },
      ],
    };

    const res = glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });
    expect(res.result.status).toBe(glpk.GLP_OPT);
    expect(res.result.z).toBe(2);
    expect(res.result.vars.cheap).toBe(1);
    expect(res.result.vars.dear).toBe(0);
  });

  it("encodes an OPT-01 graph edge's integer cost into a GLPK var coefficient", async () => {
    const glpk = await GLPK();

    const network: OptimizerNetwork = {
      hubs: [{ hubId: "A" }, { hubId: "B" }],
      routes: [
        { routeId: "RAB", fromHubId: "A", toHubId: "B", travelMin: 15, capacity: 5 },
      ],
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
    expect(Number.isInteger(trip.cost)).toBe(true);
    expect(trip.cost).toBe(DEFAULT_GRAPH_CONFIG.tripCostPerMin * 15);

    // Push 1 unit of flow over the trip edge; its objective contribution is the
    // edge's integer cost — exactly how Plan 03 will feed the graph to the oracle.
    const lp: LP = {
      name: "edge-cost",
      objective: {
        direction: glpk.GLP_MIN,
        name: "z",
        vars: [{ name: trip.id, coef: trip.cost }],
      },
      subjectTo: [
        {
          name: "send-one",
          vars: [{ name: trip.id, coef: 1 }],
          bnds: { type: glpk.GLP_FX, lb: 1, ub: 1 },
        },
      ],
      bounds: [{ name: trip.id, type: glpk.GLP_DB, lb: 0, ub: trip.capacity }],
    };

    const res = glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF });
    expect(res.result.status).toBe(glpk.GLP_OPT);
    expect(res.result.z).toBe(trip.cost);
  });
});
