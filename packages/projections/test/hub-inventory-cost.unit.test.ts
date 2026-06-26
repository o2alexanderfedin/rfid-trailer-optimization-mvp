import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import {
  applyHubInventory,
  type ProjectionDb,
  type ReplayEvent,
} from "../src/runner/inline.js";
import {
  emptyHubInventoryState,
  hubInventoryReducer,
  type HubInventoryState,
} from "../src/reducers/hub-inventory.js";

/**
 * PERF-01 (P1-BLOCKING) — per-event `applyHubInventory` cost is INDEPENDENT of
 * hub count.
 *
 * ROOT CAUSE (the v2.1 freeze re-arming at 100 hubs): the old `applyHubInventory`
 * loaded the ENTIRE `hub_inventory` table (`selectAll()`) per event, rebuilt the
 * whole placement index, then re-upserted every row. At 10 hubs that is cheap; at
 * 100+ hubs it is O(events × hubs) again — the exact shape of the v2.1 "time
 * appears stopped" decay, with a constant that grows with this milestone's
 * headline feature (the continental hub jump).
 *
 * THE WITNESS (this suite): a COUNTING fake Kysely records how many
 * `hub_inventory` ROWS each `applyHubInventory` call READS. We fold the SAME
 * event against a 10-hub inventory and a 100-hub inventory that each hold the
 * same target package P at one known hub, and assert the per-event row-read count
 * is EQUAL (a small bounded constant), not 10 vs 100. The broken full-scan applier
 * reads `hubCount` rows per event, so 10 !== 100 — proving the test measures the
 * right thing; the key-scoped fix reads only the touched hub id(s).
 *
 * REBUILD-EQUIVALENCE (T-23-04): the same fake also proves the key-scoped fold is
 * byte-identical to a full-table fold (build-from-0) for a fixed event sequence,
 * at BOTH 10 and 100 hubs — so the perf win cannot mask a correctness regression.
 *
 * No Postgres: `@mm/projections` depends ONLY on `@mm/domain` + `kysely` (acyclic
 * DAG, see index.ts). The fake models the precise builder chains the applier
 * invokes against `hub_inventory`, which is all that is needed to count reads and
 * verify the fold.
 */

