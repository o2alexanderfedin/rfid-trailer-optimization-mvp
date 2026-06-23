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
import { loadStaticRoadGeometry, routeId } from "@mm/simulation";
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
    /** OPT-HOS-01: the driver bound to the trailer's trip (PRJ-02). */
    driver_id?: string | null;
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
  /** OPT-HOS-01: Phase-13 `driver_status` rows (driver → remaining drive minutes). */
  driverStatusRows?: Array<{
    driver_id: string;
    status: string;
    remaining_drive_minutes: number;
  }>;
}): SnapshotDb {
  const trailerRows = opts.trailerRows ?? [];
  const routeEventRows = opts.routeEventRows ?? [];
  const hubInventoryRows = opts.hubInventoryRows ?? [];
  const trailerDepartedRows = opts.trailerDepartedRows ?? [];
  const driverStatusRows = opts.driverStatusRows ?? [];

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
  const driverStatusChain = makeChain(driverStatusRows);

  let callCount = 0;

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      callCount += 1;
      if (table === "trailer_state") return trailerChain;
      if (table === "hub_inventory") return inventoryChain;
      if (table === "driver_status") return driverStatusChain;
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

  it("assembles routes from RouteRegistered events with geography-derived expected-transit travelMin (OPT-09)", async () => {
    const db = makeDb({
      routeEventRows: [ROUTE_A, ROUTE_B],
    });
    const snapshot = await buildTwinSnapshot(db);

    expect(snapshot.routes).toHaveLength(2);
    // Sorted by routeId
    expect(snapshot.routes[0]!.routeId).toBe("route-atl-chi");
    expect(snapshot.routes[0]!.fromHubId).toBe("ATL");
    expect(snapshot.routes[0]!.toHubId).toBe("CHI");
    // RE-BASELINE (OPT-09/OPT-10): `travelMin` is no longer the flat TRANSIT_MIN
    // (30). It is now the deterministic per-leg expected-transit MEAN
    // `round(expectedTransitMinutes(geometry endpoints, DEFAULT_TIMING_CONFIG))`.
    //  - ATL→CHI (≈743 km great-circle @ 80 km/h, ×exp(σ²/2)) ⇒ 743 min.
    //  - CHI→DET (a much shorter regional leg) ⇒ 299 min.
    // Long coast legs now plan against far larger transit than short ones (the
    // whole point of TIME-01/OPT-09) — verified against the @mm/domain estimator.
    expect(snapshot.routes[0]!.travelMin).toBe(743);
    expect(snapshot.routes[1]!.routeId).toBe("route-chi-det");
    expect(snapshot.routes[1]!.travelMin).toBe(299);
    // Both are whole minutes (TwinRoute.travelMin integer contract, anti-P12).
    expect(Number.isInteger(snapshot.routes[0]!.travelMin)).toBe(true);
    expect(Number.isInteger(snapshot.routes[1]!.travelMin)).toBe(true);
  });

  it("travelMin PREFERS the committed ORS road duration_s for a real USA-hub leg (VIZ-06)", async () => {
    // A route whose directed id matches a leg in the committed road geometry
    // (`route-MEM-ORD`). Its `travelMin` must be `round(duration_s / 60)` — the
    // ORS drive time the displayed road polyline is based on — NOT the haversine
    // estimate over the (here arbitrary) geometry endpoints.
    const road = loadStaticRoadGeometry();
    const orsDurationS = road?.legs[routeId("MEM", "ORD")]?.duration_s;
    expect(orsDurationS).toBeDefined();
    const expectedTravelMin = Math.round(orsDurationS! / 60);

    const db = makeDb({
      routeEventRows: [
        {
          data: {
            // Deliberately give endpoints that would yield a DIFFERENT haversine
            // estimate, to prove the ORS duration wins for the present leg.
            routeId: "route-MEM-ORD",
            fromHubId: "MEM",
            toHubId: "ORD",
            geometry: [
              [-90.049, 35.1495],
              [-87.6298, 41.8781],
            ],
          },
        },
      ],
    });
    const snapshot = await buildTwinSnapshot(db);
    const leg = snapshot.routes.find((r) => r.routeId === "route-MEM-ORD")!;
    expect(leg.travelMin).toBe(expectedTravelMin);
    expect(Number.isInteger(leg.travelMin)).toBe(true);
  });

  it("capacity is a positive integer", async () => {
    const db = makeDb({ routeEventRows: [ROUTE_A] });
    const snapshot = await buildTwinSnapshot(db);
    const cap = snapshot.routes[0]!.capacity;
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
  });

  it("OPT-09: a longer leg gets a strictly larger expected-transit travelMin", async () => {
    // The geography-derived estimate must order legs by distance: ATL→CHI (a long
    // leg) > CHI→DET (a short regional leg). This is the OPT-09 invariant — the
    // optimizer plans against REAL per-leg durations, not a flat constant.
    const db = makeDb({ routeEventRows: [ROUTE_A, ROUTE_B] });
    const snapshot = await buildTwinSnapshot(db);
    const atlChi = snapshot.routes.find((r) => r.routeId === "route-atl-chi")!;
    const chiDet = snapshot.routes.find((r) => r.routeId === "route-chi-det")!;
    expect(atlChi.travelMin).toBeGreaterThan(chiDet.travelMin);
  });

  it("falls back to TRANSIT_MIN when a route's geometry has fewer than 2 points (fail-soft)", async () => {
    const degenerate = {
      data: { routeId: "route-x", fromHubId: "X1", toHubId: "X2", geometry: [] },
    };
    const db = makeDb({ routeEventRows: [degenerate] });
    const snapshot = await buildTwinSnapshot(db);
    expect(snapshot.routes[0]!.travelMin).toBe(TRANSIT_MIN);
  });

  it("derives centerHubId as the hub on the most route legs (hub-and-spoke center)", async () => {
    // A star: CHI is the center (on both legs), ATL + DET are spokes (one leg each).
    const db = makeDb({ routeEventRows: [ROUTE_A, ROUTE_B] });
    const snapshot = await buildTwinSnapshot(db);
    expect(snapshot.centerHubId).toBe("CHI");
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

// ---------------------------------------------------------------------------
// OPT-HOS-01 — driver-HOS info attached to TwinTrailer from `driver_status`.
//
// The snapshot builder reads the Phase-13 `driver_status` projection (driver →
// `remaining_drive_minutes`, already computed by the Phase-10 HOS engine) and the
// `trailer_state.driver_id` link, and attaches a `driver` summary to each trailer
// whose trip has a bound driver. Deterministic + additive: a trailer with no
// `driver_id` has no `driver` field, so driverless twins reproduce exactly.
// ---------------------------------------------------------------------------
describe("buildTwinSnapshot — OPT-HOS-01 driver-HOS info", () => {
  const DRIVER_RESTED = {
    driver_id: "DRV-rested",
    status: "driving",
    remaining_drive_minutes: 540,
  };

  it("attaches the assigned driver's remaining drive minutes to the trailer", async () => {
    const db = makeDb({
      trailerRows: [{ ...TRAILER_1, driver_id: "DRV-rested" }],
      routeEventRows: [ROUTE_A],
      hubInventoryRows: [HUB_ATL],
      driverStatusRows: [DRIVER_RESTED],
    });
    const snapshot = await buildTwinSnapshot(db);
    const t = snapshot.trailers.find((tr) => tr.trailerId === "T001")!;
    expect(t.driver).toBeDefined();
    expect(t.driver!.driverId).toBe("DRV-rested");
    expect(t.driver!.remainingDriveMinutes).toBe(540);
    // Integer minutes (anti-P12).
    expect(Number.isInteger(t.driver!.remainingDriveMinutes)).toBe(true);
  });

  it("leaves `driver` undefined for a trailer with no bound driver (back-compat)", async () => {
    const db = makeDb({
      trailerRows: [TRAILER_1], // no driver_id
      routeEventRows: [ROUTE_A],
      driverStatusRows: [DRIVER_RESTED],
    });
    const snapshot = await buildTwinSnapshot(db);
    const t = snapshot.trailers.find((tr) => tr.trailerId === "T001")!;
    expect(t.driver).toBeUndefined();
  });

  it("leaves `driver` undefined when the driver_id has no driver_status row (fail-soft)", async () => {
    const db = makeDb({
      trailerRows: [{ ...TRAILER_1, driver_id: "DRV-missing" }],
      routeEventRows: [ROUTE_A],
      driverStatusRows: [DRIVER_RESTED], // does NOT contain DRV-missing
    });
    const snapshot = await buildTwinSnapshot(db);
    const t = snapshot.trailers.find((tr) => tr.trailerId === "T001")!;
    expect(t.driver).toBeUndefined();
  });

  it("is deterministic: identical driver_status rows ⇒ byte-identical snapshot", async () => {
    const make = () =>
      makeDb({
        trailerRows: [{ ...TRAILER_1, driver_id: "DRV-rested" }],
        routeEventRows: [ROUTE_A],
        hubInventoryRows: [HUB_ATL],
        driverStatusRows: [DRIVER_RESTED],
      });
    const a = await buildTwinSnapshot(make());
    const b = await buildTwinSnapshot(make());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
