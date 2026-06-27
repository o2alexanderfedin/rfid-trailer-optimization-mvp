import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import {
  applyTrailerFuel,
  type ProjectionDb,
  type ReplayEvent,
} from "../src/runner/inline.js";
import { trailerFuelReducer, emptyTrailerFuelState } from "../src/reducers/trailer-fuel.js";
import type { TrailerFuelState } from "../src/reducers/trailer-fuel.js";
import { legKey } from "../src/reducers/geo-track.js";

/**
 * PERF-02 — trailer-fuel applier: cost-invariance + rebuild-equivalence.
 *
 * Uses a counting in-memory fake Kysely (analogous to hub-inventory-cost.unit.test.ts)
 * to prove:
 *   (a) COST-INVARIANCE: per-event `trailer_fuel` row reads are independent of
 *       state size — a 10-trailer state and a 100-trailer state read the same
 *       bounded count per event.
 *   (b) REBUILD-EQUIVALENCE: the incremental applier's final persisted rows are
 *       byte-identical (via canonicalRows) to a full trailerFuelReducer fold
 *       from global_seq=0.
 *
 * No Postgres required — the fake models exactly the builder chains the applier
 * uses against `trailer_fuel`, `geo_route`, and `geo_inflight_trip`.
 */

const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

// --------------------------------------------------------------------------
// Event builders
// --------------------------------------------------------------------------

function routeRegistered(fromHubId: string, toHubId: string, geom: [number, number][]): DomainEvent {
  return {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: { routeId: `${fromHubId}-${toHubId}`, fromHubId, toHubId, geometry: geom },
  };
}

function trailerDeparted(trailerId: string, tripId: string, fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, tripId, fromHubId, toHubId, packageIds: [] },
  };
}

function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return {
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId, hubId, tripId },
  };
}

function replay(event: DomainEvent, globalSeq: bigint, offsetMs: number): ReplayEvent {
  return { globalSeq, event, occurredAt: at(offsetMs) };
}

// --------------------------------------------------------------------------
// Fake geometry (two hubs far enough apart to have nonzero miles)
// --------------------------------------------------------------------------

// Memphis → Dallas: ~400 miles great-circle
const MEM: [number, number] = [-90.0, 35.15];
const DFW: [number, number] = [-97.0, 32.9];
const HOU: [number, number] = [-95.37, 29.75];
const geomMEM_DFW: [number, number][] = [MEM, DFW];
const geomDFW_HOU: [number, number][] = [DFW, HOU];

// --------------------------------------------------------------------------
// Fake Kysely for trailer_fuel / geo_route / geo_inflight_trip
// --------------------------------------------------------------------------

interface FuelRow { trailer_id: string; miles_since_refuel: number }
interface GeoRouteRow { from_hub_id: string; to_hub_id: string; geometry: [number, number][] }
interface GeoInflightRow { trip_id: string; from_hub_id: string; to_hub_id: string; depart_at: string | null }

interface FakeDb {
  db: Kysely<ProjectionDb>;
  fuelRows: () => FuelRow[];
  geoRouteRows: () => GeoRouteRow[];
  inflightRows: () => GeoInflightRow[];
  /** Total trailer_fuel ROWS returned by reads since last reset. */
  fuelReadsCount: () => number;
  resetFuelReadsCounter: () => void;
}