const T0 = Date.parse("2026-08-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

type Bucket = "inbound" | "outbound" | "staged";
interface HubRow {
  hub_id: string;
  inbound: string[];
  outbound: string[];
  staged: string[];
}

/**
 * A counting, in-memory fake of the narrow `Kysely<ProjectionDb>` surface
 * `applyHubInventory` uses against `hub_inventory`. It backs the table with a
 * `Map<hubId, HubRow>` and instruments every read so the test can assert how many
 * rows the applier touched per event. The supported builder chains are EXACTLY:
 *
 *   selectFrom("hub_inventory").selectAll().execute()                       (full scan)
 *   selectFrom("hub_inventory").selectAll().where("hub_id","in",ids).execute()
 *   selectFrom("hub_inventory").selectAll().whereJsonbContainsAny(col,ids).execute()
 *   insertInto("hub_inventory").values(v).onConflict(...).execute()
 *   deleteFrom("hub_inventory").where("hub_id","in"|"=",...).execute()
 *
 * `whereJsonbContainsAny` is the package→hub placement read mechanism: in
 * production it is a Kysely raw-`sql` JSONB-array-containment predicate; here the
 * fake evaluates the same membership semantics in memory. Any OTHER table the
 * applier might touch is irrelevant to hub-inventory cost and is not modeled.
 */
interface FakeDb {
  db: Kysely<ProjectionDb>;
  /** Total `hub_inventory` ROWS returned by reads since the last reset. */
  rowsRead: () => number;
  resetCounter: () => void;
  rows: () => HubRow[];
}

function makeFakeDb(initial: readonly HubRow[]): FakeDb {
  const table = new Map<string, HubRow>(
    initial.map((r) => [
      r.hub_id,
      { hub_id: r.hub_id, inbound: [...r.inbound], outbound: [...r.outbound], staged: [...r.staged] },
    ]),
  );
  let counter = 0;

  function rowsContainingAny(column: Bucket, ids: readonly string[]): HubRow[] {
    const want = new Set(ids);
    const out: HubRow[] = [];
    for (const r of table.values()) {
      if (r[column].some((id) => want.has(id))) out.push(r);
    }
    return out;
  }

  // --- select builder (only the `hub_inventory` chains the applier uses) ------
  function makeSelect(): unknown {
    let scope:
      | { kind: "all" }
      | { kind: "hubIn"; ids: string[] }
      | { kind: "contains"; column: Bucket; ids: string[] } = { kind: "all" };

    const builder = {
      selectAll() {
        return builder;
      },
      where(col: string, op: string, val: unknown) {
        if (col === "hub_id" && op === "in" && Array.isArray(val)) {
          scope = { kind: "hubIn", ids: val as string[] };
        } else if (col === "hub_id" && op === "=" && typeof val === "string") {
          scope = { kind: "hubIn", ids: [val] };
        } else {
          throw new Error(`fake select: unsupported where(${col}, ${op})`);
        }
        return builder;
      },
      // The package→hub placement read: rows whose `column` array contains ANY id.
      whereJsonbContainsAny(column: Bucket, ids: readonly string[]) {
        scope = { kind: "contains", column, ids: [...ids] };
        return builder;
      },
      async execute(): Promise<HubRow[]> {
        let result: HubRow[];
        if (scope.kind === "all") {
          result = [...table.values()];
        } else if (scope.kind === "hubIn") {
          const want = new Set(scope.ids);
          result = [...table.values()].filter((r) => want.has(r.hub_id));
        } else {
          result = rowsContainingAny(scope.column, scope.ids);
        }
        counter += result.length;
        // Deep-copy so the applier cannot mutate the backing store via the rows.
        return result.map((r) => ({
          hub_id: r.hub_id,
          inbound: [...r.inbound],
          outbound: [...r.outbound],
          staged: [...r.staged],
        }));
      },
    };
    return builder;
  }

  // --- insert builder (upsert into hub_inventory) -----------------------------
  function makeInsert(): unknown {
    let pending:
      | { hub_id: string; inbound: string[]; outbound: string[]; staged: string[] }
      | null = null;
    const builder = {
      values(v: { hub_id: string; inbound: string; outbound: string; staged: string }) {
        pending = {
          hub_id: v.hub_id,
          inbound: JSON.parse(v.inbound) as string[],
          outbound: JSON.parse(v.outbound) as string[],
          staged: JSON.parse(v.staged) as string[],
        };
        return builder;
      },
      onConflict() {
        return builder;
      },
      async execute(): Promise<void> {
        if (pending !== null) table.set(pending.hub_id, pending);
      },
    };
    return builder;
  }

  // --- delete builder (remove emptied hub rows) -------------------------------
  function makeDelete(): unknown {
    let toDelete: string[] = [];
    const builder = {
      where(col: string, op: string, val: unknown) {
        if (col !== "hub_id") throw new Error(`fake delete: unsupported where(${col})`);
        if (op === "in" && Array.isArray(val)) toDelete = val as string[];
        else if (op === "=" && typeof val === "string") toDelete = [val];
        else throw new Error(`fake delete: unsupported op ${op}`);
        return builder;
      },
      async execute(): Promise<void> {
        for (const id of toDelete) table.delete(id);
      },
    };
    return builder;
  }

  const db = {
    selectFrom(t: string) {
      if (t !== "hub_inventory") throw new Error(`fake: unexpected selectFrom(${t})`);
      return makeSelect();
    },
    insertInto(t: string) {
      if (t !== "hub_inventory") throw new Error(`fake: unexpected insertInto(${t})`);
      return makeInsert();
    },
    deleteFrom(t: string) {
      if (t !== "hub_inventory") throw new Error(`fake: unexpected deleteFrom(${t})`);
      return makeDelete();
    },
  } as unknown as Kysely<ProjectionDb>;

  return {
    db,
    rowsRead: () => counter,
    resetCounter: () => {
      counter = 0;
    },
    rows: () =>
      [...table.values()]
        .map((r) => ({
          hub_id: r.hub_id,
          inbound: [...r.inbound],
          outbound: [...r.outbound],
          staged: [...r.staged],
        }))
        .sort((a, b) => (a.hub_id < b.hub_id ? -1 : a.hub_id > b.hub_id ? 1 : 0)),
  };
}

/** A deterministic N-hub inventory: hubs HUB-000..HUB-(N-1), package P inbound at `pHub`. */
function seedInventory(n: number, pHub: string, p: string): HubRow[] {
  return Array.from({ length: n }, (_, i) => {
    const hubId = `HUB-${String(i).padStart(3, "0")}`;
    return {
      hub_id: hubId,
      inbound: hubId === pHub ? [p] : [],
      outbound: [],
      staged: [],
    };
  });
}

function replay(event: DomainEvent, globalSeq: bigint, offsetMs: number): ReplayEvent {
  return { globalSeq, event, occurredAt: at(offsetMs) };
}

function arrived(packageId: string, hubId: string): DomainEvent {
  return { type: "PackageArrivedAtHub", schemaVersion: 1, payload: { packageId, hubId } };
}

function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
  packageIds: readonly string[],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: {
      trailerId,
      tripId: `TRIP-${trailerId}`,
      fromHubId,
      toHubId,
      packageIds: [...packageIds],
    },
  };
}

