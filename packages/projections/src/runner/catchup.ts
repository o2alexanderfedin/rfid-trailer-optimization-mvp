import { type Kysely, type ColumnType, sql } from "kysely";
import type { ProjectionDatabase, CatchupProjectionName } from "../schema.js";
import { CATCHUP_PROJECTIONS } from "../schema.js";
import {
  type AuditTimelineEntry,
  type StoredEventLike,
  auditTimelineReducer,
} from "../reducers/audit-timeline.js";
import {
  type GeoKeyframe,
  type GeoTrackState,
  geoTrackReducer,
  legKey,
} from "../reducers/geo-track.js";

/**
 * The CATCH-UP (async) projection runner (ARCHITECTURE Pattern 2), the async
 * counterpart of the inline operational applier (Plan 04).
 *
 * For each catch-up projection it:
 *   1. reads its `projection_checkpoints.last_seq`,
 *   2. reads the log strictly AFTER that seq via the injected `readAll`,
 *   3. applies the projection's pure reducer with IDEMPOTENT keyed upserts,
 *   4. advances the checkpoint to the last applied `global_seq`.
 *
 * Idempotency (P5a): every write is a keyed upsert (audit row keyed by
 * `global_seq`; keyframe keyed by `(trailer_id, trip_id, kind)`), so re-running
 * from a stale checkpoint never duplicates rows. The checkpoint makes re-runs a
 * bounded no-op once caught up.
 *
 * Determinism (P3 / FND-04): the reducers are pure (positions from logged route
 * geometry, time from `occurredAt`), so a full `rebuildCatchup` (truncate +
 * reset checkpoint + replay from 0) yields byte-identical state to the live run.
 *
 * Dependency inversion: the log reader is injected (`ReadAllEvents`) so this
 * package never imports `@mm/event-store` (which depends on it) — the cycle is
 * broken at the type level while tests/composition pass the real `readAll`.
 */

/** The checkpoint table this runner reads/advances (owned by the event store). */
interface CheckpointTable {
  projection: string;
  last_seq: ColumnType<string, string | number, string | number>;
}

/** The database surface the catch-up runner needs. */
export interface CatchupDb extends ProjectionDatabase {
  projection_checkpoints: CheckpointTable;
}

/**
 * The injected log reader: events strictly after `fromGlobalSeq`, ascending by
 * `global_seq`. `@mm/event-store`'s `readAll` matches exactly (its `StoredEvent`
 * is a structural superset of `StoredEventLike`).
 */
export type ReadAllEvents = (
  db: Kysely<CatchupDb>,
  fromGlobalSeq: bigint,
) => Promise<readonly StoredEventLike[]>;