function makeFakeDb(options: {
  initialFuelRows?: FuelRow[];
  initialGeoRouteRows?: GeoRouteRow[];
  initialInflightRows?: GeoInflightRow[];
}): FakeDb {
  const fuelTable = new Map<string, FuelRow>(
    (options.initialFuelRows ?? []).map((r) => [r.trailer_id, { ...r }]),
  );
  const geoRouteTable = new Map<string, GeoRouteRow>(
    (options.initialGeoRouteRows ?? []).map((r) => [
      legKey(r.from_hub_id, r.to_hub_id),
      { ...r, geometry: [...r.geometry] as [number, number][] },
    ]),
  );
  const inflightTable = new Map<string, GeoInflightRow>(
    (options.initialInflightRows ?? []).map((r) => [r.trip_id, { ...r }]),
  );
  let fuelReadCounter = 0;

  // Minimal select builder
  function makeSelect(tableName: string): unknown {
    let whereId: string | null = null;
    const builder: Record<string, unknown> = {
      selectAll() { return builder; },
      where(_col: string, _op: string, val: unknown) {
        if (typeof val === "string") whereId = val;
        return builder;
      },
      execute(): Promise<unknown[]> {
        if (tableName === "trailer_fuel") {
          let rows: FuelRow[];
          if (whereId !== null) {
            const row = fuelTable.get(whereId);
            rows = row !== undefined ? [{ ...row }] : [];
          } else {
            rows = [...fuelTable.values()].map((r) => ({ ...r }));
          }
          fuelReadCounter += rows.length;
          return Promise.resolve(rows);
        }
        if (tableName === "geo_route") {
          return Promise.resolve([...geoRouteTable.values()].map((r) => ({ ...r })));
        }
        if (tableName === "geo_inflight_trip") {
          return Promise.resolve([...inflightTable.values()].map((r) => ({ ...r })));
        }
        return Promise.resolve([]);
      },
    };
    return builder;
  }

  // Minimal insert builder (upsert into trailer_fuel)
  function makeInsert(tableName: string): unknown {
    let pending: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      values(v: Record<string, unknown>) { pending = v; return builder; },
      onConflict() { return builder; },
      execute(): Promise<void> {
        if (tableName === "trailer_fuel" && pending !== null) {
          fuelTable.set(pending["trailer_id"] as string, {
            trailer_id: pending["trailer_id"] as string,
            miles_since_refuel: pending["miles_since_refuel"] as number,
          });
        }
        if (tableName === "geo_inflight_trip" && pending !== null) {
          inflightTable.set(pending["trip_id"] as string, {
            trip_id: pending["trip_id"] as string,
            from_hub_id: pending["from_hub_id"] as string,
            to_hub_id: pending["to_hub_id"] as string,
            depart_at: (pending["depart_at"] ?? null) as string | null,
          });
        }
        return Promise.resolve();
      },
    };
    return builder;
  }

  // Minimal delete builder
  function makeDelete(tableName: string): unknown {
    let whereId: string | null = null;
    return {
      where(_col: string, _op: string, val: unknown) {
        if (typeof val === "string") whereId = val;
        return { execute(): Promise<void> {
          if (tableName === "trailer_fuel" && whereId !== null) fuelTable.delete(whereId);
          if (tableName === "geo_inflight_trip" && whereId !== null) inflightTable.delete(whereId);
          return Promise.resolve();
        }};
      },
    };
  }

  const db = {
    selectFrom: (t: string) => makeSelect(t),
    insertInto: (t: string) => makeInsert(t),
    deleteFrom: (t: string) => makeDelete(t),
  } as unknown as Kysely<ProjectionDb>;

  return {
    db,
    fuelRows: () => [...fuelTable.values()].map((r) => ({ ...r })),
    geoRouteRows: () => [...geoRouteTable.values()].map((r) => ({ ...r })),
    inflightRows: () => [...inflightTable.values()].map((r) => ({ ...r })),
    fuelReadsCount: () => fuelReadCounter,
    resetFuelReadsCounter: () => { fuelReadCounter = 0; },
  };
}

/** Serialize fuel rows canonically for byte-identical comparison. */
function canonicalFuelRows(rows: readonly FuelRow[]): string {
  return JSON.stringify(
    [...rows]
      .map((r) => ({ trailer_id: r.trailer_id, miles_since_refuel: r.miles_since_refuel }))
      .sort((a, b) => (a.trailer_id < b.trailer_id ? -1 : a.trailer_id > b.trailer_id ? 1 : 0)),
  );
}

