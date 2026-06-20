import { describe, expect, it } from "vitest";

import { buildTimeExpandedGraph, nodeId } from "./time-expanded.js";
import {
  DEFAULT_GRAPH_CONFIG,
  type FlowEdge,
  type FlowNode,
  type GraphConfig,
  type OptimizerNetwork,
  type OptimizerSchedule,
  type OptimizerScope,
  type TimeExpandedGraph,
} from "./types.js";

/**
 * OPT-01 — `buildTimeExpandedGraph` unit tests (RED-first, TDD).
 *
 * The builder must turn a `(network, schedule, scope)` into hub@time nodes plus
 * the six §11.2 edge kinds (trip / wait / hold / load / unload / crossDock),
 * with INTEGER costs + capacities (anti-P12), every edge time-window-respecting
 * (`head.timeMin >= tail.timeMin`), and a DETERMINISTIC node/edge order so the
 * same inputs replay byte-identically (anti-P3).
 */

// --- Fixtures ---------------------------------------------------------------

/** A 2-hub network A→B with a 15-minute leg (so trips land on a timestep). */
function twoHubNetwork(travelMin = 15): OptimizerNetwork {
  return {
    hubs: [{ hubId: "A" }, { hubId: "B" }],
    routes: [
      {
        routeId: "RAB",
        fromHubId: "A",
        toHubId: "B",
        travelMin,
        capacity: 10,
      },
    ],
  };
}

/** A scope over `[0, end)` minutes, stepped by `step`, with both hubs/one trailer. */
function scope(
  end: number,
  step = 15,
  hubIds: readonly string[] = ["A", "B"],
  trailerIds: readonly string[] = ["T1"],
): OptimizerScope {
  return {
    hubIds,
    trailerIds,
    horizonStartMin: 0,
    horizonEndMin: end,
    timeStepMin: step,
  };
}

/** An empty schedule (no trips). */
const NO_TRIPS: OptimizerSchedule = { trips: [] };

/** A single trip on route RAB departing A at `departMin` on trailer T1. */
function oneTrip(departMin: number, trailerId = "T1"): OptimizerSchedule {
  return {
    trips: [{ tripId: "trip-1", trailerId, routeId: "RAB", departMin }],
  };
}

function ids(items: readonly { readonly id: string }[]): string[] {
  return items.map((i) => i.id);
}

function edgesOfKind(g: TimeExpandedGraph, kind: FlowEdge["kind"]): FlowEdge[] {
  return g.edges.filter((e) => e.kind === kind);
}

// --- Nodes ------------------------------------------------------------------

describe("buildTimeExpandedGraph — hub@time nodes", () => {
  it("yields the expected hub@time node set for a 2-hub, 2-timestep scope", () => {
    // Horizon [0,30) stepped by 15 ⇒ timesteps {0,15} for hubs {A,B}.
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));

    expect(ids(g.nodes)).toEqual(["A@0", "A@15", "B@0", "B@15"]);
  });

  it("uses the `${hubId}@${timeMin}` id convention", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    for (const n of g.nodes) {
      expect(n.id).toBe(nodeId(n.hubId, n.timeMin));
    }
  });

  it("builds nodeIndex mapping every node id to its node", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    expect(g.nodeIndex.size).toBe(g.nodes.length);
    for (const n of g.nodes) {
      expect(g.nodeIndex.get(n.id)).toEqual(n);
    }
  });

  it("excludes hubs not in scope from the node columns", () => {
    const net: OptimizerNetwork = {
      hubs: [{ hubId: "A" }, { hubId: "B" }, { hubId: "C" }],
      routes: twoHubNetwork().routes,
    };
    const g = buildTimeExpandedGraph(net, NO_TRIPS, scope(30, 15, ["A", "B"]));
    const hubs = new Set(g.nodes.map((n: FlowNode) => n.hubId));
    expect(hubs.has("C")).toBe(false);
  });

  it("treats horizonEndMin as exclusive (no node at the end boundary)", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    expect(g.nodeIndex.has("A@30")).toBe(false);
    expect(g.nodeIndex.has("A@15")).toBe(true);
  });
});

// --- Trip edges -------------------------------------------------------------

