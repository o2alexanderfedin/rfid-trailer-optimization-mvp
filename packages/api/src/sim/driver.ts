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
  runToHorizon,
  simulate,
  type ScenarioKnobs,
  type SimContinuation,
  type SimStart,
  type SimulatedEvent,
  type TimingConfig,
} from "@mm/simulation";
import { makeRng } from "@mm/simulation";
import { pruneEventLog, ageStaleProjections, type RetentionConfig } from "./retention.js";
import type { DomainEvent, FuelConfig, HosConfig } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";
import type { Kysely } from "kysely";
import { performance } from "node:perf_hooks";
import type { ApiDb } from "../routes/queries.js";
import { PRODUCTION_DETECTION_CONFIG } from "../detection-config.js";
import type { Broadcast } from "../ws/snapshots.js";
import type { InductionEvent } from "../ws/envelope.js";
import { computeSimAdvanceMs, selectDrain } from "./pacing.js";
import { makeCoalescedRunner } from "./coalesced-runner.js";

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
    return (): Promise<EpochResult | undefined> => Promise.resolve(undefined);
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
   * F-07 / SNS-05: OPT-IN over-carry rate ∈ [0,1]. Threaded into `simulate` only
   * when DEFINED — so the live demo can model a missed-unload (a package destined
   * for a spoke still aboard a trailer that has departed the spoke), which the
   * UNCHANGED detector then catches. The driver's existing `departedHubs` /
   * `destHubIndex` plumbing carries the spoke-origin departure through the SNS-05
   * gate with zero detector change. Absent ⇒ the golden stream is byte-identical.
   */
  readonly overCarry?: number;
  /**
   * DIP: override the seeded log-normal DWELL/TRANSIT distributions passed to
   * `simulate`. When ABSENT the engine uses realistic geography-derived per-leg
   * transit (TIME-01 default). Pass {@link DEFAULT_TIMING_CONFIG} to restore flat
   * ~30-min transit — the right choice for lifecycle/projection integration tests
   * that drive short horizons and must see trailers dock.
   */
  readonly timing?: TimingConfig;
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
  /**
   * SIM-HOS-01/02/03/05 (Phase 18 live wiring): OPT-IN driver Hours-of-Service
   * modeling. When `true` the engine seeds drivers, assigns them per trip,
   * accrues driving minutes, parks/relays on a breach, and emits driver +
   * load/unload phase events — so `driver_status` is populated and the Hub Detail
   * panel + ws driver buckets carry real duty data.
   *
   * DEFAULT FALSE / ABSENT (the determinism keystone): the engine emits NO driver
   * events and makes ZERO `hosRng` draws ⇒ the stream is byte-identical to the
   * pre-v1.2 golden. The unit determinism goldens pass this OFF explicitly and
   * MUST stay byte-identical — only the LIVE runnable demo (`main.ts`) turns it on.
   */
  readonly hosEnabled?: boolean;
  /**
   * DIP: override the FMCSA HOS limits. Only consulted when `hosEnabled` is
   * `true`; the engine defaults to `DEFAULT_HOS_CONFIG`. Pass the same config
   * across runs for a byte-identical HOS-on stream.
   */
  readonly hosConfig?: HosConfig;
  /**
   * Demo richness knob: trailers (and one primary driver each) PER SPOKE.
   * Default 1 (byte-identical golden stream); the live demo raises it to put more
   * trucks on the map at once. Threaded straight through to `simulate`.
   */
  readonly fleetPerSpoke?: number;
  /**
   * SP2 (spec §5): OPT-IN fuel/refuel modeling, threaded straight to `simulate`
   * only when DEFINED. Absent ⇒ the golden stream is byte-identical (the engine
   * default is fuel-off). The live demo passes `{ ...DEFAULT_FUEL_CONFIG,
   * enabled: FUEL_ENABLED }` so trucks visibly rest + refuel mid-route.
   */
  readonly fuel?: FuelConfig;
}

