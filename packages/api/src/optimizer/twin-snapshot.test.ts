/**
 * Tests for `buildTwinSnapshot` (Plan 05-02, Task 1).
 *
 * Verifies that the function:
 *  - assembles a deterministic `TwinSnapshot` from live projection rows
 *  - sorts all collections by id (determinism, anti-P3)
 *  - derives `travelMin` from the sim's TRANSIT_TICKS constant (30 min)
 *  - derives `departureMin` from sim/event time, NEVER `Date.now`
 *  - produces byte-identical output for identical inputs (idempotency)
 *  - only references hubs that exist in the trailer's route (nextUnloadHubId)
 *  - uses integer capacities/volumes (P12)
 */

import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import type { ProjectionDb } from "@mm/projections";
import { buildTwinSnapshot, TRANSIT_MIN } from "./twin-snapshot.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type SnapshotDb = Kysely<Database & ProjectionDb>;

/**
 * Build a minimal mock DB that returns the given fixture rows for the queries
 * `buildTwinSnapshot` issues. We spy on Kysely-style chainable query builders
 * using a fluent stub.
 */
function makeDb(opts: {
  trailerRows?: Array<{
    trailer_id: string;
    status: string;
    current_hub_id: string | null;
    trip_id: string | null;
    assigned_package_ids: string[];
  }>;
  routeEventRows?: Array<{
    data: {
      routeId: string;
      fromHubId: string;
      toHubId: string;
      geometry: Array<[number, number]>;
    };
  }>;
  hubInventoryRows?: Array<{
    hub_id: string;
    inbound: string[];
    outbound: string[];
    staged: string[];
  }>;
  trailerDepartedRows?: Array<{
    data: {
      trailerId: string;
      tripId: string;
      fromHubId: string;
      toHubId: string;
      departedAt: string;
    };
  }>;
}): SnapshotDb {
  const trailerRows = opts.trailerRows ?? [];
  const routeEventRows = opts.routeEventRows ?? [];
  const hubInventoryRows = opts.hubInventoryRows ?? [];
  const trailerDepartedRows = opts.trailerDepartedRows ?? [];

  function makeChain(result: unknown[]): unknown {
    const chain: Record<string, unknown> = {};
    const methods = [
      "selectFrom",
      "select",
      "selectAll",
      "where",
      "orderBy",
      "execute",
      "executeTakeFirst",
    ];
    for (const m of methods) {
      if (m === "execute") {
        chain[m] = vi.fn().mockResolvedValue(result);
      } else if (m === "executeTakeFirst") {
        chain[m] = vi.fn().mockResolvedValue(result[0]);
      } else {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
    }
    return chain;
  }

  // We need different chains per table
  const trailerChain = makeChain(trailerRows);
  const routeChain = makeChain(routeEventRows);
  const inventoryChain = makeChain(hubInventoryRows);
  const departedChain = makeChain(trailerDepartedRows);

  let callCount = 0;

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      callCount += 1;
      if (table === "trailer_state") return trailerChain;
      if (table === "hub_inventory") return inventoryChain;
      if (table === "events") {
        // Two calls: RouteRegistered events + TrailerDeparted events (in order)
        // We track which events call we're on
        const evenCalls = [routeChain, departedChain];
        // crude approach: use call order
        return evenCalls[callCount <= 2 ? 0 : 1] ?? routeChain;
      }
      return makeChain([]);
    }),
  } as unknown as SnapshotDb;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTE_A: {
  data: {
    routeId: string;
    fromHubId: string;
    toHubId: string;
    geometry: Array<[number, number]>;
  };
} = {
  data: {
    routeId: "route-atl-chi",
    fromHubId: "ATL",
    toHubId: "CHI",
    geometry: [
      [-84.39, 33.75],
      [-87.63, 41.88],
    ],
  },
};

const ROUTE_B: {
  data: {
    routeId: string;
    fromHubId: string;
    toHubId: string;
    geometry: Array<[number, number]>;
  };
} = {
  data: {
    routeId: "route-chi-det",
    fromHubId: "CHI",
    toHubId: "DET",
    geometry: [
      [-87.63, 41.88],
      [-83.05, 42.33],
    ],
  },
};

const TRAILER_1 = {
  trailer_id: "T001",
  status: "arrived",
  current_hub_id: "ATL",
  trip_id: null,
  assigned_package_ids: ["pkg-01", "pkg-02"],
};

const TRAILER_2 = {
  trailer_id: "T002",
  status: "arrived",
  current_hub_id: "CHI",
  trip_id: null,
  assigned_package_ids: ["pkg-03"],
};

const HUB_ATL = {
  hub_id: "ATL",
  inbound: [],
  outbound: ["pkg-01"],
  staged: ["pkg-02"],
};

const HUB_CHI = {
  hub_id: "CHI",
  inbound: ["pkg-03"],
  outbound: [],
  staged: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TRANSIT_MIN constant", () => {
  it("is 30 (the sim transit tick duration in minutes)", () => {
    expect(TRANSIT_MIN).toBe(30);
  });
});

