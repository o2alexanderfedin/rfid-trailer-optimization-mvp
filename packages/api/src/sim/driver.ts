import {
  appendToStream,
  appendWithRetry,
  readAll,
  type Database,
} from "@mm/event-store";
import {
  applyInline,
  makeProjectionReads,
  projectionView,
  runCatchup,
  runDetection,
  type CatchupDb,
  type DetectionConfig,
  type DetectorReads,
  type ProjectionDb,
  type StoredEventLike,
} from "@mm/projections";
import {
  applyScenario,
  type RfidSimConfig,
  simulate,
  type ScenarioKnobs,
  type SimulatedEvent,
} from "@mm/simulation";
import { makeRng } from "@mm/simulation";
import type { DomainEvent } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";
import type { Kysely } from "kysely";
import type { ApiDb } from "../routes/queries.js";
import { PRODUCTION_DETECTION_CONFIG } from "../detection-config.js";
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
 *   4. run the rolling optimizer tick (RollingLoop.tick) — SIM-04 live loop,
 *   5. broadcast ONE batched snapshot to every ws client.
 *
 * Determinism is inherited from `@mm/simulation` (same seed -> same stream), so
 * the demo is reproducible. The driver is decoupled from the transport via the
 * injected `broadcast` (DIP).
 *
 * SIM-04 addition: `driveSimulationWithScenario` allows a `ScenarioKnobs`
 * injection that modifies the deterministic stream BEFORE driving it, and the
 * `RollingLoop` is called per tick so the re-optimization is visible end-to-end.
 */

// ---------------------------------------------------------------------------
// Rolling-loop tick runner (the live optimizer hook)
// ---------------------------------------------------------------------------

/** The minimal interface the driver needs from RollingLoop (DIP). */
export interface LoopLike {
  tick: (input: { events: readonly DomainEvent[]; simMs: number }) => Promise<EpochResult>;
}

/** Options for {@link makeSimRunner}. */
export interface SimRunnerOptions {
  /** The rolling optimizer loop to call per tick. `undefined` disables the optimizer. */
  readonly loop: LoopLike | undefined;
}

/**
 * A per-tick callable that fires the rolling optimizer (if present).
 * Returns the `EpochResult` or `undefined` when no loop is configured.
 */
export type SimTickRunner = (
  events: readonly DomainEvent[],
  simMs: number,
) => Promise<EpochResult | undefined>;

/**
 * Build a per-tick callable that forwards to the rolling optimizer loop.
 * Returns a no-op when `loop` is `undefined` (backward-compat).
 *
 * Pattern: this is the ONLY way the driver couples to the optimizer — purely
 * via injection (DIP), so both the driver and the optimizer remain testable in
 * isolation. The server composition root wires a `RollingLoop` instance.
 */
export function makeSimRunner(opts: SimRunnerOptions): SimTickRunner {
  if (opts.loop === undefined) {
    return async (_events: readonly DomainEvent[], _simMs: number) => undefined;
  }
  const { loop } = opts;
  return async (events: readonly DomainEvent[], simMs: number) => {
    return loop.tick({ events, simMs });
  };
}

// ---------------------------------------------------------------------------
// DB view helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/** Options for {@link driveSimulation}. */
export interface DriveSimulationOptions {
  readonly db: ApiDb;
  readonly seed: number;
  readonly durationTicks: number;
  /**
   * Enable seeded probabilistic RFID emission (portal + antenna reads, with
   * drops + jitter). When PRESENT the stream carries `RfidObserved`, the inline
   * zone-estimate projection fuses zones, and the per-tick detector runs — so a
   * noisy run produces a live exception feed. ABSENT ⇒ the exact pre-RFID stream
   * (no reads, no detection) — backward-compatible with the FND/ws sim tests.
   */
  readonly rfid?: Partial<RfidSimConfig>;
  /**
   * Detection calibration band; defaults to {@link PRODUCTION_DETECTION_CONFIG}
   * (the ONE production band). Injectable for tuning/tests (DIP).
   */
  readonly detection?: DetectionConfig;
  /** Push one snapshot per tick; pass `undefined` to skip the ws broadcast. */
  readonly broadcast: Broadcast | undefined;
  /**
   * SIM-04: When provided, the rolling optimizer fires per tick (live re-opt).
   * `undefined` disables the live loop — backward-compatible with existing tests.
   */
  readonly loop?: LoopLike;
}