/** Full pure-reducer fold of a sequence of events from emptyState. */
function fullFold(
  events: readonly ReplayEvent[],
  initialGeoRouteRows: readonly GeoRouteRow[],
): FuelRow[] {
  // Seed routes + inflight from what would be persisted before these events
  let state: TrailerFuelState = {
    ...emptyTrailerFuelState,
    routes: new Map(
      initialGeoRouteRows.map((r) => [legKey(r.from_hub_id, r.to_hub_id), r.geometry]),
    ),
    inflight: new Map(),
  };
  for (const ev of events) {
    state = trailerFuelReducer(state, { event: ev.event, occurredAt: ev.occurredAt });
  }
  return [...state.fuel.values()].map((f) => ({
    trailer_id: f.trailerId,
    miles_since_refuel: f.milesSinceRefuel,
  }));
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("applyTrailerFuel (PERF-02)", () => {
  it("cost-invariance: rows-read at 10 trailers === rows-read at 100 trailers", async () => {
    // Seed 10 / 100 trailers already having fuel state, plus geo routes
    const geoRoutes: GeoRouteRow[] = [
      { from_hub_id: "MEM", to_hub_id: "DFW", geometry: geomMEM_DFW },
    ];
    const makeFuelRows = (n: number): FuelRow[] =>
      Array.from({ length: n }, (_, i) => ({ trailer_id: `TRL-${i}`, miles_since_refuel: i * 10 }));

    const fx10 = makeFakeDb({ initialFuelRows: makeFuelRows(10), initialGeoRouteRows: geoRoutes });
    const fx100 = makeFakeDb({ initialFuelRows: makeFuelRows(100), initialGeoRouteRows: geoRoutes });

    // A TrailerDeparted for a NEW trailer (not in either state yet)
    const ev = replay(trailerDeparted("TRL-NEW", "TRIP-NEW", "MEM", "DFW"), 1n, 0);
    fx10.resetFuelReadsCounter();
    fx100.resetFuelReadsCounter();
    await applyTrailerFuel(fx10.db, ev);
    await applyTrailerFuel(fx100.db, ev);

    // Key-scoped: reads ONLY the affected key (1 row or 0 rows — same count regardless of table size)
    expect(fx10.fuelReadsCount()).toBe(fx100.fuelReadsCount());
    // And both are a small bounded constant, NOT 10 or 100
    expect(fx10.fuelReadsCount()).toBeLessThanOrEqual(2); // at most 1 fuel row + inflight lookup overhead
  });

  it("rebuild-equivalence: incremental fold === pure-reducer fold, byte-identical", async () => {
    const geoRoutes: GeoRouteRow[] = [
      { from_hub_id: "MEM", to_hub_id: "DFW", geometry: geomMEM_DFW },
      { from_hub_id: "DFW", to_hub_id: "HOU", geometry: geomDFW_HOU },
    ];

    // A deterministic event sequence: register routes, depart, arrive, depart again
    const events: ReplayEvent[] = [
      replay(routeRegistered("MEM", "DFW", geomMEM_DFW), 1n, 0),
      replay(routeRegistered("DFW", "HOU", geomDFW_HOU), 2n, 1),
      replay(trailerDeparted("TRL-A", "TRIP-1", "MEM", "DFW"), 3n, 2),
      replay(trailerArrived("TRL-A", "DFW", "TRIP-1"), 4n, 3),
      replay(trailerDeparted("TRL-A", "TRIP-2", "DFW", "HOU"), 5n, 4),
      replay(trailerArrived("TRL-A", "HOU", "TRIP-2"), 6n, 5),
    ];

    const fx = makeFakeDb({ initialGeoRouteRows: geoRoutes });

    // Drive through the applier (simulates what applyInline does)
    for (const ev of events) {
      await applyTrailerFuel(fx.db, ev);
    }

    // Full pure-reducer fold from zero (seeding routes from persisted geo_route rows)
    const expectedRows = fullFold(events, geoRoutes);

    // Byte-identical comparison after sorting by PK
    expect(canonicalFuelRows(fx.fuelRows())).toBe(canonicalFuelRows(expectedRows));
    // Also verify non-trivial (miles > 0 for TRL-A)
    const trla = fx.fuelRows().find((r) => r.trailer_id === "TRL-A");
    expect(trla).toBeDefined();
    expect(trla!.miles_since_refuel).toBeGreaterThan(0);
  });
});