/** Read the per-projection last-applied global_seq (0 if never run). */
async function readCheckpoint(
  db: Kysely<CatchupDb>,
  projection: CatchupProjectionName,
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
  db: Kysely<CatchupDb>,
  projection: CatchupProjectionName,
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

/** Idempotent upsert of one audit-timeline row (keyed by `global_seq`). */
async function upsertAuditRow(
  db: Kysely<CatchupDb>,
  entry: AuditTimelineEntry,
): Promise<void> {
  await db
    .insertInto("audit_timeline")
    .values({
      global_seq: entry.globalSeq.toString(),
      package_id: entry.packageId,
      event_type: entry.eventType,
      occurred_at: entry.occurredAt,
      hub_id: entry.hubId,
      scan_type: entry.scanType,
    })
    .onConflict((oc) =>
      oc.column("global_seq").doUpdateSet({
        package_id: entry.packageId,
        event_type: entry.eventType,
        occurred_at: entry.occurredAt,
        hub_id: entry.hubId,
        scan_type: entry.scanType,
      }),
    )
    .execute();
}

/** Idempotent upsert of one geo keyframe (keyed by trailer/trip/kind). */
async function upsertKeyframe(
  db: Kysely<CatchupDb>,
  kf: GeoKeyframe,
): Promise<void> {
  await db
    .insertInto("geo_keyframe")
    .values({
      trailer_id: kf.trailerId,
      trip_id: kf.tripId,
      kind: kf.kind,
      t: kf.t,
      lon: kf.lon,
      lat: kf.lat,
    })
    .onConflict((oc) =>
      oc.columns(["trailer_id", "trip_id", "kind"]).doUpdateSet({
        t: kf.t,
        lon: kf.lon,
        lat: kf.lat,
      }),
    )
    .execute();
}

/**
 * Advance the AUDIT-TIMELINE projection from its checkpoint to the log head.
 * Returns the number of newly-applied events (0 when already caught up).
 */
async function runAuditTimeline(
  db: Kysely<CatchupDb>,
  readAll: ReadAllEvents,
): Promise<number> {
  const from = await readCheckpoint(db, "audit-timeline");
  const events = await readAll(db, from);
  let applied = 0;
  for (const stored of events) {
    const entry = auditTimelineReducer(stored);
    if (entry !== null) await upsertAuditRow(db, entry);
    await advanceCheckpoint(db, "audit-timeline", stored.globalSeq);
    applied += 1;
  }
  return applied;
}

/**
 * Load the persisted geo-track fold state: the route geometry index (keyed by
 * directed hub pair) AND the in-flight trip -> leg index (M-4). Seeding `inflight`
 * from `geo_inflight_trip` lets the incremental catch-up resolve an arrival whose
 * departure was folded in an earlier pass, identically to a full rebuild.
 */
async function loadGeoTrackState(db: Kysely<CatchupDb>): Promise<GeoTrackState> {
  const [routeRows, inflightRows] = await Promise.all([
    db.selectFrom("geo_route").selectAll().execute(),
    db.selectFrom("geo_inflight_trip").selectAll().execute(),
  ]);
  const routes = new Map<string, readonly [number, number][]>();
  for (const r of routeRows) routes.set(legKey(r.from_hub_id, r.to_hub_id), r.geometry);
  const inflight = new Map<string, string>();
  for (const r of inflightRows) {
    inflight.set(r.trip_id, legKey(r.from_hub_id, r.to_hub_id));
  }
  return { routes, inflight };
}

/** Record a trip's in-flight leg (M-4), idempotent on the trip id. */
async function upsertInflightTrip(
  db: Kysely<CatchupDb>,
  tripId: string,
  fromHubId: string,
  toHubId: string,
): Promise<void> {
  await db
    .insertInto("geo_inflight_trip")
    .values({ trip_id: tripId, from_hub_id: fromHubId, to_hub_id: toHubId })
    .onConflict((oc) =>
      oc.column("trip_id").doUpdateSet({ from_hub_id: fromHubId, to_hub_id: toHubId }),
    )
    .execute();
}

/** Drop a completed trip from the in-flight index (M-4). */
async function deleteInflightTrip(db: Kysely<CatchupDb>, tripId: string): Promise<void> {
  await db.deleteFrom("geo_inflight_trip").where("trip_id", "=", tripId).execute();
}

/** Idempotent upsert of one route geometry into the persisted index. */
async function upsertRoute(
  db: Kysely<CatchupDb>,
  fromHubId: string,
  toHubId: string,
  geometry: readonly [number, number][],
): Promise<void> {
  await db
    .insertInto("geo_route")
    .values({ from_hub_id: fromHubId, to_hub_id: toHubId, geometry: JSON.stringify(geometry) })
    .onConflict((oc) =>
      oc
        .columns(["from_hub_id", "to_hub_id"])
        .doUpdateSet({ geometry: JSON.stringify(geometry) }),
    )
    .execute();
}

/**
 * Advance the GEO-TRACK projection from its checkpoint to the log head,
 * INCREMENTALLY: seed the route index from the persisted `geo_route` table, fold
 * only the events after the checkpoint, persisting new routes + keyframes. This
 * is O(new events), not O(log) — the route index is never re-scanned from the
 * whole log on a steady-state tick. Returns the number of newly-applied events.
 */
async function runGeoTrack(
  db: Kysely<CatchupDb>,
  readAll: ReadAllEvents,
): Promise<number> {
  const from = await readCheckpoint(db, "geo-track");
  let state = await loadGeoTrackState(db);

  const events = await readAll(db, from);
  let applied = 0;
  for (const stored of events) {
    const { event } = stored;
    if (event.type === "RouteRegistered") {
      await upsertRoute(db, event.payload.fromHubId, event.payload.toHubId, event.payload.geometry);
    } else if (event.type === "TrailerDeparted") {
      // Persist the trip's leg so a later-pass arrival resolves it (M-4).
      await upsertInflightTrip(
        db,
        event.payload.tripId,
        event.payload.fromHubId,
        event.payload.toHubId,
      );
    } else if (event.type === "TrailerArrivedAtHub") {
      // The trip's leg is consumed by the arrival; drop it from the index (M-4).
      await deleteInflightTrip(db, event.payload.tripId);
    }
    const step = geoTrackReducer(state, stored);
    state = step.state;
    for (const kf of step.keyframes) await upsertKeyframe(db, kf);
    await advanceCheckpoint(db, "geo-track", stored.globalSeq);
    applied += 1;
  }
  return applied;
}

/** Per-run result: how many events each catch-up projection newly applied. */
export interface CatchupResult {
  readonly auditTimeline: number;
  readonly geoTrack: number;
}

/**
 * Run ONE catch-up pass for every catch-up projection: advance each from its
 * checkpoint to the current log head. Safe to call repeatedly (a poller tick);
 * once caught up it is a bounded no-op.
 */
export async function runCatchup(
  db: Kysely<CatchupDb>,
  readAll: ReadAllEvents,
): Promise<CatchupResult> {
  const auditTimeline = await runAuditTimeline(db, readAll);
  const geoTrack = await runGeoTrack(db, readAll);
  return { auditTimeline, geoTrack };
}

/**
 * Full rebuild of the catch-up projections (the event-sourcing rebuild benefit):
 * TRUNCATE the read models, reset their checkpoints to 0, and replay the whole
 * log from `global_seq=0`. Because it reuses the same pure reducers + upserts as
 * the live `runCatchup`, the rebuilt state is byte-identical to the live state.
 */
export async function rebuildCatchup(
  db: Kysely<CatchupDb>,
  readAll: ReadAllEvents,
): Promise<CatchupResult> {
  await sql`TRUNCATE TABLE audit_timeline, geo_route, geo_keyframe, geo_inflight_trip`.execute(
    db,
  );
  for (const projection of CATCHUP_PROJECTIONS) {
    await db
      .insertInto("projection_checkpoints")
      .values({ projection, last_seq: "0" })
      .onConflict((oc) =>
        oc.column("projection").doUpdateSet({ last_seq: "0" }),
      )
      .execute();
  }
  return runCatchup(db, readAll);
}

// --- Read side: assemble the catch-up read models ----------------------------

/** Read a package's full ordered audit timeline (FND-08). */
export async function readAuditTimeline(
  db: Kysely<CatchupDb>,
  packageId: string,
): Promise<AuditTimelineEntry[]> {
  const rows = await db
    .selectFrom("audit_timeline")
    .selectAll()
    .where("package_id", "=", packageId)
    .orderBy("global_seq", "asc")
    .execute();
  return rows.map((r) => ({
    packageId: r.package_id,
    globalSeq: BigInt(r.global_seq),
    eventType: r.event_type as AuditTimelineEntry["eventType"],
    occurredAt: toIso(r.occurred_at),
    hubId: r.hub_id,
    scanType: r.scan_type,
  }));
}

/** Read all geo keyframes, deterministically ordered for the map / snapshots. */
export async function readGeoKeyframes(
  db: Kysely<CatchupDb>,
): Promise<GeoKeyframe[]> {
  const rows = await db
    .selectFrom("geo_keyframe")
    .selectAll()
    .orderBy("trailer_id", "asc")
    .orderBy("trip_id", "asc")
    .orderBy("kind", "asc")
    .execute();
  return rows.map((r) => ({
    trailerId: r.trailer_id,
    tripId: r.trip_id,
    kind: r.kind as GeoKeyframe["kind"],
    t: toIso(r.t),
    lon: r.lon,
    lat: r.lat,
  }));
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Canonical, deterministic serialization of BOTH catch-up read models, for the
 * rebuild-equivalence assertion (live state == rebuilt-from-log state). Audit
 * rows are sorted by `global_seq`; keyframes by `(trailerId, tripId, kind)`. The
 * live run and a rebuild produce IDENTICAL strings iff the projected state is
 * identical — no dependence on row/insert order (P3 / FND-04).
 */
export async function serializeCatchup(db: Kysely<CatchupDb>): Promise<string> {
  const auditRows = await db
    .selectFrom("audit_timeline")
    .selectAll()
    .orderBy("global_seq", "asc")
    .execute();
  const audit = auditRows.map((r) => ({
    globalSeq: r.global_seq.toString(),
    packageId: r.package_id,
    eventType: r.event_type,
    occurredAt: toIso(r.occurred_at),
    hubId: r.hub_id,
    scanType: r.scan_type,
  }));

  const geo = (await readGeoKeyframes(db)).map((k) => ({
    trailerId: k.trailerId,
    tripId: k.tripId,
    kind: k.kind,
    t: k.t,
    lon: k.lon,
    lat: k.lat,
  }));

  return JSON.stringify({ audit, geo });
}
