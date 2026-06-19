import type { ColumnType, Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import type {
  OperationalProjectionName,
  ProjectionDatabase,
} from "../schema.js";
import { OPERATIONAL_PROJECTIONS } from "../schema.js";
import {
  type OccurredEvent,
  emptyPackageLocationState,
  emptyTrailerStateMap,
  hubInventoryReducer,
  type HubInventoryState,
  type PackageLocationState,
  packageLocationReducer,
  type TrailerStateMap,
  trailerStateReducer,
} from "../reducers/index.js";

/**
 * Inline (read-your-writes) projection application + the truncate/replay
 * rebuild's per-event step. BOTH live-apply and rebuild call `applyInline`, so
 * they share ONE code path and cannot drift (the FND-04 invariant).
 *
 * Idempotency (P5a): each operational projection has a `last_seq` checkpoint
 * row. `applyInline` skips any event whose `globalSeq` is at/below the stored
 * `last_seq`, then advances it — so re-applying an already-processed event is a
 * strict no-op (no double-count). The skip is the structural guarantee; the
 * keyed upserts make it doubly safe.
 *
 * Determinism (P3): the projected state is computed by the SAME pure reducers
 * used in the unit tests, reading time only from `occurredAt`. Each projection
 * is folded from its current persisted slice, so the result depends solely on
 * the event and prior derived state — never the wall clock or row order.
 */

/**
 * The minimal event shape the applier needs. `@mm/event-store`'s `StoredEvent`
 * is a structural superset, so a `StoredEvent` is assignable here without any
 * coupling back to that package (keeps the dependency graph acyclic).
 */
export interface ReplayEvent {
  /** Total-order position in the log; gates the idempotent skip. */
  readonly globalSeq: bigint;
  readonly event: DomainEvent;
  /** Domain time (ISO-8601) used by the pure reducers. */
  readonly occurredAt: string;
}

/** The checkpoint table the applier reads/advances (owned by the event store). */
interface CheckpointTable {
  projection: string;
  last_seq: ColumnType<string, string | number, string | number>;
}

/**
 * The database surface `applyInline` needs: the operational projection tables
 * plus the shared `projection_checkpoints`. A caller's `Kysely<Database>`
 * (event-store schema, which already contains `projection_checkpoints`) plus
 * these tables satisfies it structurally.
 */
export interface ProjectionDb extends ProjectionDatabase {
  projection_checkpoints: CheckpointTable;
}

/** Read the per-projection last-applied global_seq (0 if never run). */
async function readCheckpoint(
  db: Kysely<ProjectionDb>,
  projection: OperationalProjectionName,
): Promise<bigint> {
  const row = await db
    .selectFrom("projection_checkpoints")
    .select("last_seq")
    .where("projection", "=", projection)
    .executeTakeFirst();
  return row === undefined ? 0n : BigInt(row.last_seq);
}

/** Advance (upsert) the per-projection checkpoint to `seq`. */
async function advanceCheckpoint(
  db: Kysely<ProjectionDb>,
  projection: OperationalProjectionName,
  seq: bigint,
): Promise<void> {
  await db
    .insertInto("projection_checkpoints")
    .values({ projection, last_seq: seq.toString() })
    .onConflict((oc) =>
      oc.column("projection").doUpdateSet({ last_seq: seq.toString() }),
    )
    .execute();
}

function toOccurred(replay: ReplayEvent): OccurredEvent {
  return { event: replay.event, occurredAt: replay.occurredAt };
}

// --- Per-projection load → fold → persist -----------------------------------

async function applyPackageLocation(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const rows = await db.selectFrom("package_location").selectAll().execute();
  const state: PackageLocationState = new Map(
    rows.map((r) => [
      r.package_id,
      {
        packageId: r.package_id,
        hubId: r.hub_id,
        confidence: r.confidence,
        lastSeenAt: toIso(r.last_seen_at),
      },
    ]),
  );
  const next = packageLocationReducer(state, toOccurred(replay));
  for (const loc of next.values()) {
    await db
      .insertInto("package_location")
      .values({
        package_id: loc.packageId,
        hub_id: loc.hubId,
        confidence: loc.confidence,
        last_seen_at: loc.lastSeenAt,
      })
      .onConflict((oc) =>
        oc.column("package_id").doUpdateSet({
          hub_id: loc.hubId,
          confidence: loc.confidence,
          last_seen_at: loc.lastSeenAt,
        }),
      )
      .execute();
  }
}

async function applyTrailerState(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const rows = await db.selectFrom("trailer_state").selectAll().execute();
  const state: TrailerStateMap = new Map(
    rows.map((r) => [
      r.trailer_id,
      {
        trailerId: r.trailer_id,
        status: asStatus(r.status),
        currentHubId: r.current_hub_id,
        tripId: r.trip_id,
        dockDoorId: r.dock_door_id,
        assignedPackageIds: r.assigned_package_ids,
        lastEventAt: toIso(r.last_event_at),
      },
    ]),
  );
  const next = trailerStateReducer(state, toOccurred(replay));
  for (const t of next.values()) {
    await db
      .insertInto("trailer_state")
      .values({
        trailer_id: t.trailerId,
        status: t.status,
        current_hub_id: t.currentHubId,
        trip_id: t.tripId,
        dock_door_id: t.dockDoorId,
        assigned_package_ids: JSON.stringify(t.assignedPackageIds),
        last_event_at: t.lastEventAt,
      })
      .onConflict((oc) =>
        oc.column("trailer_id").doUpdateSet({
          status: t.status,
          current_hub_id: t.currentHubId,
          trip_id: t.tripId,
          dock_door_id: t.dockDoorId,
          assigned_package_ids: JSON.stringify(t.assignedPackageIds),
          last_event_at: t.lastEventAt,
        }),
      )
      .execute();
  }
}

async function applyHubInventory(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const rows = await db.selectFrom("hub_inventory").selectAll().execute();
  // Reconstruct both the queryable hub state AND the internal placement index
  // (a package's placement is wherever it currently appears in a bucket).
  const hubs = new Map(
    rows.map((r) => [
      r.hub_id,
      { hubId: r.hub_id, inbound: r.inbound, outbound: r.outbound, staged: r.staged },
    ]),
  );
  const placement = new Map<string, { hubId: string; bucket: "inbound" | "outbound" | "staged" }>();
  for (const r of rows) {
    for (const id of r.inbound) placement.set(id, { hubId: r.hub_id, bucket: "inbound" });
    for (const id of r.outbound) placement.set(id, { hubId: r.hub_id, bucket: "outbound" });
    for (const id of r.staged) placement.set(id, { hubId: r.hub_id, bucket: "staged" });
  }
  const state: HubInventoryState = { hubs, placement };
  const next = hubInventoryReducer(state, toOccurred(replay));
  for (const hub of next.hubs.values()) {
    await db
      .insertInto("hub_inventory")
      .values({
        hub_id: hub.hubId,
        inbound: JSON.stringify(hub.inbound),
        outbound: JSON.stringify(hub.outbound),
        staged: JSON.stringify(hub.staged),
      })
      .onConflict((oc) =>
        oc.column("hub_id").doUpdateSet({
          inbound: JSON.stringify(hub.inbound),
          outbound: JSON.stringify(hub.outbound),
          staged: JSON.stringify(hub.staged),
        }),
      )
      .execute();
  }
}

type Applier = (db: Kysely<ProjectionDb>, replay: ReplayEvent) => Promise<void>;

/** Each operational projection: its checkpoint name + its load/fold/persist step. */
const APPLIERS: ReadonlyArray<{ name: OperationalProjectionName; apply: Applier }> = [
  { name: "package-location", apply: applyPackageLocation },
  { name: "trailer-state", apply: applyTrailerState },
  { name: "hub-inventory", apply: applyHubInventory },
];

/**
 * Apply one stored event to ALL operational projections, idempotently.
 *
 * For each projection: if the event's `globalSeq` is at/below the projection's
 * `last_seq`, it is SKIPPED (already processed — no-op, P5a). Otherwise the
 * projection's pure reducer is folded over its current persisted slice and the
 * result is upserted, then `last_seq` is advanced to `globalSeq`.
 *
 * Pass a transaction to get read-your-writes consistency with an append; pass a
 * plain `Kysely` for standalone replay/rebuild — the logic is identical.
 *
 * The handle is typed at exactly the projection sub-schema (`ProjectionDb`).
 * A caller holding the wider event-store schema views it through
 * `projectionView` (see exports) so this stays a clean, minimal contract.
 */
export async function applyInline(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  for (const { name, apply } of APPLIERS) {
    const lastSeq = await readCheckpoint(db, name);
    if (replay.globalSeq <= lastSeq) continue; // idempotent skip
    await apply(db, replay);
    await advanceCheckpoint(db, name, replay.globalSeq);
  }
}

/**
 * View a wider schema (one that CONTAINS the projection tables +
 * `projection_checkpoints`) as a `Kysely<ProjectionDb>`. `Kysely<T>` is
 * invariant in `T`, so this structural narrowing is the conventional way to
 * operate on a sub-schema; it is sound because the runtime instance genuinely
 * contains these tables. Used by the API composition root and by tests where
 * one connection drives both the event store and the projections.
 */
export function projectionView<DB extends ProjectionDb>(
  db: Kysely<DB>,
): Kysely<ProjectionDb> {
  return db as unknown as Kysely<ProjectionDb>;
}

// --- Read side: assemble the operational twin from the projection tables -----

/** The assembled operational-twin snapshot read back from the projections. */
export interface OperationalTwin {
  readonly packageLocation: PackageLocationState;
  readonly trailerState: TrailerStateMap;
  readonly hubInventory: ReadonlyMap<
    string,
    { hubId: string; inbound: readonly string[]; outbound: readonly string[]; staged: readonly string[] }
  >;
}

/** Read the full operational twin from the persisted projection tables. */
export async function readOperationalTwin(
  db: Kysely<ProjectionDb>,
): Promise<OperationalTwin> {
  const [pkgRows, trailerRows, hubRows] = await Promise.all([
    db.selectFrom("package_location").selectAll().execute(),
    db.selectFrom("trailer_state").selectAll().execute(),
    db.selectFrom("hub_inventory").selectAll().execute(),
  ]);

  const packageLocation: PackageLocationState = pkgRows.length
    ? new Map(
        pkgRows.map((r) => [
          r.package_id,
          {
            packageId: r.package_id,
            hubId: r.hub_id,
            confidence: r.confidence,
            lastSeenAt: toIso(r.last_seen_at),
          },
        ]),
      )
    : emptyPackageLocationState;

  const trailerState: TrailerStateMap = trailerRows.length
    ? new Map(
        trailerRows.map((r) => [
          r.trailer_id,
          {
            trailerId: r.trailer_id,
            status: asStatus(r.status),
            currentHubId: r.current_hub_id,
            tripId: r.trip_id,
            dockDoorId: r.dock_door_id,
            assignedPackageIds: r.assigned_package_ids,
            lastEventAt: toIso(r.last_event_at),
          },
        ]),
      )
    : emptyTrailerStateMap;

  const hubInventory = new Map(
    hubRows.map((r) => [
      r.hub_id,
      { hubId: r.hub_id, inbound: r.inbound, outbound: r.outbound, staged: r.staged },
    ]),
  );

  return { packageLocation, trailerState, hubInventory };
}

/** All operational projection names — re-exported for rebuild's checkpoint reset. */
export const operationalProjectionNames = OPERATIONAL_PROJECTIONS;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

const STATUSES = new Set(["in_transit", "arrived", "docked"]);
function asStatus(value: string): "in_transit" | "arrived" | "docked" {
  if (STATUSES.has(value)) return value as "in_transit" | "arrived" | "docked";
  throw new Error(`Unknown trailer status in projection row: ${value}`);
}