/**
 * Options for the paced live-demo driver — the FIXED-CADENCE ACCUMULATOR
 * (spec §4). Same as {@link DriveSimulationOptions} but adds the wall-clock
 * frame cadence, the per-frame drain budget, and a LIVE speed-multiplier source.
 *
 * DETERMINISM GUARANTEE: `frameMs` / `maxTicksPerFrame` / `getMultiplier` /
 * `isPaused` are PRESENTATION pacing only. They drive `setTimeout` cadence + how
 * far the `simClock` advances per frame; they NEVER enter the sim engine, the
 * event store, or the optimizer epoch clock. The sim stream is still generated
 * deterministically (same seed → same events) — only the *delivery rate* and
 * *batching* are wall-clock.
 */
export interface DriveSimulationPacedOptions extends DriveSimulationOptions {
  /**
   * Fixed wall-clock frame cadence in ms (chained `setTimeout`, NEVER
   * `setInterval` — measured delta avoids drift). Default 250. Each frame
   * advances `simClock` by `measuredWallDelta × 120 × multiplier` and drains all
   * pre-baked ticks with `occurredAt ≤ simClock` (bounded by the budget).
   */
  readonly frameMs?: number;
  /**
   * Per-frame drain budget (>= 1). Default 32. When a frame would drain more
   * than this, only the budget drains, `simClock` is clamped to the last drained
   * tick, and the remainder carries to the next frame — bounding DB work/frame
   * and yielding to the event loop. The effective max speed self-limits
   * gracefully at saturation instead of freezing (spec §4 backpressure).
   */
  readonly maxTicksPerFrame?: number;
  /**
   * LIVE speed-multiplier source, read FRESH each frame so a mid-run retune (via
   * the SpeedController) takes effect on the very next frame. Preferred pacing
   * primitive. Absent ⇒ 1× (120 sim-ms per wall-ms). Presentation only — never
   * fed into the sim engine (DETERMINISM CONTRACT).
   */
  readonly getMultiplier?: () => number;
  /**
   * LIVE pause source, read FRESH each frame. While it returns `true` the frame
   * advances `simClock` by 0 (multiplier treated as 0) so NO tick drains — the
   * demo freezes without affecting the deterministic event stream. Presentation
   * only.
   */
  readonly isPaused?: () => boolean;
  /**
   * Trigger the rolling optimizer every Nth DRAINED tick instead of every tick
   * (a sim-time landmark cadence). **Default 1**. The optimizer is fired
   * NON-blocking via the single-flight/dirty coalescer, so a richer/faster demo
   * is never blocked by per-tick optimization. The intervening ticks' events are
   * batched and handed to the coalescer at the landmark. Pure presentation/
   * throughput pacing — the deterministic event STREAM is untouched.
   */
  readonly optimizerEveryTicks?: number;
}

/** Default fixed wall-clock frame cadence (ms). */
const DEFAULT_FRAME_MS = 250;
/** Default per-frame drain budget. */
// Drain budget per frame. Kept LOW (not the 64×-at-250ms throughput max) on
// purpose: at a large fleet the per-frame fold cost dominates, so the TOTAL work
// to play the stream is ~framing-independent — a smaller budget just redistributes
// that work across MORE frames, i.e. more WS deltas (better map responsiveness;
// the OpenLayers client tweens continuously between keyframes) at ~the same total
// cost. selectDrain clamps simClock down when capped, so this also self-limits the
// effective top speed gracefully instead of leaping the whole stream in one frame.
const DEFAULT_MAX_TICKS_PER_FRAME = 4;
/** The 1× wall-clock baseline interval — the accumulator advance denominator. */
const DEFAULT_INTERVAL_MS = 500;
/** Sim-ms advanced per tick (= the engine's MS_PER_TICK). */
const MS_PER_TICK = 60_000;

/** Promise-based sleep helper (frame cadence — presentation pacing only). */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

/**
 * VIZ-13: map the `PackageInducted` events in a drained tick/frame into transient
 * `InductionEvent` wire items for the tick payload. Empty when the slice has no
 * inductions (the common case) — the broadcast then omits the field entirely.
 */