describe("buildTimeExpandedGraph — trip edges (§11.2)", () => {
  it("connects A@t → B@(t+travel) for a scheduled trip", () => {
    // Trip departs A@0 with a 15-min leg ⇒ arrives B@15.
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(0), scope(30));
    const trips = edgesOfKind(g, "trip");
    expect(trips).toHaveLength(1);
    const trip = trips[0]!;
    expect(trip.from).toBe("A@0");
    expect(trip.to).toBe("B@15");
  });

  it("rounds the arrival time to the nearest timestep node", () => {
    // 20-min leg from A@0, step 15 ⇒ arrival 20 rounds to a 15-multiple node.
    const g = buildTimeExpandedGraph(twoHubNetwork(20), oneTrip(0), scope(45));
    const trip = edgesOfKind(g, "trip")[0]!;
    const head = g.nodeIndex.get(trip.to)!;
    expect(head.timeMin % 15).toBe(0);
    expect(head.hubId).toBe("B");
    // 20 rounds up to 30 (>= depart+travel so flow never arrives early).
    expect(head.timeMin).toBeGreaterThanOrEqual(20);
  });

  it("gives the trip edge the route capacity and an integer travel-scaled cost", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(0), scope(30));
    const trip = edgesOfKind(g, "trip")[0]!;
    expect(trip.capacity).toBe(10);
    expect(Number.isInteger(trip.cost)).toBe(true);
    expect(trip.cost).toBe(DEFAULT_GRAPH_CONFIG.tripCostPerMin * 15);
  });

  it("drops trips whose trailer is out of scope", () => {
    const g = buildTimeExpandedGraph(
      twoHubNetwork(15),
      oneTrip(0, "T-OTHER"),
      scope(30, 15, ["A", "B"], ["T1"]),
    );
    expect(edgesOfKind(g, "trip")).toHaveLength(0);
  });

  it("drops trips whose arrival lands beyond the horizon", () => {
    // Departs A@15 with a 15-min leg ⇒ arrives B@30, which is outside [0,30).
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(15), scope(30));
    expect(edgesOfKind(g, "trip")).toHaveLength(0);
  });
});

// --- Wait / hold self-progress edges ----------------------------------------

describe("buildTimeExpandedGraph — wait/hold edges", () => {
  it("connects consecutive timesteps at the same hub via a wait edge", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    const waits = edgesOfKind(g, "wait");
    const waitPairs = waits.map((e) => [e.from, e.to]);
    // A@0→A@15 and B@0→B@15 (one step each, since {0,15} are the timesteps).
    expect(waitPairs).toContainEqual(["A@0", "A@15"]);
    expect(waitPairs).toContainEqual(["B@0", "B@15"]);
  });

  it("connects consecutive timesteps at the same hub via a hold edge with the hold cost", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    const holds = edgesOfKind(g, "hold");
    const aHold = holds.find((e) => e.from === "A@0" && e.to === "A@15");
    expect(aHold).toBeDefined();
    expect(aHold!.cost).toBe(DEFAULT_GRAPH_CONFIG.holdCost);
  });

  it("applies the configured wait cost to wait edges", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    const aWait = edgesOfKind(g, "wait").find((e) => e.from === "A@0");
    expect(aWait!.cost).toBe(DEFAULT_GRAPH_CONFIG.waitCost);
  });

  it("creates no self-progress edges past the last timestep", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    // Only one step (0→15); nothing leaves A@15 / B@15 as wait/hold.
    const fromLast = [...edgesOfKind(g, "wait"), ...edgesOfKind(g, "hold")].filter(
      (e) => e.from === "A@15" || e.from === "B@15",
    );
    expect(fromLast).toHaveLength(0);
  });
});

// --- Handling edges: load / unload / crossDock ------------------------------

describe("buildTimeExpandedGraph — handling edges (load/unload/crossDock)", () => {
  it("emits load, unload and crossDock self-edges at hub nodes with their handling costs", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));

    const load = edgesOfKind(g, "load");
    const unload = edgesOfKind(g, "unload");
    const cross = edgesOfKind(g, "crossDock");

    expect(load.length).toBeGreaterThan(0);
    expect(unload.length).toBeGreaterThan(0);
    expect(cross.length).toBeGreaterThan(0);

    expect(load.every((e) => e.cost === DEFAULT_GRAPH_CONFIG.loadCost)).toBe(true);
    expect(unload.every((e) => e.cost === DEFAULT_GRAPH_CONFIG.unloadCost)).toBe(true);
    expect(cross.every((e) => e.cost === DEFAULT_GRAPH_CONFIG.crossDockCost)).toBe(true);
  });

  it("anchors handling edges at a single hub@time node (from === to)", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(30));
    for (const e of [
      ...edgesOfKind(g, "load"),
      ...edgesOfKind(g, "unload"),
      ...edgesOfKind(g, "crossDock"),
    ]) {
      expect(e.from).toBe(e.to);
      expect(g.nodeIndex.has(e.from)).toBe(true);
    }
  });
});

