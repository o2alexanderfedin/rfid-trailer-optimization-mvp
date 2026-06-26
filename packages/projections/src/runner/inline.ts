import type { ColumnType, Kysely } from "kysely";
import type { DomainEvent, DutyStatus } from "@mm/domain";
import type {
  OperationalProjectionName,
  ProjectionDatabase,
} from "../schema.js";
import { OPERATIONAL_PROJECTIONS } from "../schema.js";
import { DEFAULT_FUSION_CONFIG } from "@mm/sensor-fusion";
import {
  type DriverAssignmentState,
  driverAssignmentReducer,
  emptyDriverAssignmentState,
  type DriverStatusState,
  driverStatusReducer,
  emptyDriverStatusState,
  type ExceptionKind,
  type ExceptionsState,
  exceptionId as exceptionIdKey,
  exceptionsReducer,
  emptyPackageLocationState,
  emptyTrailerStateMap,
  hubInventoryReducer,
  type HubInventoryState,
  makeZoneEstimateReducer,
  type OccurredEvent,
  type OpenException,
  type PackageLocationState,
  packageLocationReducer,
  type TagRegistryState,
  tagRegistryReducer,
  type TrailerStateMap,
  trailerStateReducer,
  type ZoneEstimateState,
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

// --- Key-scoped fold (the BOUNDED per-event cost, P-perf) --------------------
//
// Every operational reducer is a PURE `(state, event) => state` that mutates ONLY
// the row(s) keyed by ids in THIS event's payload — never the whole map. The
// previous appliers loaded the ENTIRE projection table, folded, and re-WROTE
// every row per event, so per-event cost was O(total state) and the run was
// O(events²) (the live-demo "time appears stopped" decay). These appliers instead
// load ONLY the affected key(s) into a PARTIAL state map, fold with the SAME pure
// reducer (identical mutation, since the reducer touches no other key), then
// persist ONLY the rows that changed/appeared and DELETE the rows the fold
// removed. Cost is O(affected keys per event) — bounded, independent of run
// length. The fold is byte-identical to a full-table fold (and to a
// rebuild-from-0), so determinism / rebuild-equivalence (FND-04, P5a) is
// preserved; the projections-golden-replay + idempotency tests are the witness.

/** Extract the package id this event mutates in `package_location`, or null. */
function affectedPackageLocationId(event: DomainEvent): string | null {
  switch (event.type) {
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "PackageDelivered":
      return event.payload.packageId;
    case "PackageInducted":
      return event.payload.packageId;
    default:
      return null;
  }
}

async function applyPackageLocation(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const id = affectedPackageLocationId(replay.event);
  if (id === null) return; // no-op event ⇒ no read, no write
  const rows = await db
    .selectFrom("package_location")
    .selectAll()
    .where("package_id", "=", id)
    .execute();
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
  // The reducer mutates only `id`: either it now has a row (upsert) or it was
  // deleted (PackageDelivered ⇒ absent in `next`). Persist exactly that delta.
  const loc = next.get(id);
  if (loc === undefined) {
    await db.deleteFrom("package_location").where("package_id", "=", id).execute();
    return;
  }
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

/** Extract the trailer id this event mutates in `trailer_state`, or null. */
function affectedTrailerStateId(event: DomainEvent): string | null {
  switch (event.type) {
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "DriverAssignedToTrip":
    case "DriverSwappedAtHub":
      return event.payload.trailerId;
    default:
      return null;
  }
}

async function applyTrailerState(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const id = affectedTrailerStateId(replay.event);
  if (id === null) return; // no-op event ⇒ no read, no write
  const rows = await db
    .selectFrom("trailer_state")
    .selectAll()
    .where("trailer_id", "=", id)
    .execute();
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
        driverId: r.driver_id,
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
        driver_id: t.driverId,
        last_event_at: t.lastEventAt,
      })
      .onConflict((oc) =>
        oc.column("trailer_id").doUpdateSet({
          status: t.status,
          current_hub_id: t.currentHubId,
          trip_id: t.tripId,
          dock_door_id: t.dockDoorId,
          assigned_package_ids: JSON.stringify(t.assignedPackageIds),
          driver_id: t.driverId,
          last_event_at: t.lastEventAt,
        }),
      )
      .execute();
  }
}