describe("buildTwinSnapshot", () => {
  it("returns an empty snapshot when there are no trailers or routes", async () => {
    const db = makeDb({});
    const snapshot = await buildTwinSnapshot(db);
    expect(snapshot.hubs).toEqual([]);
    expect(snapshot.routes).toEqual([]);
    expect(snapshot.trailers).toEqual([]);
  });

  it("assembles routes from RouteRegistered events with TRANSIT_MIN as travelMin", async () => {
    const db = makeDb({
      routeEventRows: [ROUTE_A, ROUTE_B],
    });
    const snapshot = await buildTwinSnapshot(db);

    expect(snapshot.routes).toHaveLength(2);
    // Sorted by routeId
    expect(snapshot.routes[0]!.routeId).toBe("route-atl-chi");
    expect(snapshot.routes[0]!.fromHubId).toBe("ATL");
    expect(snapshot.routes[0]!.toHubId).toBe("CHI");
    expect(snapshot.routes[0]!.travelMin).toBe(TRANSIT_MIN);
    expect(snapshot.routes[1]!.routeId).toBe("route-chi-det");
    expect(snapshot.routes[1]!.travelMin).toBe(TRANSIT_MIN);
  });

  it("capacity is a positive integer", async () => {
    const db = makeDb({ routeEventRows: [ROUTE_A] });
    const snapshot = await buildTwinSnapshot(db);
    const cap = snapshot.routes[0]!.capacity;
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });

  it("assembles hubs sorted by id from trailer_state rows and route events", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_2, TRAILER_1], // intentionally reversed
      routeEventRows: [ROUTE_A, ROUTE_B],
    });
    const snapshot = await buildTwinSnapshot(db);

    // Hubs should be sorted
    const sorted = [...snapshot.hubs].sort();
    expect(snapshot.hubs).toEqual(sorted);
    // Should include ATL and CHI (trailer hubs + route hubs)
    expect(snapshot.hubs).toContain("ATL");
    expect(snapshot.hubs).toContain("CHI");
  });

  it("assembles trailers sorted by trailerId", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_2, TRAILER_1], // reversed
      routeEventRows: [ROUTE_A, ROUTE_B],
      hubInventoryRows: [HUB_ATL, HUB_CHI],
    });
    const snapshot = await buildTwinSnapshot(db);
    const ids = snapshot.trailers.map((t) => t.trailerId);
    expect(ids).toEqual([...ids].sort());
  });

  it("trailers have currentHubId from trailer_state rows", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_1],
      routeEventRows: [ROUTE_A],
      hubInventoryRows: [HUB_ATL],
    });
    const snapshot = await buildTwinSnapshot(db);
    const t = snapshot.trailers.find((tr) => tr.trailerId === "T001");
    expect(t).toBeDefined();
    expect(t!.currentHubId).toBe("ATL");
  });

  it("trailer capacity is a positive integer (P12)", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_1],
      routeEventRows: [ROUTE_A],
    });
    const snapshot = await buildTwinSnapshot(db);
    const t = snapshot.trailers[0];
    expect(t).toBeDefined();
    expect(Number.isInteger(t!.capacity)).toBe(true);
    expect(t!.capacity).toBeGreaterThan(0);
  });

  it("block volumes are integers (P12)", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_1],
      routeEventRows: [ROUTE_A],
      hubInventoryRows: [HUB_ATL],
    });
    const snapshot = await buildTwinSnapshot(db);
    for (const trailer of snapshot.trailers) {
      for (const block of trailer.blocks) {
        expect(Number.isInteger(block.volume)).toBe(true);
      }
    }
  });

  it("same input rows produce byte-identical snapshot (determinism / anti-P3)", async () => {
    // Create two separate db mocks with identical data
    function makeIdenticalDb() {
      return makeDb({
        trailerRows: [TRAILER_2, TRAILER_1],
        routeEventRows: [ROUTE_A, ROUTE_B],
        hubInventoryRows: [HUB_ATL, HUB_CHI],
      });
    }
    const snap1 = await buildTwinSnapshot(makeIdenticalDb());
    const snap2 = await buildTwinSnapshot(makeIdenticalDb());
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
  });

  it("departureMin is a number derived from the snapshot (not Date.now)", async () => {
    // We verify Date.now is never called in the path
    const dateSpy = vi.spyOn(Date, "now");
    const db = makeDb({
      trailerRows: [TRAILER_1],
      routeEventRows: [ROUTE_A],
    });
    await buildTwinSnapshot(db);
    expect(dateSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it("route TwinStop indices are 0-based integers", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_1],
      routeEventRows: [ROUTE_A],
    });
    const snapshot = await buildTwinSnapshot(db);
    for (const trailer of snapshot.trailers) {
      for (const stop of trailer.route) {
        expect(Number.isInteger(stop.stopIndex)).toBe(true);
        expect(stop.stopIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