/**
 * FIX E: options for the paced live-demo driver.
 * Same as {@link DriveSimulationOptions} but adds `tickIntervalMs` for
 * presentation-layer pacing (how long to wait between sim-tick broadcasts).
 *
 * DETERMINISM GUARANTEE: `tickIntervalMs` is ONLY used by `setTimeout` for
 * pacing the broadcast — it NEVER enters the sim engine, the event store, or
 * the optimizer. The sim stream is still generated deterministically (same
 * seed → same events). Only the *delivery rate* is wall-clock.
 */
export interface DriveSimulationPacedOptions extends DriveSimulationOptions {
  /**
   * Wall-clock milliseconds to wait between consecutive tick broadcasts.
   * Default: 500ms (2 ticks/sec). Increase for a slower demo, decrease for speed.
   * Pure presentation pacing — NOT fed into the sim engine.
   */
  readonly tickIntervalMs?: number;
}

/**
 * SIM-04 variant: drive the simulation with an INJECTED scenario.
 * The `knobs` are applied to the deterministic stream (via `applyScenario`)
 * before driving it into the store + projections. The `scenarioSeed` is used
 * to seed the scenario-injection RNG (separate from the sim seed so the base
 * stream is unchanged). Returns the number of ticks driven.
 */
export interface DriveSimulationWithScenarioOptions extends DriveSimulationOptions {
  /** The four operator scenario knobs to inject (SIM-04). */
  readonly scenario: ScenarioKnobs;
  /**
   * Seed for the scenario-injection RNG. Defaults to `seed ^ 0xscen` if absent.
   * Keep separate from the base sim seed to preserve base-stream determinism.
   */
  readonly scenarioSeed?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * Build the PLANNED dest-hub index from the seeded `PackageCreated` events. The
 * destination hub is NOT folded into any projection (it is the plan, not the
 * observed twin), so the detector's `readDestHub` port is satisfied from the
 * stream — DIP keeps `@mm/projections` acyclic (it never sees the event store).
 */
function destHubIndex(stream: readonly SimulatedEvent[]): Map<string, string> {
  const dest = new Map<string, string>();
  for (const e of stream) {
    if (e.event.type === "PackageCreated") {
      dest.set(e.event.payload.packageId, e.event.payload.destHubId);
    }
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Core per-tick driver loop (shared by both public functions)
// ---------------------------------------------------------------------------

/**
 * Drive an already-built `ticks[]` into the store + projections, with the
 * rolling optimizer and broadcast hooks.
 */
async function driveTickStream(
  db: ApiDb,
  ticks: SimulatedEvent[][],
  opts: Pick<DriveSimulationOptions, "rfid" | "detection" | "broadcast" | "loop">,
  fullStream: readonly SimulatedEvent[],
): Promise<{ ticks: number }> {
  const es = eventStoreView(db);
  const runner = makeSimRunner({ loop: opts.loop });

  const detectionOn = opts.rfid !== undefined;
  const detectionConfig = opts.detection ?? PRODUCTION_DETECTION_CONFIG;
  const destHub = detectionOn ? destHubIndex(fullStream) : new Map<string, string>();
  const departedHubs = new Set<string>();

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

    // Record the EXACT hubs a trailer departed this tick — the SNS-05 gate
    // (missed-unload fires only post-departure of the relevant stop).
    if (detectionOn) {
      for (const item of tick) {
        if (item.event.type === "TrailerDeparted") {
          departedHubs.add(item.event.payload.fromHubId);
        }
      }
    }

    // 2. Apply the new events inline to the operational twin (read-your-writes),
    //    in ONE transaction per tick to minimize round-trips.
    const fresh = await readAll(es, cursor);
    if (fresh.length > 0) {
      await db.transaction().execute(async (trx) => {
        const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
        for (const ev of fresh) await applyInline(proj, ev);
      });
      cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    // 3. Run the detector AFTER the inline zone-estimate fold (PLANNED vs
    //    OBSERVED ⇒ exceptions). Its appends use the OCC-safe `appendWithRetry`
    //    (a concurrent writer alongside the sim converges), then we fold those
    //    fresh exception events inline so the feed surfaces this tick.
    if (detectionOn) {
      await runDetection(
        detectorReads(db, es, destHub, departedHubs),
        { config: detectionConfig },
      );
      const detected = await readAll(es, cursor);
      if (detected.length > 0) {
        await db.transaction().execute(async (trx) => {
          const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
          for (const ev of detected) await applyInline(proj, ev);
        });
        cursor = detected[detected.length - 1]!.globalSeq;
      }
    }

    // 4. Advance the catch-up projections (audit timeline + geo-track).
    await runCatchup(catchupView(db), replayReadAll);

    // 5. SIM-04: Run the rolling optimizer AFTER projections are updated
    //    (read-your-writes), so the optimizer sees the freshest twin.
    //    Collect the tick's domain events for scope detection (OPT-05).
    const tickMs = new Date(tick[0]!.occurredAt).getTime();
    const tickEvents = tick.map((i) => i.event);
    await runner(tickEvents, tickMs);

    // 6. Push ONE batched snapshot per tick. Supply the tick's domain timestamp
    //    as the authoritative sim-clock milliseconds for the ws envelope.
    if (opts.broadcast !== undefined) {
      await opts.broadcast(tickMs);
    }
  }

  return { ticks: ticks.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the demo simulation into the store + projections, broadcasting one
 * snapshot per tick. Returns the number of ticks driven.
 *
 * When `rfid` is enabled the per-tick loop also runs the detector (PLANNED vs
 * OBSERVED ⇒ exceptions) AFTER the inline zone-estimate projection has folded
 * that tick's reads, closing the Phase-3 loop end-to-end.
 *
 * When `loop` is provided (SIM-04), the rolling optimizer runs per tick
 * AFTER projections are folded — so a scenario injection or organic change
 * triggers a scoped re-optimization visible via `GET /optimizer/recommendations`.
 */
export async function driveSimulation(
  opts: DriveSimulationOptions,
): Promise<{ ticks: number }> {
  const stream = simulate({
    seed: opts.seed,
    durationTicks: opts.durationTicks,
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
  });
  const ticks = intoTicks(stream);
  return driveTickStream(opts.db, ticks, opts, stream);
}

/**
 * FIX E: Drive the simulation LIVE — one tick per wall-clock interval.
 *
 * This is the ONLY difference from `driveSimulation`: instead of running all
 * ticks synchronously (blocking until complete), each tick is scheduled with
 * `setTimeout(tickIntervalMs)` so:
 *   - The HTTP server is live during the sim (clients can connect, call REST).
 *   - Connected ws clients receive broadcast() per tick and see the map animate.
 *   - The rolling optimizer runs per tick (live re-opt visible on the map).
 *
 * DETERMINISM CONTRACT: the sim stream is generated once, deterministically
 * (same seed → same events in the same order). `tickIntervalMs` only paces
 * the DELIVERY of each tick's events to the DB + ws clients. It never enters
 * the sim engine, the event store OCC path, or the optimizer epoch clock.
 *
 * Returns a Promise that resolves when all ticks have been driven.
 */
export async function driveSimulationPaced(
  opts: DriveSimulationPacedOptions,
): Promise<{ ticks: number }> {
  const stream = simulate({
    seed: opts.seed,
    durationTicks: opts.durationTicks,
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
  });
  const ticks = intoTicks(stream);
  const intervalMs = opts.tickIntervalMs ?? 500;

  // Drive ticks one at a time with a wall-clock pause between each.
  // We inline the per-tick logic from `driveTickStream` here to preserve
  // cross-tick mutable state (cursor, departedHubs) that must accumulate
  // across ticks for correctness (detection SNS-05 gate, event-log cursor).
  const es = eventStoreView(opts.db);
  const runner = makeSimRunner({ loop: opts.loop });

  const detectionOn = opts.rfid !== undefined;
  const detectionConfig = opts.detection ?? PRODUCTION_DETECTION_CONFIG;
  const destHub = detectionOn ? destHubIndex(stream) : new Map<string, string>();
  // departedHubs accumulates across ALL ticks — never reset between ticks.
  const departedHubs = new Set<string>();

  // cursor tracks the event-log position across ALL ticks — never reset.
  let cursor = 0n;

  let driven = 0;
  for (const tick of ticks) {
    // (a) Append this tick's events (OCC-safe per stream).
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

    // (b) Track departed hubs for SNS-05 gate (accumulates across ticks).
    if (detectionOn) {
      for (const item of tick) {
        if (item.event.type === "TrailerDeparted") {
          departedHubs.add(item.event.payload.fromHubId);
        }
      }
    }

    // (c) Inline projection (read-your-writes).
    const fresh = await readAll(es, cursor);
    if (fresh.length > 0) {
      await opts.db.transaction().execute(async (trx) => {
        const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
        for (const ev of fresh) await applyInline(proj, ev);
      });
      cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    // (d) Detection (PLANNED vs OBSERVED → exceptions).
    if (detectionOn) {
      await runDetection(
        detectorReads(opts.db, es, destHub, departedHubs),
        { config: detectionConfig },
      );
      const detected = await readAll(es, cursor);
      if (detected.length > 0) {
        await opts.db.transaction().execute(async (trx) => {
          const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
          for (const ev of detected) await applyInline(proj, ev);
        });
        cursor = detected[detected.length - 1]!.globalSeq;
      }
    }

    // (e) Catch-up projections (audit timeline + geo-track).
    await runCatchup(catchupView(opts.db), replayReadAll);

    // (f) Rolling optimizer per tick (live re-opt).
    const tickMs = new Date(tick[0]!.occurredAt).getTime();
    const tickEvents = tick.map((i) => i.event);
    await runner(tickEvents, tickMs);

    // (g) Broadcast ONE snapshot per tick (presentation layer).
    if (opts.broadcast !== undefined) {
      await opts.broadcast(tickMs);
    }

    driven += 1;

    // Wall-clock pause between ticks (presentation-layer only).
    if (driven < ticks.length && intervalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { ticks: driven };
}

/**
 * SIM-04: Inject a scenario at the current sim-clock head (FIX F).
 *
 * FIX F: The PREVIOUS implementation called `simulate(seed, durationTicks)`
 * where `durationTicks = reoptTicks` (e.g. 5), generating a tiny 5-tick
 * stream from tick 0. That stream overlapped with the already-stored baseline
 * events, causing OCC conflicts and duplicate event appends when `appendToStream`
 * tried to append to streams that already existed at version N > 0.
 *
 * CORRECT APPROACH: drive only the scenario-DELTA events — events that exist in
 * the modified stream but NOT in the base stream. The delta consists of events
 * added by the scenario knobs (e.g., extra `PackageCreated` from `demandSpike`,
 * extra `TrailerDocked` from `hubCongestion`). After injecting the delta events
 * the optimizer runs ONE epoch over the updated twin, producing visible re-opt
 * output at `GET /optimizer/recommendations`.
 *
 * Knobs that SHIFT timestamps (`tripDelay`) or DROP events (`sensorNoise`) do
 * NOT add new events to the store — they affect future planning context only.
 * The optimizer re-reads the twin (which includes the baseline-already-stored
 * events) and re-plans; the shift/drop knobs are thus reflected in the
 * scenario metadata but don't change the stored event stream.
 *
 * Determinism: same `seed + scenarioSeed + knobs` ⇒ same delta events.
 */
export async function driveSimulationWithScenario(
  opts: DriveSimulationWithScenarioOptions,
): Promise<{ ticks: number }> {
  // 1. Generate the FULL base stream (using the same seed + the TOTAL ticks
  //    that the baseline sim was driven for). Use `durationTicks` as the
  //    full-stream window so delta events land within the same epoch window.
  const baseStream = simulate({
    seed: opts.seed,
    durationTicks: opts.durationTicks,
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
  });

  // 2. Apply the scenario knobs (seeded, deterministic).
  const scenarioSeed = opts.scenarioSeed ?? (opts.seed ^ 0x5c4e);
  const rng = makeRng(scenarioSeed);
  const modifiedStream = applyScenario(baseStream, opts.scenario, rng);

  // 3. Compute the DELTA: events in modifiedStream not present in baseStream.
  //    Identity: streamId + type + occurredAt (stable signature for scenario
  //    -injected events; scenario knobs only ADD with new streamIds or new
  //    timestamps, never mutate existing event payloads in-place).
  const baseKeys = new Set<string>();
  for (const e of baseStream) {
    baseKeys.add(`${e.streamId}::${e.event.type}::${e.occurredAt}`);
  }
  const deltaEvents: SimulatedEvent[] = modifiedStream.filter((e) => {
    const key = `${e.streamId}::${e.event.type}::${e.occurredAt}`;
    return !baseKeys.has(key);
  });

  // Determine the sim-clock head AFTER the full baseline run. We advance it
  // by 60s so the post-scenario optimizer epoch gets a NEW epochId distinct
  // from all baseline epochs. Deterministic: same scenario → same offset.
  const lastBaseEvent = baseStream[baseStream.length - 1];
  const baseHeadMs = lastBaseEvent !== undefined
    ? new Date(lastBaseEvent.occurredAt).getTime()
    : 0;
  const scenarioEpochMs = baseHeadMs + 60_000; // +1 min in sim time → new epochId

  // 4. If no new events (e.g. sensorNoise/tripDelay only — no additive delta),
  //    still run ONE optimizer epoch with the advanced clock so the caller sees
  //    a fresh result with a NEW epochId at `GET /optimizer/recommendations`.
  if (deltaEvents.length === 0) {
    if (opts.loop !== undefined) {
      await opts.loop.tick({ events: [], simMs: scenarioEpochMs });
    }
    if (opts.broadcast !== undefined) {
      await opts.broadcast(scenarioEpochMs);
    }
    return { ticks: 0 };
  }

  // 5. Drive ONLY the delta events: append them to the store + fold projections.
  //    Since delta events use NEW streamIds (e.g. `package-SPIKE-*`) they will
  //    NOT OCC-conflict with the baseline streams.
  const deltaTicks = intoTicks(deltaEvents);

  if (deltaTicks.length > 0) {
    // Drive the delta ticks WITHOUT the optimizer (no loop) — we don't want
    // the old-epoch optimizer tick from within `driveTickStream`. The dedicated
    // optimizer tick below uses the advanced scenarioEpochMs for a new epochId.
    const deltaOpts: Pick<DriveSimulationOptions, "rfid" | "detection" | "broadcast" | "loop"> = {
      broadcast: undefined, // broadcast happens below at scenarioEpochMs
      // copy optional opts only when defined (exactOptionalPropertyTypes)
      ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
      ...(opts.detection !== undefined ? { detection: opts.detection } : {}),
    };
    await driveTickStream(opts.db, deltaTicks, deltaOpts, modifiedStream);
  }

  // 6. Run ONE dedicated optimizer epoch at the advanced scenario clock.
  //    This guarantees: (a) the optimizer sees the delta events in the twin
  //    (projections were folded above), and (b) the epochId is new/unique
  //    (simMs is 60s beyond the baseline end → nowMin is distinct).
  if (opts.loop !== undefined) {
    // Pass the delta events so scope detection picks up the new packages/hubs.
    const deltaEvts = deltaEvents.map((e) => e.event);
    await opts.loop.tick({ events: deltaEvts, simMs: scenarioEpochMs });
  }

  // 7. Broadcast one tick at the scenario epoch clock (so ws clients see the change).
  if (opts.broadcast !== undefined) {
    await opts.broadcast(scenarioEpochMs);
  }

  return { ticks: deltaTicks.length };
}

// ---------------------------------------------------------------------------
// Private: detector port binder
// ---------------------------------------------------------------------------

/**
 * Bind the detector's `DetectorReads` port to the live store + projections. The
 * PLANNED dest hub comes from the injected stream index (not a projection), and
 * the departed-hub gate is the EXACT set of `TrailerDeparted.fromHubId`s seen so
 * far — tightening the MVP in_transit inference with zero change to the detector
 * core. The append is the OCC-safe `appendWithRetry`, so detection writing
 * alongside the sim converges safely (T-03-17).
 */
function detectorReads(
  db: ApiDb,
  es: Kysely<Database>,
  destHub: ReadonlyMap<string, string>,
  departedHubs: ReadonlySet<string>,
): DetectorReads {
  const base = makeProjectionReads(projectionView(db), {
    readDestHub: (id) => destHub.get(id),
    append: (streamId, build, occurredAt) =>
      appendWithRetry(es, streamId, build, occurredAt),
  });
  // Override the departed-hub port with the EXACT just-departed stops (DIP).
  return { ...base, readDepartedHubs: () => Promise.resolve([...departedHubs]) };
}