/**
 * Driver ids this event mutates (in BOTH driver projections), or `[]`. A relay
 * swap touches TWO drivers (incoming + outgoing); every other driver event one.
 * `DriverDutyStateChanged` mutates only `driver_status` — `applyDriverAssignment`
 * filters it out via its own reducer no-op (the `next === state` guard), so the
 * shared key list is safe to use for both appliers.
 */
function affectedDriverIds(event: DomainEvent): readonly string[] {
  switch (event.type) {
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
      return [event.payload.driverId];
    case "DriverSwappedAtHub":
      return [event.payload.incomingDriverId, event.payload.outgoingDriverId];
    default:
      return [];
  }
}

async function applyDriverStatus(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const ids = affectedDriverIds(replay.event);
  if (ids.length === 0) return; // non-driver event ⇒ no read, no write
  const rows = await db
    .selectFrom("driver_status")
    .selectAll()
    .where("driver_id", "in", ids)
    .execute();
  const state: DriverStatusState = new Map(
    rows.map((r) => [
      r.driver_id,
      {
        driverId: r.driver_id,
        status: asDutyStatus(r.status),
        remainingDriveMinutes: r.remaining_drive_minutes,
        dutyWindowDeadline:
          r.duty_window_deadline === null ? null : toIso(r.duty_window_deadline),
        totalDrivenMinutes: r.total_driven_minutes,
        weeklyOnDutyMin: r.weekly_on_duty_min,
        hosClock: r.hos_clock,
        currentHubId: r.current_hub_id,
        currentTripId: r.current_trip_id,
        lastEventAt: toIso(r.last_event_at),
      },
    ]),
  );
  const next = driverStatusReducer(state, toOccurred(replay));
  if (next === state) return; // non-driver event ⇒ nothing to persist
  for (const d of next.values()) {
    // OPT-HOS-02: the full clock is JSONB — serialize on write (null stays null),
    // mirroring zone_estimate.posterior. Read back parsed (see readOperationalTwin).
    const hosClockJson = d.hosClock === null ? null : JSON.stringify(d.hosClock);
    await db
      .insertInto("driver_status")
      .values({
        driver_id: d.driverId,
        status: d.status,
        remaining_drive_minutes: d.remainingDriveMinutes,
        duty_window_deadline: d.dutyWindowDeadline,
        total_driven_minutes: d.totalDrivenMinutes,
        weekly_on_duty_min: d.weeklyOnDutyMin,
        hos_clock: hosClockJson,
        current_hub_id: d.currentHubId,
        current_trip_id: d.currentTripId,
        last_event_at: d.lastEventAt,
      })
      .onConflict((oc) =>
        oc.column("driver_id").doUpdateSet({
          status: d.status,
          remaining_drive_minutes: d.remainingDriveMinutes,
          duty_window_deadline: d.dutyWindowDeadline,
          total_driven_minutes: d.totalDrivenMinutes,
          weekly_on_duty_min: d.weeklyOnDutyMin,
          hos_clock: hosClockJson,
          current_hub_id: d.currentHubId,
          current_trip_id: d.currentTripId,
          last_event_at: d.lastEventAt,
        }),
      )
      .execute();
  }
}