// --- Invariants: integers + time-window respect -----------------------------

describe("buildTimeExpandedGraph — invariants", () => {
  it("makes every cost and capacity a non-negative integer (anti-P12)", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(20), oneTrip(0), scope(60));
    expect(g.edges.length).toBeGreaterThan(0);
    for (const e of g.edges) {
      expect(Number.isInteger(e.cost)).toBe(true);
      expect(Number.isInteger(e.capacity)).toBe(true);
      expect(e.cost).toBeGreaterThanOrEqual(0);
      expect(e.capacity).toBeGreaterThanOrEqual(0);
    }
  });

  it("never violates time ordering: head.timeMin >= tail.timeMin for every edge", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(20), oneTrip(0), scope(60));
    for (const e of g.edges) {
      const tail = g.nodeIndex.get(e.from)!;
      const head = g.nodeIndex.get(e.to)!;
      expect(head).toBeDefined();
      expect(tail).toBeDefined();
      expect(head.timeMin).toBeGreaterThanOrEqual(tail.timeMin);
    }
  });

  it("references only in-graph nodes from every edge endpoint", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(0), scope(60));
    for (const e of g.edges) {
      expect(g.nodeIndex.has(e.from)).toBe(true);
      expect(g.nodeIndex.has(e.to)).toBe(true);
    }
  });

  it("gives every edge a unique id", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(0), scope(60));
    const seen = new Set(g.edges.map((e) => e.id));
    expect(seen.size).toBe(g.edges.length);
  });
});

// --- Determinism ------------------------------------------------------------

describe("buildTimeExpandedGraph — determinism (anti-P3/P7)", () => {
  it("yields deeply-equal node and edge arrays across two identical calls", () => {
    const net = twoHubNetwork(20);
    const sched = oneTrip(0);
    const sc = scope(60);

    const a = buildTimeExpandedGraph(net, sched, sc);
    const b = buildTimeExpandedGraph(net, sched, sc);

    expect(a.nodes).toEqual(b.nodes);
    expect(a.edges).toEqual(b.edges);
  });

  it("is order-insensitive to input hub/route/trip ordering (canonical output order)", () => {
    const net1: OptimizerNetwork = {
      hubs: [{ hubId: "A" }, { hubId: "B" }],
      routes: twoHubNetwork().routes,
    };
    const net2: OptimizerNetwork = {
      hubs: [{ hubId: "B" }, { hubId: "A" }],
      routes: twoHubNetwork().routes,
    };
    const a = buildTimeExpandedGraph(net1, NO_TRIPS, scope(30));
    const b = buildTimeExpandedGraph(net2, NO_TRIPS, scope(30));
    expect(ids(a.nodes)).toEqual(ids(b.nodes));
    expect(a.edges).toEqual(b.edges);
  });

  it("produces a sorted-by-id node array", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(), NO_TRIPS, scope(60));
    const sorted = [...ids(g.nodes)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(ids(g.nodes)).toEqual(sorted);
  });

  it("produces a sorted-by-id edge array", () => {
    const g = buildTimeExpandedGraph(twoHubNetwork(20), oneTrip(0), scope(60));
    const sorted = [...ids(g.edges)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(ids(g.edges)).toEqual(sorted);
  });
});

// --- Config override --------------------------------------------------------

describe("buildTimeExpandedGraph — config override", () => {
  it("honors an overridden integer GraphConfig", () => {
    const cfg: GraphConfig = {
      ...DEFAULT_GRAPH_CONFIG,
      waitCost: 3,
      holdCost: 7,
      tripCostPerMin: 2,
    };
    const g = buildTimeExpandedGraph(twoHubNetwork(15), oneTrip(0), scope(30), cfg);
    expect(edgesOfKind(g, "wait")[0]!.cost).toBe(3);
    expect(edgesOfKind(g, "hold")[0]!.cost).toBe(7);
    expect(edgesOfKind(g, "trip")[0]!.cost).toBe(2 * 15);
  });
});