function collectInductions(
  items: readonly SimulatedEvent[],
): InductionEvent[] {
  const out: InductionEvent[] = [];
  for (const { event } of items) {
    if (event.type !== "PackageInducted") continue;
    out.push({
      packageId: event.payload.packageId,
      inductionHubId: event.payload.inductionHubId,
      destHubId: event.payload.destHubId,
      slaClass: event.payload.slaClass,
      slaDeadlineIso: event.payload.slaDeadlineIso,
      occurredAt: event.payload.occurredAt,
    });
  }
  return out;
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

// Plan 19-08: the open-ended driver no longer pre-builds a per-chunk dest-hub
// index. It maintains `destHub` incrementally — adding on `PackageCreated` and
// PRUNING on `PackageArrivedAtHub` — so the index stays bounded to in-flight
// packages, not the run-length total. (See `appendTick` in driveSimulationOpenEnded.)

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
    //    as the authoritative sim-clock milliseconds for the ws envelope, plus the
    //    tick's transient induction events (VIZ-13).
    if (opts.broadcast !== undefined) {
      await opts.broadcast(tickMs, collectInductions(tick));
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
    ...(opts.overCarry !== undefined ? { overCarry: opts.overCarry } : {}),
    ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
    ...(opts.hosEnabled !== undefined ? { hosEnabled: opts.hosEnabled } : {}),
    ...(opts.hosConfig !== undefined ? { hosConfig: opts.hosConfig } : {}),
    ...(opts.fleetPerSpoke !== undefined ? { fleetPerSpoke: opts.fleetPerSpoke } : {}),
    ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
  });
  const ticks = intoTicks(stream);
  return driveTickStream(opts.db, ticks, opts, stream);
}

/**
 * Drive the simulation LIVE via a FIXED-CADENCE ACCUMULATOR (spec §4).
 *
 * The previous driver delivered one pre-baked tick per `setTimeout(interval)`
 * and shrank the interval to speed up — coupling cadence to speed, so per-tick
 * work (DB append + projection + a periodically BLOCKING optimizer) starved the
 * loop at high speed/fleet (the freeze). This driver inverts that coupling:
 *
 *   - a fixed wall-clock FRAME (`frameMs`, chained `setTimeout` + measured
 *     `performance.now()` delta — never `setInterval`);
 *   - each frame advances a `simClock` by `wallDelta × 120 × multiplier`
 *     (pure `computeSimAdvanceMs`), then DRAINS every pre-baked tick with
 *     `occurredAt ≤ simClock` as ONE batch, bounded by `maxTicksPerFrame`
 *     (pure `selectDrain`), carrying any remainder to the next frame;
 *   - the optimizer is fired NON-blocking through a single-flight/dirty
 *     coalescer, so its CPU never stalls the playback loop;
 *   - exactly ONE ws delta is broadcast per frame (so `simMs`/speed envelopes
 *     keep flowing for the client clock even when no tick drains, e.g. paused).
 *
 * DETERMINISM CONTRACT: the sim stream is generated once, deterministically
 * (same seed → same events in the same order). `frameMs` / `maxTicksPerFrame` /
 * the multiplier / pause are PRESENTATION pacing — they shape cadence + batching
 * only and NEVER enter the sim engine, the event store OCC path, or the
 * optimizer epoch clock (the per-tick `simMs` handed to the optimizer is the
 * deterministic `occurredAt`, not the accumulator's `simClock`).
 *
 * Resolves `{ ticks }` (the count of drained ticks == source tick count) once
 * the whole stream has drained and the coalescer has gone idle.
 */
