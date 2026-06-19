import { appendToStream, readAll, type Database } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  runCatchup,
  type CatchupDb,
  type ProjectionDb,
  type StoredEventLike,
} from "@mm/projections";
import { simulate, type SimulatedEvent } from "@mm/simulation";
import type { Kysely } from "kysely";
import type { ApiDb } from "../routes/queries.js";
import type { Broadcast } from "../ws/snapshots.js";

/**
 * The demo sim driver: consumes `@mm/simulation` to populate the event store +
 * projections and push a ws snapshot PER TICK (not per raw event —
 * ARCHITECTURE Anti-Pattern 4).
 *
 * A "tick" is one distinct domain timestamp (`occurredAt`) in the deterministic
 * stream. Per tick we:
 *   1. append that tick's events (grouped per stream, OCC-guarded),
 *   2. apply them inline to the operational twin (read-your-writes),
 *   3. advance the catch-up projections (audit timeline + geo-track),
 *   4. broadcast ONE batched snapshot to every ws client.
 *
 * Determinism is inherited from `@mm/simulation` (same seed -> same stream), so
 * the demo is reproducible. The driver is decoupled from the transport via the
 * injected `broadcast` (DIP).
 */

/** View the API handle as the event-store / catch-up read schemas. */
function eventStoreView(db: ApiDb): Kysely<Database> {
  return db as unknown as Kysely<Database>;
}
function catchupView(db: ApiDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/** Inject `readAll` as the catch-up log reader. */
function replayReadAll(
  db: Kysely<CatchupDb>,
  fromGlobalSeq: bigint,
): Promise<readonly StoredEventLike[]> {
  return readAll(db as unknown as Kysely<Database>, fromGlobalSeq);
}

/** Options for {@link driveSimulation}. */
export interface DriveSimulationOptions {
  readonly db: ApiDb;
  readonly seed: number;
  readonly durationTicks: number;
  /** Push one snapshot per tick; pass `undefined` to skip the ws broadcast. */
  readonly broadcast: Broadcast | undefined;
}

/** Group the deterministic stream into ordered ticks by `occurredAt`. */
function intoTicks(stream: readonly SimulatedEvent[]): SimulatedEvent[][] {
  const ticks: SimulatedEvent[][] = [];
  let currentAt: string | null = null;
  for (const item of stream) {
    if (item.occurredAt !== currentAt) {
      ticks.push([]);
      currentAt = item.occurredAt;
    }
    ticks[ticks.length - 1]!.push(item);
  }
  return ticks;
}

/**
 * Run the demo simulation into the store + projections, broadcasting one
 * snapshot per tick. Returns the number of ticks driven.
 */
export async function driveSimulation(
  opts: DriveSimulationOptions,
): Promise<{ ticks: number }> {
  const es = eventStoreView(opts.db);
  const stream = simulate({ seed: opts.seed, durationTicks: opts.durationTicks });
  const ticks = intoTicks(stream);

  let cursor = 0n;
  for (const tick of ticks) {
    // 1. Append this tick's events, grouped per stream (OCC at current version).
    const perStream = new Map<string, SimulatedEvent[]>();
    for (const item of tick) {
      const buf = perStream.get(item.streamId) ?? [];
      buf.push(item);
      perStream.set(item.streamId, buf);
    }
    for (const [streamId, items] of perStream) {
      const current = await es
        .selectFrom("streams")
        .select("version")
        .where("stream_id", "=", streamId)
        .executeTakeFirst();
      await appendToStream(
        es,
        streamId,
        current?.version ?? 0,
        items.map((i) => i.event),
        new Date(items[0]!.occurredAt),
      );
    }

    // 2. Apply the new events inline to the operational twin (read-your-writes),
    //    in ONE transaction per tick to minimize round-trips.
    const fresh = await readAll(es, cursor);
    if (fresh.length > 0) {
      await opts.db.transaction().execute(async (trx) => {
        const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
        for (const ev of fresh) await applyInline(proj, ev);
      });
      cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    // 3. Advance the catch-up projections (audit timeline + geo-track).
    await runCatchup(catchupView(opts.db), replayReadAll);

    // 4. Push ONE batched snapshot per tick.
    if (opts.broadcast !== undefined) await opts.broadcast();
  }

  return { ticks: ticks.length };
}