async function applyDriverAssignment(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const ids = affectedDriverIds(replay.event);
  if (ids.length === 0) return; // non-driver event ⇒ no read, no write
  const rows = await db
    .selectFrom("driver_assignment")
    .selectAll()
    .where("driver_id", "in", ids)
    .execute();
  const state: DriverAssignmentState = new Map(
    rows.map((r) => [
      r.driver_id,
      {
        driverId: r.driver_id,
        tripId: r.trip_id,
        trailerId: r.trailer_id,
        hubId: r.hub_id,
        lastEventAt: toIso(r.last_event_at),
      },
    ]),
  );
  const next = driverAssignmentReducer(state, toOccurred(replay));
  if (next === state) return; // non-driver event ⇒ nothing to persist
  for (const a of next.values()) {
    await db
      .insertInto("driver_assignment")
      .values({
        driver_id: a.driverId,
        trip_id: a.tripId,
        trailer_id: a.trailerId,
        hub_id: a.hubId,
        last_event_at: a.lastEventAt,
      })
      .onConflict((oc) =>
        oc.column("driver_id").doUpdateSet({
          trip_id: a.tripId,
          trailer_id: a.trailerId,
          hub_id: a.hubId,
          last_event_at: a.lastEventAt,
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

async function applyTagRegistry(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  // Only `PackageCreated` with a bound `rfidTagId` mutates the registry (one
  // `tagId` key); every other event is a no-op. Scope the read+write to that key.
  const event = replay.event;
  const tagId =
    event.type === "PackageCreated" ? event.payload.rfidTagId : undefined;
  if (tagId === undefined) return; // no tag mapping ⇒ no read, no write
  const rows = await db
    .selectFrom("tag_registry")
    .selectAll()
    .where("tag_id", "=", tagId)
    .execute();
  const state: TagRegistryState = new Map(
    rows.map((r) => [r.tag_id, r.package_id]),
  );
  const next = tagRegistryReducer(state, toOccurred(replay));
  for (const [t, packageId] of next) {
    await db
      .insertInto("tag_registry")
      .values({ tag_id: t, package_id: packageId })
      .onConflict((oc) =>
        oc.column("tag_id").doUpdateSet({ package_id: packageId }),
      )
      .execute();
  }
}

async function applyZoneEstimate(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  // The zone estimate is mutated by EXACTLY two events:
  //   - RfidObserved  ⇒ one key `${packageId}|${trailerId}` (needs the tag's
  //     registry mapping; an unmapped tag is a no-op, T-03-13).
  //   - PackageDelivered ⇒ DELETE every `${packageId}|*` row for the package.
  // Every other event is a no-op. Scope the read+write to the affected key(s)
  // instead of loading/rewriting the whole (unbounded) zone_estimate table.
  const event = replay.event;
  if (event.type === "RfidObserved") {
    // Resolve tagId -> packageId from the registry (read ONLY that tag's row).
    const reg = await db
      .selectFrom("tag_registry")
      .select(["tag_id", "package_id"])
      .where("tag_id", "=", event.payload.tagId)
      .executeTakeFirst();
    if (reg === undefined) return; // unmapped tag ⇒ no estimate (T-03-13)
    const packageId = reg.package_id;
    const key = `${packageId}|${event.payload.trailerId}`;
    const rows = await db
      .selectFrom("zone_estimate")
      .selectAll()
      .where("package_id", "=", packageId)
      .where("trailer_id", "=", event.payload.trailerId)
      .execute();
    const state: ZoneEstimateState = new Map(
      rows.map((r) => [
        `${r.package_id}|${r.trailer_id}`,
        {
          packageId: r.package_id,
          trailerId: r.trailer_id,
          estimatedZone: asZone(r.estimated_zone),
          confidence: r.confidence,
          posterior: asDistribution(r.posterior),
          lastReliableCheckpoint: r.last_reliable_checkpoint,
          lastObservedAt: toIso(r.last_observed_at),
        },
      ]),
    );
    const reduce = makeZoneEstimateReducer({
      resolveTag: (t) => (t === event.payload.tagId ? packageId : undefined),
      config: DEFAULT_FUSION_CONFIG,
    });
    const next = reduce(state, toOccurred(replay));
    const est = next.get(key);
    if (est === undefined) return; // reducer no-op for this key
    await db
      .insertInto("zone_estimate")
      .values({
        package_id: est.packageId,
        trailer_id: est.trailerId,
        estimated_zone: est.estimatedZone,
        confidence: est.confidence,
        posterior: JSON.stringify(est.posterior),
        last_reliable_checkpoint: est.lastReliableCheckpoint,
        last_observed_at: est.lastObservedAt,
      })
      .onConflict((oc) =>
        oc.columns(["package_id", "trailer_id"]).doUpdateSet({
          estimated_zone: est.estimatedZone,
          confidence: est.confidence,
          posterior: JSON.stringify(est.posterior),
          last_reliable_checkpoint: est.lastReliableCheckpoint,
          last_observed_at: est.lastObservedAt,
        }),
      )
      .execute();
    return;
  }
  if (event.type === "PackageDelivered") {
    // OUT-04 / D-22-1: purge every zone estimate for the delivered package (it
    // EXITED the network). Direct keyed DELETE — idempotent (absent ⇒ no-op).
    await db
      .deleteFrom("zone_estimate")
      .where("package_id", "=", event.payload.packageId)
      .execute();
    return;
  }
  // All other events are no-ops for the zone estimate.
}

/**
 * The exception id THIS event would open in `exceptions`, or null. Mirrors the
 * `exceptionsReducer` identity EXACTLY (so the keyed load contains precisely the
 * row the reducer reads for its idempotent "already opened?" check). The KPI
 * counters depend ONLY on whether this id was already present, so loading just
 * that one row + the single KPI row reproduces the full-table fold byte-for-byte.
 */
function affectedExceptionId(event: DomainEvent): string | null {
  switch (event.type) {
    case "WrongTrailerDetected":
      return exceptionIdKey(
        "wrong-trailer",
        event.payload.packageId,
        event.payload.observedTrailerId,
        event.payload.plannedTrailerId,
      );
    case "MissedUnloadDetected":
      return exceptionIdKey(
        "missed-unload",
        event.payload.packageId,
        event.payload.trailerId,
        event.payload.hubId,
      );
    default:
      return null;
  }
}

async function applyExceptions(
  db: Kysely<ProjectionDb>,
  replay: ReplayEvent,
): Promise<void> {
  const exId = affectedExceptionId(replay.event);
  if (exId === null) return; // non-detection event ⇒ no read, no write
  // Load ONLY the affected exception row + the single KPI counters row into the
  // reducer state. The reducer mutates only `exId` and the counters (which depend
  // solely on whether `exId` was already open), so this partial fold is identical
  // to the full-table fold (and to a rebuild-from-0) — P5a / FND-04 preserved.
  const [rows, kpi] = await Promise.all([
    db.selectFrom("exceptions").selectAll().where("exception_id", "=", exId).execute(),
    db.selectFrom("exception_kpi").selectAll().executeTakeFirst(),
  ]);
  const open = new Map<string, OpenException>(
    rows.map((r) => [
      r.exception_id,
      {
        exceptionId: r.exception_id,
        kind: asExceptionKind(r.kind),
        packageId: r.package_id,
        trailerId: r.trailer_id,
        hubId: r.hub_id,
        severity: asSeverity(r.severity),
        recommendedAction: r.recommended_action,
        confidence: r.confidence,
        occurredAt: toIso(r.occurred_at),
      },
    ]),
  );
  const state: ExceptionsState = {
    open,
    totalExceptions: kpi === undefined ? 0 : Number(kpi.total_exceptions),
    lowConfidenceExceptions:
      kpi === undefined ? 0 : Number(kpi.low_confidence_exceptions),
  };

  const next = exceptionsReducer(state, toOccurred(replay));
  if (next === state) return; // non-exception event ⇒ nothing to persist

  for (const ex of next.open.values()) {
    await db
      .insertInto("exceptions")
      .values({
        exception_id: ex.exceptionId,
        kind: ex.kind,
        package_id: ex.packageId,
        trailer_id: ex.trailerId,
        hub_id: ex.hubId,
        severity: ex.severity,
        recommended_action: ex.recommendedAction,
        confidence: ex.confidence,
        occurred_at: ex.occurredAt,
      })
      .onConflict((oc) =>
        oc.column("exception_id").doUpdateSet({
          kind: ex.kind,
          package_id: ex.packageId,
          trailer_id: ex.trailerId,
          hub_id: ex.hubId,
          severity: ex.severity,
          recommended_action: ex.recommendedAction,
          confidence: ex.confidence,
          occurred_at: ex.occurredAt,
        }),
      )
      .execute();
  }

  await db
    .insertInto("exception_kpi")
    .values({
      id: true,
      total_exceptions: next.totalExceptions,
      low_confidence_exceptions: next.lowConfidenceExceptions,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        total_exceptions: next.totalExceptions,
        low_confidence_exceptions: next.lowConfidenceExceptions,
      }),
    )
    .execute();
}

type Applier = (db: Kysely<ProjectionDb>, replay: ReplayEvent) => Promise<void>;

/** Each operational projection: its checkpoint name + its load/fold/persist step. */
const APPLIERS: ReadonlyArray<{ name: OperationalProjectionName; apply: Applier }> = [
  { name: "package-location", apply: applyPackageLocation },
  { name: "trailer-state", apply: applyTrailerState },
  { name: "hub-inventory", apply: applyHubInventory },
  // PRJ-01/PRJ-02 driver read models (OPERATIONAL, read-your-writes). They fold
  // ONLY the driver-lifecycle events; order vs the others is immaterial.
  { name: "driver-status", apply: applyDriverStatus },
  { name: "driver-assignment", apply: applyDriverAssignment },
  // tag-registry MUST precede zone-estimate: a PackageCreated in this event
  // registers the tag BEFORE the zone-estimate applier resolves a same-call
  // RfidObserved against the persisted registry (read-your-writes within one
  // applyInline pass).
  { name: "tag-registry", apply: applyTagRegistry },
  { name: "zone-estimate", apply: applyZoneEstimate },
  // The exceptions feed folds ONLY the detector's WrongTrailerDetected /
  // MissedUnloadDetected; order vs the others is immaterial (disjoint events).
  { name: "exceptions", apply: applyExceptions },
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
  /** PRJ-01: driver duty status + HOS summary, keyed by driverId. */
  readonly driverStatus: DriverStatusState;
  /** PRJ-02: driver -> trip/trailer assignment, keyed by driverId. */
  readonly driverAssignment: DriverAssignmentState;
}

/** Read the full operational twin from the persisted projection tables. */
export async function readOperationalTwin(
  db: Kysely<ProjectionDb>,
): Promise<OperationalTwin> {
  const [pkgRows, trailerRows, hubRows, driverRows, assignmentRows] =
    await Promise.all([
      db.selectFrom("package_location").selectAll().execute(),
      db.selectFrom("trailer_state").selectAll().execute(),
      db.selectFrom("hub_inventory").selectAll().execute(),
      db.selectFrom("driver_status").selectAll().execute(),
      db.selectFrom("driver_assignment").selectAll().execute(),
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
            driverId: r.driver_id,
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

  const driverStatus: DriverStatusState = driverRows.length
    ? new Map(
        driverRows.map((r) => [
          r.driver_id,
          {
            driverId: r.driver_id,
            status: asDutyStatus(r.status),
            remainingDriveMinutes: r.remaining_drive_minutes,
            dutyWindowDeadline:
              r.duty_window_deadline === null
                ? null
                : toIso(r.duty_window_deadline),
            totalDrivenMinutes: r.total_driven_minutes,
            weeklyOnDutyMin: r.weekly_on_duty_min,
            hosClock: r.hos_clock,
            currentHubId: r.current_hub_id,
            currentTripId: r.current_trip_id,
            lastEventAt: toIso(r.last_event_at),
          },
        ]),
      )
    : emptyDriverStatusState;

  const driverAssignment: DriverAssignmentState = assignmentRows.length
    ? new Map(
        assignmentRows.map((r) => [
          r.driver_id,
          {
            driverId: r.driver_id,
            tripId: r.trip_id,
            trailerId: r.trailer_id,
            hubId: r.hub_id,
            lastEventAt: toIso(r.last_event_at),
          },
        ]),
      )
    : emptyDriverAssignmentState;

  return {
    packageLocation,
    trailerState,
    hubInventory,
    driverStatus,
    driverAssignment,
  };
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

const DUTY_STATUSES = new Set(["driving", "on_break", "resting", "off_duty"]);
function asDutyStatus(value: string): DutyStatus {
  if (DUTY_STATUSES.has(value)) return value as DutyStatus;
  throw new Error(`Unknown driver duty status in projection row: ${value}`);
}

const ZONE_VALUES = new Set(["rear", "middle", "nose"]);
function asZone(value: string): "rear" | "middle" | "nose" {
  if (ZONE_VALUES.has(value)) return value as "rear" | "middle" | "nose";
  throw new Error(`Unknown zone in projection row: ${value}`);
}

/** Re-hydrate the persisted JSONB posterior as a 3-zone distribution. */
function asDistribution(
  value: Readonly<Record<string, number>>,
): Readonly<Record<"rear" | "middle" | "nose", number>> {
  return { rear: value.rear ?? 0, middle: value.middle ?? 0, nose: value.nose ?? 0 };
}

const EXCEPTION_KINDS = new Set(["wrong-trailer", "missed-unload"]);
function asExceptionKind(value: string): ExceptionKind {
  if (EXCEPTION_KINDS.has(value)) return value as ExceptionKind;
  throw new Error(`Unknown exception kind in projection row: ${value}`);
}

const SEVERITIES = new Set(["info", "warning", "critical"]);
function asSeverity(value: string): "info" | "warning" | "critical" {
  if (SEVERITIES.has(value)) return value as "info" | "warning" | "critical";
  throw new Error(`Unknown severity in projection row: ${value}`);
}

/**
 * Read the current OPEN exceptions (SNS-04/05), deterministically ordered by
 * `occurred_at` then `exception_id` — the stable feed order the API surfaces.
 */
export async function readOpenExceptions(
  db: Kysely<ProjectionDb>,
): Promise<readonly OpenException[]> {
  const rows = await db
    .selectFrom("exceptions")
    .selectAll()
    .orderBy("occurred_at", "asc")
    .orderBy("exception_id", "asc")
    .execute();
  return rows.map((r) => ({
    exceptionId: r.exception_id,
    kind: asExceptionKind(r.kind),
    packageId: r.package_id,
    trailerId: r.trailer_id,
    hubId: r.hub_id,
    severity: asSeverity(r.severity),
    recommendedAction: r.recommended_action,
    confidence: r.confidence,
    occurredAt: toIso(r.occurred_at),
  }));
}

/** The persisted false-positive-rate KPI snapshot (SNS-04/05). */
export interface ExceptionKpiSnapshot {
  readonly totalExceptions: number;
  readonly lowConfidenceExceptions: number;
  /** `lowConfidenceExceptions / totalExceptions`, or 0 when none opened. */
  readonly falsePositiveRate: number;
}

/** Read the false-positive-rate KPI counters as a queryable snapshot. */
export async function readExceptionKpi(
  db: Kysely<ProjectionDb>,
): Promise<ExceptionKpiSnapshot> {
  const kpi = await db.selectFrom("exception_kpi").selectAll().executeTakeFirst();
  const total = kpi === undefined ? 0 : Number(kpi.total_exceptions);
  const low = kpi === undefined ? 0 : Number(kpi.low_confidence_exceptions);
  return {
    totalExceptions: total,
    lowConfidenceExceptions: low,
    falsePositiveRate: total === 0 ? 0 : low / total,
  };
}
