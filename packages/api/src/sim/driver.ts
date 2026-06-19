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
import type { RollingLoop } from "../optimizer/live-loop.js";

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
 * SIM-04: Run the demo simulation with a scenario injection.
 *
 * The `scenario` knobs are applied to the deterministic base stream via
 * `applyScenario` (seeded, deterministic) before driving the modified stream
 * into the store + projections. The `loop` (rolling optimizer) is triggered
 * per tick on the modified stream — the knob change ⇒ scoped re-optimization
 * visible end-to-end on the live path (GET /optimizer/recommendations).
 *
 * Determinism: same `seed + scenarioSeed + knobs` ⇒ byte-identical stream.
 */
export async function driveSimulationWithScenario(
  opts: DriveSimulationWithScenarioOptions,
): Promise<{ ticks: number }> {
  // 1. Generate the base deterministic stream.
  const baseStream = simulate({
    seed: opts.seed,
    durationTicks: opts.durationTicks,
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
  });

  // 2. Apply the scenario knobs using the dedicated scenario seed (separate
  //    from the sim seed so the base stream is unperturbed — determinism).
  // The XOR salt 0x5c4e is arbitrary but stable across runs.
  const scenarioSeed = opts.scenarioSeed ?? (opts.seed ^ 0x5c4e);
  const rng = makeRng(scenarioSeed);
  const modifiedStream = applyScenario(baseStream, opts.scenario, rng);

  // 3. Drive the modified stream.
  const ticks = intoTicks(modifiedStream);
  return driveTickStream(opts.db, ticks, opts, modifiedStream);
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