/** Fold a row-set into the pure HubInventoryState (the build-from-rows shape). */
function stateFromRows(rows: readonly HubRow[]): HubInventoryState {
  const hubs = new Map(
    rows.map((r) => [
      r.hub_id,
      { hubId: r.hub_id, inbound: [...r.inbound], outbound: [...r.outbound], staged: [...r.staged] },
    ]),
  );
  const placement = new Map<string, { hubId: string; bucket: Bucket }>();
  for (const r of rows) {
    for (const id of r.inbound) placement.set(id, { hubId: r.hub_id, bucket: "inbound" });
    for (const id of r.outbound) placement.set(id, { hubId: r.hub_id, bucket: "outbound" });
    for (const id of r.staged) placement.set(id, { hubId: r.hub_id, bucket: "staged" });
  }
  return { hubs, placement };
}

/** Serialize hub rows to a byte-stable string for equivalence comparison. */
function canonicalRows(rows: readonly HubRow[]): string {
  return JSON.stringify(
    [...rows]
      .map((r) => ({
        hub_id: r.hub_id,
        inbound: [...r.inbound].sort(),
        outbound: [...r.outbound].sort(),
        staged: [...r.staged].sort(),
      }))
      .sort((a, b) => (a.hub_id < b.hub_id ? -1 : a.hub_id > b.hub_id ? 1 : 0)),
  );
}

describe("applyHubInventory per-event row reads are independent of hub count (PERF-01)", () => {
  it("PackageArrivedAtHub: rows-read at 10 hubs === rows-read at 100 hubs", async () => {
    const P = "PKG-P";
    const fx10 = makeFakeDb(seedInventory(10, "HUB-005", P));
    const fx100 = makeFakeDb(seedInventory(100, "HUB-005", P));

    fx10.resetCounter();
    fx100.resetCounter();
    const ev = replay(arrived("PKG-Q", "HUB-007"), 1n, 1);
    await applyHubInventory(fx10.db, ev);
    await applyHubInventory(fx100.db, ev);

    // A full-scan applier reads 10 vs 100 here; the key-scoped fix reads the same
    // bounded constant regardless of hub count.
    expect(fx10.rowsRead()).toBe(fx100.rowsRead());
  });

  it("TrailerDeparted removing P: rows-read at 10 hubs === rows-read at 100 hubs", async () => {
    const P = "PKG-P";
    const fx10 = makeFakeDb(seedInventory(10, "HUB-005", P));
    const fx100 = makeFakeDb(seedInventory(100, "HUB-005", P));

    fx10.resetCounter();
    fx100.resetCounter();
    const ev = replay(departed("TRL-1", "HUB-005", "HUB-009", [P]), 1n, 1);
    await applyHubInventory(fx10.db, ev);
    await applyHubInventory(fx100.db, ev);

    expect(fx10.rowsRead()).toBe(fx100.rowsRead());
  });

  it("rebuild-equivalence: incremental fold === build-from-0 fold at 10 AND 100 hubs (T-23-04)", async () => {
    const P = "PKG-P";
    for (const n of [10, 100]) {
      const fx = makeFakeDb(seedInventory(n, "HUB-005", P));

      // A fixed event sequence: induct two more packages, then depart one trailer
      // carrying P + one of the new packages.
      const events: ReplayEvent[] = [
        replay(arrived("PKG-A", "HUB-002"), 1n, 1),
        replay(arrived("PKG-B", "HUB-002"), 2n, 2),
        replay(departed("TRL-9", "HUB-002", "HUB-008", ["PKG-A", P]), 3n, 3),
      ];
      for (const ev of events) await applyHubInventory(fx.db, ev);

      // Build-from-0: fold the SAME events over the seeded starting rows with the
      // pure reducer directly (the canonical full-table fold).
      let state: HubInventoryState = stateFromRows(seedInventory(n, "HUB-005", P));
      void emptyHubInventoryState; // (the reducer is associative from any prior state)
      for (const ev of events) {
        state = hubInventoryReducer(state, { event: ev.event, occurredAt: ev.occurredAt });
      }
      const expectedRows: HubRow[] = [...state.hubs.values()].map((h) => ({
        hub_id: h.hubId,
        inbound: [...h.inbound],
        outbound: [...h.outbound],
        staged: [...h.staged],
      }));

      // The incremental (key-scoped) persisted rows must match the full fold
      // for every NON-EMPTY hub. (An emptied hub may be DELETEd incrementally; the
      // pure reducer keeps it as an empty row — compare on non-empty content.)
      const nonEmpty = (rows: readonly HubRow[]): HubRow[] =>
        rows.filter((r) => r.inbound.length + r.outbound.length + r.staged.length > 0);

      expect(canonicalRows(nonEmpty(fx.rows()))).toBe(canonicalRows(nonEmpty(expectedRows)));
    }
  });
});