export async function driveSimulationPaced(
  opts: DriveSimulationPacedOptions,
): Promise<{ ticks: number }> {
  const stream = simulate({
    seed: opts.seed,
    durationTicks: opts.durationTicks,
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
    ...(opts.overCarry !== undefined ? { overCarry: opts.overCarry } : {}),
    ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
    ...(opts.hosEnabled !== undefined ? { hosEnabled: opts.hosEnabled } : {}),
    ...(opts.hosConfig !== undefined ? { hosConfig: opts.hosConfig } : {}),
    ...(opts.fleetPerSpoke !== undefined ? { fleetPerSpoke: opts.fleetPerSpoke } : {}),
    ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
  });
  const ticks = intoTicks(stream);
  // Precompute each tick's DETERMINISTIC sim time (the first event's occurredAt).
  const tickTimesMs = ticks.map((tick) => new Date(tick[0]!.occurredAt).getTime());

  // Per-tick I/O state — accumulates across ALL ticks (never reset per tick):
  //   cursor (event-log position) + departedHubs (SNS-05 gate). The optimizer is
  //   fired non-blocking via the coalescer over the per-tick runner.
  const es = eventStoreView(opts.db);
  const coalescer = makeCoalescedRunner(makeSimRunner({ loop: opts.loop }));

  const detectionOn = opts.rfid !== undefined;
  const detectionConfig = opts.detection ?? PRODUCTION_DETECTION_CONFIG;
  const destHub = detectionOn ? destHubIndex(stream) : new Map<string, string>();
  const departedHubs = new Set<string>();
  let cursor = 0n;

  /**
   * (a)+(b): append ONE tick's events (OCC-safe per stream, with the tick's own
   * domain `occurredAt`) and track departed hubs for the SNS-05 gate (accumulates
   * across ticks). Appends MUST stay per-tick: `appendToStream` stamps a single
   * `occurred_at` on the whole call, and each tick is a distinct domain timestamp,
   * so coalescing appends across ticks would corrupt domain time (geo-track/audit).
   */
  async function appendTick(tick: SimulatedEvent[]): Promise<void> {
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

    if (detectionOn) {
      for (const item of tick) {
        if (item.event.type === "TrailerDeparted") {
          departedHubs.add(item.event.payload.fromHubId);
        }
      }
    }
  }

  /**
   * (c)+(d)+(e): the heavy DB folds, run ONCE per FRAME over every event appended
   * since `cursor` (spec §4 — "project once"). Folding `readAll(cursor)` in one
   * pass is identical in effect to folding each tick separately (applyInline is a
   * per-event, order-preserving reducer), but collapses the per-tick projection
   * transaction + detection + catch-up — the dominant per-tick cost — to once per
   * frame, which is what unsticks broadcast density at high speed / large fleets.
   * `driveTickStream` (the synchronous, non-paced path) is unchanged.
   */
  async function foldFrame(): Promise<void> {
    // (c) Inline projection (read-your-writes) over the whole frame's events.
    const fresh = await readAll(es, cursor);
    if (fresh.length > 0) {
      await opts.db.transaction().execute(async (trx) => {
        const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
        for (const ev of fresh) await applyInline(proj, ev);
      });
      cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    // (d) Detection once over the frame's folded state (PLANNED vs OBSERVED).
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

    // (e) Catch-up projections (audit timeline + geo-track) once per frame.
    await runCatchup(catchupView(opts.db), replayReadAll);
  }

  // ---- Accumulator frame loop -----------------------------------------------
  const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  const maxTicksPerFrame = Math.max(1, Math.floor(opts.maxTicksPerFrame ?? DEFAULT_MAX_TICKS_PER_FRAME));
  const optEvery = Math.max(1, Math.floor(opts.optimizerEveryTicks ?? 1));

  // simClock lives in the ticks' ABSOLUTE timeline (Unix-epoch ms): seed it 1ms
  // BEFORE the first tick so NO tick is due until the first frame's advance moves
  // it forward (so a paused/zero-advance first frame drains nothing). The advance
  // amount is purely a function of wall-delta × speed; the ORIGIN is the stream's
  // start so `occurredAt ≤ simClock` is meaningful in the same timeline.
  let simClock = tickTimesMs.length > 0 ? tickTimesMs[0]! - 1 : 0;
  let nextIndex = 0; // first undrained tick
  let lastWall = performance.now();
  // Optimizer landmark batching: collect drained ticks' events, fire every
  // `optEvery` drained ticks (and once more after the last tick drains).
  let ticksSinceOpt = 0;
  let pendingOptEvents: SimulatedEvent["event"][] = [];
  let lastOptTickMs = 0;
  // VIZ-13: induction events drained this frame, surfaced to the per-frame
  // broadcast (read + cleared at the broadcast site).
  let pendingInductions: InductionEvent[] = [];

  // Process exactly the ticks selected for THIS frame (in order): append each
  // tick (per-tick `occurredAt`), then fold the whole batch ONCE, then fire the
  // coalesced optimizer landmark. Returns the simMs to broadcast for the frame.
  async function drainFrame(count: number, clampSimClock: number): Promise<number> {
    if (count === 0) return clampSimClock;
    let broadcastSimMs = clampSimClock;
    // (a)+(b) append every drained tick (per-tick); collect the optimizer batch.
    for (let k = 0; k < count; k += 1) {
      const idx = nextIndex;
      const tick = ticks[idx]!;
      const tickMs = tickTimesMs[idx]!;
      await appendTick(tick);
      for (const item of tick) pendingOptEvents.push(item.event);
      pendingInductions.push(...collectInductions(tick));
      lastOptTickMs = tickMs;
      broadcastSimMs = tickMs;
      nextIndex += 1;
    }

    // (c)+(d)+(e) ONE batched fold/detection/catch-up over the whole frame.
    await foldFrame();

    // Optimizer landmark (sim-time cadence): fire NON-blocking AFTER the fold (so
    // the snapshot reflects the frame) every `optEvery` drained ticks, and once
    // more after the final tick of the stream drains.
    ticksSinceOpt += count;
    const lastDrained = nextIndex >= ticks.length;
    if (ticksSinceOpt >= optEvery || lastDrained) {
      coalescer.trigger(pendingOptEvents, lastOptTickMs);
      pendingOptEvents = [];
      ticksSinceOpt = 0;
    }

    return broadcastSimMs;
  }

  // Drain the whole stream, one fixed wall-clock frame at a time.
  while (nextIndex < ticks.length) {
    await sleep(frameMs);

    const now = performance.now();
    const wallDeltaMs = now - lastWall;
    lastWall = now;

    // Read the live speed FRESH each frame; pause ⇒ treat multiplier as 0 so the
    // simClock freezes (no drain). Presentation only — never reaches `simulate`.
    const paused = opts.isPaused?.() === true;
    const multiplier = paused ? 0 : (opts.getMultiplier?.() ?? 1);

    simClock += computeSimAdvanceMs({
      wallDeltaMs,
      multiplier,
      msPerTick: MS_PER_TICK,
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
    });

    const { count, clampSimClock } = selectDrain({
      tickTimesMs,
      nextIndex,
      simClock,
      maxTicks: maxTicksPerFrame,
    });
    simClock = clampSimClock;

    const broadcastSimMs = await drainFrame(count, simClock);

    // ONE delta per FRAME — even when nothing drained — so the client clock /
    // speed envelope keeps flowing (e.g. pause reflects via simSpeed:0). Attach +
    // clear this frame's induction events (VIZ-13).
    if (opts.broadcast !== undefined) {
      const frameInductions = pendingInductions;
      pendingInductions = [];
      await opts.broadcast(broadcastSimMs, frameInductions);
    }
  }

  // Drain the coalesced optimizer to idle, then a final broadcast at the clock.
  await coalescer.whenIdle();
  if (opts.broadcast !== undefined) {
    await opts.broadcast(simClock, pendingInductions);
    pendingInductions = [];
  }

  return { ticks: nextIndex };
}

// ---------------------------------------------------------------------------
// CONT-01/02: open-ended (continuous) live driver
// ---------------------------------------------------------------------------

/**
 * Options for the OPEN-ENDED live driver (CONT-01/02) — the continuous-operation
 * variant of {@link driveSimulationPaced}. Reuses every pacing field; adds a
 * cooperative {@link DriveSimulationOpenEndedOptions.stopped} predicate read each
 * frame.
 *
 * DETERMINISM CONTRACT (inherited): pacing (`frameMs` / multiplier / pause /
 * `stopped`) is PRESENTATION only — it shapes cadence + batching and NEVER enters
 * the sim engine. The deterministic event STREAM is generated in finite chunks
 * (same seed → same events in the same order); only the *delivery rate* is
 * wall-clock. `durationTicks` here is the INITIAL chunk horizon, not a ceiling.
 */
export interface DriveSimulationOpenEndedOptions extends DriveSimulationPacedOptions {
  /**
   * Cooperative stop predicate, read FRESH each frame. While it returns `false`
   * the loop runs forever (continuous operation). Return `true` to terminate the
   * loop cleanly at the next frame boundary. ABSENT ⇒ runs until the process
   * exits. The composition root (`main.ts`) injects it so the demo can be stopped.
   */
  readonly stopped?: () => boolean;
  /**
   * Sim-tick horizon generated per chunk. **Default 500** (≈8.3 sim-hours). The
   * driver advances ONE {@link SimContinuation} by this many ticks on demand
   * (never pre-baking an infinite stream — Pitfall 1; never REgenerating the
   * prefix — Plan 19-08), extending the window only as the paced `simClock`
   * approaches the end of the current chunk. Larger ⇒ fewer (but bigger)
   * continuation steps; smaller ⇒ tighter memory bound.
   */
  readonly chunkTicks?: number;
  /**
   * Plan 19-08 Task C — OPT-IN bounded persisted retention for the continuous
   * path. When provided, the driver periodically prunes the Postgres `events` log
   * (rows safely below the projection watermark) and ages out stale projection
   * rows, so a genuinely indefinite run stays bounded END-TO-END (not just RAM).
   * ABSENT ⇒ retention OFF — the full log is retained (the finite/test path stays
   * replay-from-0 byte-identical, never reading a pruned log).
   */
  readonly retention?: RetentionConfig;
  /**
   * Testability hook (Plan 19-08 Task B): invoked once per frame with the current
   * BOUNDED working-set sizes — the retained (undrained) tick-window length and
   * the `destHub` index size. Lets a test assert the driver's RAM stays bounded by
   * ~the window, NOT by run length. Pure observation; no functional impact.
   */
  readonly onWindowState?: (state: {
    readonly retainedTicks: number;
    readonly destHubSize: number;
  }) => void;
}

/** Default per-chunk sim-tick horizon for the open-ended driver. */
const DEFAULT_CHUNK_TICKS = 500;

/**
 * Drive the simulation LIVE and OPEN-ENDED (CONT-01/02) — runs indefinitely until
 * the injected `stopped()` predicate fires (or the process exits).
 *
 * Contrast with {@link driveSimulationPaced}, which calls `simulate()` ONCE to
 * pre-bake the ENTIRE finite stream into `ticks[]` and drains it. That is
 * incompatible with an indefinite run (you cannot pre-bake an infinite stream —
 * it would OOM). Instead this driver generates the deterministic stream in finite
 * CHUNKS of `chunkTicks` (default 500) on demand: it extends a `horizonTick`
 * ceiling whenever the paced `simClock` nears the end of the already-generated
 * ticks, regenerating the deterministic stream up to the new horizon and driving
 * ONLY the newly-revealed ticks (the prefix is byte-identical by determinism, so
 * re-driving it is neither needed nor done).
 *
 * It reuses the EXACT pacing math (`computeSimAdvanceMs` + `selectDrain`), the
 * per-tick `appendTick`, the once-per-frame `foldFrame`, the non-blocking
 * coalesced optimizer, and the one-delta-per-frame broadcast from
 * `driveSimulationPaced` — so behaviour per drained tick is identical; only the
 * stream SOURCE (chunked + unbounded) and the loop TERMINATION (a `stopped()`
 * predicate instead of `nextIndex < ticks.length`) differ.
 *
 * Resolves `{ ticks }` (the count of drained ticks) once `stopped()` returns true
 * and the coalescer has gone idle.
 */
export async function driveSimulationOpenEnded(
  opts: DriveSimulationOpenEndedOptions,
): Promise<{ ticks: number }> {
  // The deterministic sim options threaded into the continuation core. The SAME
  // options + seed ⇒ a byte-identical stream, advanced one chunk at a time.
  const simFeatureOpts = {
    ...(opts.rfid !== undefined ? { rfid: opts.rfid } : {}),
    ...(opts.overCarry !== undefined ? { overCarry: opts.overCarry } : {}),
    ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
    ...(opts.hosEnabled !== undefined ? { hosEnabled: opts.hosEnabled } : {}),
    ...(opts.hosConfig !== undefined ? { hosConfig: opts.hosConfig } : {}),
    ...(opts.fleetPerSpoke !== undefined ? { fleetPerSpoke: opts.fleetPerSpoke } : {}),
    ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
  };
  const chunkTicks = Math.max(1, Math.floor(opts.chunkTicks ?? DEFAULT_CHUNK_TICKS));

  // Plan 19-08 Task B: ONE SimContinuation drives the run. We advance it by
  // `chunkTicks` per step and append ONLY the freshly-revealed ticks to a BOUNDED
  // sliding window — the prefix is NEVER regenerated (the O(n²) regen is gone) and
  // the window holds at most ~chunkTicks + a frame of undrained ticks.
  let continuation: SimContinuation | undefined;
  let horizonTick = 0;
  /** Advance the continuation by one chunk; return the newly-revealed per-tick groups. */
  function advanceOneChunk(): SimulatedEvent[][] {
    horizonTick += chunkTicks;
    const start: SimStart = continuation ?? { seed: opts.seed };
    const { events, continuation: next } = runToHorizon(start, horizonTick, simFeatureOpts);
    continuation = next;
    // `events` are ONLY this chunk's events (the prefix is held in the
    // continuation, not re-emitted), so grouping yields just the new ticks.
    return intoTicks(events);
  }

  // The BOUNDED sliding window of undrained ticks (index 0 = next to drain). When
  // ticks drain we splice them off the FRONT so this never grows with run length.
  const window: SimulatedEvent[][] = [];
  const windowTimesMs: number[] = [];
  function appendChunkToWindow(chunk: SimulatedEvent[][]): void {
    for (const tick of chunk) {
      window.push(tick);
      windowTimesMs.push(new Date(tick[0]!.occurredAt).getTime());
    }
  }

  const es = eventStoreView(opts.db);
  const coalescer = makeCoalescedRunner(makeSimRunner({ loop: opts.loop }));

  const detectionOn = opts.rfid !== undefined;
  const detectionConfig = opts.detection ?? PRODUCTION_DETECTION_CONFIG;
  // destHub maps the PLANNED destination hub per package. It is populated as
  // packages are revealed (PackageCreated) and PRUNED as they reach their
  // destination (PackageArrivedAtHub) — so it stays bounded to in-flight packages,
  // NOT the run-length total. (Only used when detection is on.)
  const destHub = new Map<string, string>();
  const departedHubs = new Set<string>();
  let cursor = 0n;

  /** Append ONE tick's events (OCC-safe per stream) + maintain bounded indices. */
  async function appendTick(tick: SimulatedEvent[]): Promise<void> {
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

    if (detectionOn) {
      for (const item of tick) {
        if (item.event.type === "PackageCreated") {
          // Reveal the package's planned destination hub.
          destHub.set(item.event.payload.packageId, item.event.payload.destHubId);
        } else if (item.event.type === "PackageArrivedAtHub") {
          // The package reached a hub — drop it from the in-flight index (prune).
          destHub.delete(item.event.payload.packageId);
        } else if (item.event.type === "TrailerDeparted") {
          departedHubs.add(item.event.payload.fromHubId);
        }
      }
    }
  }

  /** Once-per-frame heavy folds (inline projection + detection + catch-up). */
  async function foldFrame(): Promise<void> {
    const fresh = await readAll(es, cursor);
    if (fresh.length > 0) {
      await opts.db.transaction().execute(async (trx) => {
        const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
        for (const ev of fresh) await applyInline(proj, ev);
      });
      cursor = fresh[fresh.length - 1]!.globalSeq;
    }

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

    await runCatchup(catchupView(opts.db), replayReadAll);
  }

  // ---- Accumulator frame loop (open-ended) ----------------------------------
  const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  const maxTicksPerFrame = Math.max(
    1,
    Math.floor(opts.maxTicksPerFrame ?? DEFAULT_MAX_TICKS_PER_FRAME),
  );
  const optEvery = Math.max(1, Math.floor(opts.optimizerEveryTicks ?? 1));

  // Prime the window with the FIRST chunk (so the clock can seed off the first
  // tick). The continuation now holds the rest of the world — no prefix regen.
  appendChunkToWindow(advanceOneChunk());

  let simClock = windowTimesMs.length > 0 ? windowTimesMs[0]! - 1 : 0;
  let lastWall = performance.now();
  let ticksSinceOpt = 0;
  let pendingOptEvents: SimulatedEvent["event"][] = [];
  let lastOptTickMs = 0;
  let drainedTotal = 0;
  let lastRetentionAtCount = 0;
  // VIZ-13: induction events drained this frame, surfaced to the per-frame broadcast.
  let pendingInductions: InductionEvent[] = [];

  /**
   * Keep the undrained window long enough to feed a frame by advancing the
   * continuation (NOT regenerating the prefix). Each step reveals only the next
   * chunk's events. Memory stays bounded by ~chunk size, not by run duration.
   */
  function ensureWindow(): void {
    let guard = 0;
    while (window.length <= maxTicksPerFrame) {
      const before = window.length;
      appendChunkToWindow(advanceOneChunk());
      // Bail if the engine is genuinely exhausted (no new ticks for a long span).
      if (window.length === before) {
        guard += 1;
        if (guard > 1000) break;
      } else {
        guard = 0;
      }
    }
  }

  async function drainFrame(count: number, clampSimClock: number): Promise<number> {
    if (count === 0) return clampSimClock;
    let broadcastSimMs = clampSimClock;
    for (let k = 0; k < count; k += 1) {
      // Always drain the HEAD of the bounded window (index 0).
      const tick = window[0]!;
      const tickMs = windowTimesMs[0]!;
      await appendTick(tick);
      for (const item of tick) pendingOptEvents.push(item.event);
      pendingInductions.push(...collectInductions(tick));
      lastOptTickMs = tickMs;
      broadcastSimMs = tickMs;
      // Discard the drained tick from the front so RAM stays bounded.
      window.shift();
      windowTimesMs.shift();
      drainedTotal += 1;
    }

    await foldFrame();

    ticksSinceOpt += count;
    if (ticksSinceOpt >= optEvery) {
      coalescer.trigger(pendingOptEvents, lastOptTickMs);
      pendingOptEvents = [];
      ticksSinceOpt = 0;
    }

    return broadcastSimMs;
  }

  // Run forever until `stopped()` asks to halt (CONT-01).
  while (opts.stopped?.() !== true) {
    await sleep(frameMs);

    const now = performance.now();
    const wallDeltaMs = now - lastWall;
    lastWall = now;

    const paused = opts.isPaused?.() === true;
    const multiplier = paused ? 0 : (opts.getMultiplier?.() ?? 1);

    simClock += computeSimAdvanceMs({
      wallDeltaMs,
      multiplier,
      msPerTick: MS_PER_TICK,
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
    });

    // Keep the bounded window ahead of the clock (continuation-advanced).
    ensureWindow();

    // selectDrain over the window's RELATIVE timeline (index 0 = next to drain).
    const { count, clampSimClock } = selectDrain({
      tickTimesMs: windowTimesMs,
      nextIndex: 0,
      simClock,
      maxTicks: maxTicksPerFrame,
    });
    simClock = clampSimClock;

    const broadcastSimMs = await drainFrame(count, simClock);

    // Plan 19-08 Task C: bounded persisted retention (CONTINUOUS path ONLY). Prune
    // the event log below the projection watermark + age out stale projections on
    // the configured cadence. ABSENT ⇒ retention OFF (the full log is retained).
    if (opts.retention !== undefined) {
      const everyTicks = Math.max(1, opts.retention.everyTicks);
      if (drainedTotal - lastRetentionAtCount >= everyTicks) {
        lastRetentionAtCount = drainedTotal;
        await pruneEventLog(opts.db, opts.retention);
        await ageStaleProjections(opts.db, opts.retention, broadcastSimMs);
      }
    }

    // Testability: report the bounded working-set sizes once per frame.
    opts.onWindowState?.({ retainedTicks: window.length, destHubSize: destHub.size });

    if (opts.broadcast !== undefined) {
      const frameInductions = pendingInductions;
      pendingInductions = [];
      await opts.broadcast(broadcastSimMs, frameInductions);
    }
  }

  // Flush a final optimizer landmark for any undelivered batch, drain to idle,
  // then a final broadcast at the clock.
  if (pendingOptEvents.length > 0) {
    coalescer.trigger(pendingOptEvents, lastOptTickMs);
    pendingOptEvents = [];
  }
  await coalescer.whenIdle();
  if (opts.broadcast !== undefined) {
    await opts.broadcast(simClock, pendingInductions);
    pendingInductions = [];
  }

  return { ticks: drainedTotal };
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
    ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
    ...(opts.fleetPerSpoke !== undefined ? { fleetPerSpoke: opts.fleetPerSpoke } : {}),
    ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
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
