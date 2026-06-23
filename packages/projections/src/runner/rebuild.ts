import { type Kysely, sql } from "kysely";
import { OPERATIONAL_PROJECTIONS } from "../schema.js";
import {
  type OperationalTwin,
  type ProjectionDb,
  type ReplayEvent,
  applyInline,
} from "./inline.js";

/**
 * The truncate + replay-from-global_seq=0 rebuild driver (FND-04 keystone).
 *
 * `rebuildProjections` makes the operational twin deterministically
 * reconstructable from the immutable log alone:
 *   1. TRUNCATE every operational projection table.
 *   2. Reset each operational `projection_checkpoints.last_seq` to 0.
 *   3. Replay the WHOLE log via `readAll(db, 0n)` — strictly in `global_seq`
 *      order, NEVER by timestamp — through the SAME `applyInline` used live.
 *
 * Because rebuild reuses `applyInline` (the same pure reducers + persistence),
 * the rebuilt state cannot diverge from the live state: that equivalence is the
 * phase's determinism keystone (P3), asserted byte-identical by the golden
 * replay test via `serializeTwin`.
 *
 * Dependency inversion: the event reader is injected (`ReadAllEvents`) so this
 * package never imports `@mm/event-store` (which depends on it) — the cycle is
 * broken at the type level while tests pass `@mm/event-store`'s real `readAll`.
 */

/**
 * The injected log reader: returns events strictly after `fromGlobalSeq`, in
 * ascending `global_seq` order. `@mm/event-store`'s `readAll` matches this
 * exactly (its `StoredEvent` is a structural superset of `ReplayEvent`).
 */
export type ReadAllEvents = (
  db: Kysely<ProjectionDb>,
  fromGlobalSeq: bigint,
) => Promise<readonly ReplayEvent[]>;

/**
 * Truncate the operational projection tables, reset their checkpoints, and
 * replay the entire event log from `global_seq=0` through the inline applier.
 */
export async function rebuildProjections(
  db: Kysely<ProjectionDb>,
  readAll: ReadAllEvents,
): Promise<void> {
  // 1. Drop derived state. CASCADE is unnecessary (no FKs into these tables);
  //    RESTART IDENTITY is moot (no identity columns) — kept simple (KISS).
  await sql`TRUNCATE TABLE package_location, trailer_state, hub_inventory, driver_status, driver_assignment, tag_registry, zone_estimate, exceptions, exception_kpi`.execute(
    db,
  );

  // 2. Reset every operational checkpoint to 0 so the replay re-applies all.
  for (const projection of OPERATIONAL_PROJECTIONS) {
    await db
      .insertInto("projection_checkpoints")
      .values({ projection, last_seq: "0" })
      .onConflict((oc) =>
        oc.column("projection").doUpdateSet({ last_seq: "0" }),
      )
      .execute();
  }

  // 3. Replay the whole log strictly by global_seq through the SAME apply path.
  const events = await readAll(db, 0n);
  for (const replay of events) {
    await applyInline(db, replay);
  }
}

/**
 * Canonical, deterministic serialization of the operational twin for the
 * golden-replay byte-identical comparison. Maps are flattened to arrays SORTED
 * by their stable primary key, and object keys are emitted in a fixed order, so
 * the live run and the rebuilt run produce IDENTICAL strings iff the projected
 * state is identical — no dependence on Map/insert order (P3).
 */
export function serializeTwin(twin: OperationalTwin): string {
  const packageLocation = [...twin.packageLocation.values()]
    .sort((a, b) => compare(a.packageId, b.packageId))
    .map((p) => ({
      packageId: p.packageId,
      hubId: p.hubId,
      confidence: p.confidence,
      lastSeenAt: p.lastSeenAt,
    }));

  const trailerState = [...twin.trailerState.values()]
    .sort((a, b) => compare(a.trailerId, b.trailerId))
    .map((t) => ({
      trailerId: t.trailerId,
      status: t.status,
      currentHubId: t.currentHubId,
      tripId: t.tripId,
      dockDoorId: t.dockDoorId,
      assignedPackageIds: [...t.assignedPackageIds],
      driverId: t.driverId,
      lastEventAt: t.lastEventAt,
    }));

  const hubInventory = [...twin.hubInventory.values()]
    .sort((a, b) => compare(a.hubId, b.hubId))
    .map((h) => ({
      hubId: h.hubId,
      inbound: [...h.inbound],
      outbound: [...h.outbound],
      staged: [...h.staged],
    }));

  const driverStatus = [...twin.driverStatus.values()]
    .sort((a, b) => compare(a.driverId, b.driverId))
    .map((d) => ({
      driverId: d.driverId,
      status: d.status,
      remainingDriveMinutes: d.remainingDriveMinutes,
      dutyWindowDeadline: d.dutyWindowDeadline,
      totalDrivenMinutes: d.totalDrivenMinutes,
      weeklyOnDutyMin: d.weeklyOnDutyMin,
      currentHubId: d.currentHubId,
      currentTripId: d.currentTripId,
      lastEventAt: d.lastEventAt,
    }));

  const driverAssignment = [...twin.driverAssignment.values()]
    .sort((a, b) => compare(a.driverId, b.driverId))
    .map((a) => ({
      driverId: a.driverId,
      tripId: a.tripId,
      trailerId: a.trailerId,
      hubId: a.hubId,
      lastEventAt: a.lastEventAt,
    }));

  return JSON.stringify({
    packageLocation,
    trailerState,
    hubInventory,
    driverStatus,
    driverAssignment,
  });
}

/** Total, stable string comparator (code-unit order) — locale-independent (P3). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
