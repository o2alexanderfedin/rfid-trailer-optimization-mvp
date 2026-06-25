import type {
  DomainEvent,
  DriverAssignedToTrip,
  DriverDutyStateChanged,
  DriverRegistered,
  DriverSwappedAtHub,
  DutyStatus,
  FuelConfig,
  HosClock,
  HosConfig,
  Hub,
  LoadStarted,
  PackageArrivedAtHub,
  PackageCreated,
  PackageDelivered,
  PackageInducted,
  PackageScanned,
  SizeClass,
  SlaClass,
  TrailerArrivedAtHub,
  TrailerDeparted,
  TrailerDocked,
  TruckRefueled,
  TruckRested,
  UnloadCompleted,
  UnloadStarted,
} from "@mm/domain";
import {
  DEFAULT_FUEL_CONFIG,
  DEFAULT_HOS_CONFIG,
  applyDrivingLeg,
  epochMinutesToIso,
  expectedDwellMinutes,
  expectedTransitMinutes,
  haversineKm,
  isoToEpochMinutes,
  mayDriveNow,
  remainingLegalDriveMinutes,
} from "@mm/domain";
import { USA_HUBS, hubRegisteredEvent } from "./network/hubs.js";
import {
  buildRoutes,
  buildTransitParamsByLeg,
  loadStaticRoadGeometry,
  routeId,
} from "./network/routes.js";
import { makeRng, makeRngFromState, type Rng } from "./rng.js";
import { EPOCH_ISO, MS_PER_TICK } from "./epoch.js";
import {
  isContinuation,
  type SerializedHosClock,
  type SerializedScheduled,
  type SerializedWorldState,
  type SimContinuation,
  type SimStart,
  type SimTask,
} from "./continuation.js";
import { VirtualClock } from "./clock.js";
import { emitRfidReads, resolveRfidConfig, type RfidSimConfig } from "./rfid.js";
import { DEFAULT_TIMING_CONFIG, sampleLogNormal, type TimingConfig } from "./timing.js";

/**
 * SIM-02: the seeded, deterministic tick/event-queue engine.
 *
 * Two surfaces over ONE generation core (`generate`):
 *  - `simulate(opts): SimulatedEvent[]` — a pure generator (no DB) used by the
 *    determinism/golden tests; same seed -> byte-identical array.
 *  - `runSimulation(opts)` — drives that same stream into an injected `sink`
 *    (e.g. `appendToStream` + inline projections). Because both call `generate`,
 *    the in-memory and persisted streams cannot diverge.
 *
 * Determinism contract (threat T-01-15): ALL randomness comes from `makeRng`,
 * ALL time from `VirtualClock`. There is NO `Date.now()` and NO unseeded
 * `Math.random()` anywhere in this module. The event queue is a min-heap-free
 * stable sort keyed by `(fireTick, insertionSeq)`, so ties break deterministically.
 */

// --- Seeded RNG substream salts ---------------------------------------------
//
// Each opt-in feature draws from its OWN seeded substream (`seed XOR salt`) so
// enabling one never perturbs the others — the byte-identical-replay keystone.
// The salts are exported (not just inlined) so a salt-collision assertion test
// can prove the five are pairwise distinct without re-typing the literals.

/** SIM-03 RFID substream salt (verified existing constant). */
export const RFID_RNG_SALT = 0x5f_1d_a7_c3;
/** F-07 over-carry substream salt (verified existing constant). */
export const OVER_CARRY_RNG_SALT = 0x3c_a7_1d_5f;
/** DIP timing (dwell/transit) substream salt (verified existing constant). */
export const TIMING_RNG_SALT = 0x00_00_77_17;
/**
 * SIM-HOS-01: the FIFTH substream salt for driver Hours-of-Service draws. A NEW,
 * DISTINCT constant (asserted non-colliding with the three above) so enabling
 * HOS never perturbs `rng`/`rfidRng`/`overCarryRng`/`timingRng`. Same seed +
 * same `HosConfig` ⇒ byte-identical HOS stream.
 */
export const HOS_RNG_SALT = 0x10_51_09_01;
/**
 * SP2 (spec §5): the SIXTH substream salt for fuel/refuel draws. A NEW, DISTINCT
 * constant (the salt-collision test asserts it differs from the five above) so
 * enabling fuel never perturbs `rng`/`rfidRng`/`overCarryRng`/`timingRng`/`hosRng`.
 * The `fuelRng` it seeds is constructed ONLY when `fuel.enabled` — so a fuel-off
 * run draws ZERO fuel values and stays byte-identical to the golden. The current
 * tank model is fully deterministic (no jitter), so `fuelRng` is reserved for any
 * future refuel-time jitter; it is wired through the same seed-XOR discipline now
 * so adding a draw later cannot perturb the other five streams.
 */
export const FUEL_RNG_SALT = 0x2b_3d_91_e7;
/**
 * v2.0 IND-02: the SEVENTH substream salt, for external-induction draws. A NEW,
 * DISTINCT, well-separated constant (the salt-collision test asserts it differs
 * from all six above — hash-split, NOT `seed+1`) so inducted packages never
 * perturb any prior stream. The `inductionRng` it seeds is constructed ONLY when
 * `inductionEnabled` — so an induction-off run draws ZERO induction values and
 * stays byte-identical to the golden (the determinism keystone).
 */
export const INDUCTION_RNG_SALT = 0x8f_2c_4a_e1;

/**
 * Phase-22 OUT-01: the EIGHTH substream salt, for outbound-delivery dwell draws.
 * A NEW, DISTINCT, well-separated constant (the salt-collision test asserts it
 * differs from all seven above — hash-split, NOT `seed+1`) so delivered packages
 * never perturb any prior stream. The `outboundRng` it seeds is constructed ONLY
 * when `outboundDeliveryEnabled === true` — so an outbound-off run draws ZERO
 * outbound values and stays byte-identical to the golden (the determinism keystone).
 */
export const OUTBOUND_RNG_SALT = 0xc4_f8_32_b6;

// --- Public types -----------------------------------------------------------

/** One emitted event, ready to persist: which stream, the event, its domain time. */
export interface SimulatedEvent {
  /** Target stream id (`hub-…`, `route-…`, `package-…`, `trailer-…`). */
  readonly streamId: string;
  /** The typed, validatable domain event. */
  readonly event: DomainEvent;
  /** Domain time from the virtual clock (ISO-8601) — never the wall clock. */
  readonly occurredAt: string;
}

/**
 * CONT-05 (P2): sort-wave / cut-off cadence config. When supplied on
 * {@link SimulateOptions.sortWave}, freight is created in burst-quiet-burst
 * windows (a "sort wave") rather than a steady trickle — observable on the live
 * map as departure surges. The window is PURE modular arithmetic on the
 * deterministic tick clock (no RNG salt), so it is fully reproducible.
 */
export interface SortWaveConfig {
  /** Ticks at the START of each cycle during which packages ARE created (burst). */
  readonly burstWindowTicks: number;
  /** Ticks after the burst during which NO packages are created (quiet). */
  readonly quietWindowTicks: number;
  /** Packages created per batch tick while inside the burst window. */
  readonly burstPackagesPerBatch: number;
}

/** Options for the pure generator. */
export interface SimulateOptions {
  /** PRNG seed — same seed yields a byte-identical stream. */
  readonly seed: number;
  /** Number of ticks to simulate (1 tick = {@link MS_PER_TICK} domain ms). */
  readonly durationTicks: number;
  /**
   * SIM-03: OPT-IN probabilistic RFID emission. When present, the engine emits
   * `RfidObserved` at dock-door portals (on load) and trailer antennas (during
   * dwell), with seeded drops + jitter. When ABSENT, the stream is the exact
   * pre-Phase-3 (non-RFID) golden stream — so existing determinism tests stay
   * byte-identical. Partial: unspecified knobs fall back to {@link DEFAULT_RFID_CONFIG}.
   */
  readonly rfid?: Partial<RfidSimConfig>;
  /**
   * F-07 / SNS-05: OPT-IN over-carry rate ∈ [0,1]. When present and > 0, at a
   * spoke arrival the engine holds back AT MOST ONE carried package (a draw
   * against this rate), unloads the rest, then emits a SPOKE-ORIGIN
   * `TrailerDeparted` (fromHubId=spoke, toHubId=center) carrying the held-back
   * package — so a package destined for the spoke is STILL aboard a trailer that
   * has departed the spoke (the SNS-05 missed-unload gate). When RFID is on, a
   * portal read positively observes the held-back package aboard the return leg
   * so the fusion layer clears the calibrated detection gate. A return arrival at
   * the center unloads it (no SLA/utilization skew at the spoke).
   *
   * OFF BY DEFAULT: absent (or 0) ⇒ the stream is byte-identical to the golden.
   * ALL randomness flows through a SEPARATE seeded substream (seed XOR a salt
   * DISTINCT from the RFID salt) so enabling it never perturbs `rng`/`rfidRng`.
   */
  readonly overCarry?: number;
  /**
   * DIP: override the seeded log-normal DWELL/TRANSIT distributions. When absent
   * the engine uses {@link DEFAULT_TIMING_CONFIG}. ALL timing draws flow through a
   * DEDICATED seeded substream (seed XOR a salt distinct from RFID/over-carry) so
   * timing variance never perturbs those streams; the result is still fully
   * reproducible per seed (same seed + same config ⇒ byte-identical timestamps).
   */
  readonly timing?: TimingConfig;
  /**
   * SIM-HOS-01/02/03/05: OPT-IN driver Hours-of-Service modeling. **DEFAULT
   * FALSE** — the determinism keystone. When absent or `false`, the engine emits
   * NO driver events, NO HOS breaks/rests, NO load/unload phase events, and makes
   * ZERO `hosRng` draws ⇒ the stream is BYTE-IDENTICAL to the pre-v1.2 golden
   * (the existing `determinism.unit.test.ts` baseline). When `true`, one driver
   * is seeded per trailer, assigned per trip on dispatch, accrues driving minutes
   * across the transit legs via the shared {@link applyDrivingLeg} engine, and
   * parks (resting/on_break) when a clock would breach — all in deterministic
   * event-queue order, drawing any HOS randomness from the fifth `hosRng`
   * substream at deterministic evaluation time (never wall-clock).
   */
  readonly hosEnabled?: boolean;
  /**
   * DIP: override the FMCSA {@link HosConfig} limits. Only consulted when
   * `hosEnabled` is `true`; defaults to {@link DEFAULT_HOS_CONFIG}. Same seed +
   * same config ⇒ byte-identical HOS-on stream.
   */
  readonly hosConfig?: HosConfig;
  /**
   * Demo richness knob: how many trailers (and one primary driver each) to run
   * PER SPOKE. **DEFAULT 1** — the determinism keystone: at 1 the roster, driver
   * pool, package volume, and schedule are byte-identical to the pre-fleet golden
   * stream. At N>1 the engine seeds `spokes.length × N` trailers (extra fleet
   * slots' first departures are staggered so they spread along the routes),
   * scales the relay spare pool and the per-batch package volume by N, and is
   * still fully deterministic (same seed + N ⇒ byte-identical). Used by the live
   * demo to put more trucks on the map at once; the goldens never set it.
   */
  readonly fleetPerSpoke?: number;
  /**
   * SP2 (spec §5): OPT-IN fuel/refuel modeling. **DEFAULT OFF** ({@link
   * FuelConfig.enabled} defaults false) — the determinism keystone. When absent OR
   * `enabled:false`, the engine tracks NO odometer, creates NO `fuelRng`, emits NO
   * `TruckRested`/`TruckRefueled`, and adds NO arrival delay ⇒ the stream is
   * BYTE-IDENTICAL to the pre-SP2 golden. When `enabled`, each trailer accrues a
   * per-leg haversine-mile odometer; once it crosses `refuelThresholdMiles` the
   * trailer refuels on that leg (emit `TruckRefueled`, reset the odometer); each
   * HOS rest/break also emits a co-located `TruckRested`. A refuel co-located with
   * a rest adds NO extra delay (effective added time = `max(restMin, refuelMin)`,
   * spec §5 no-double-count). All deterministic: same seed + same config ⇒
   * byte-identical fuel-on stream.
   */
  readonly fuel?: FuelConfig;
  /**
   * CONT-01: when `true`, the engine runs INDEFINITELY past `durationTicks` — the
   * `durationTicks` ceiling is ignored and the package-batch / trailer-departure
   * self-rescheduling loops keep firing forever. The loop terminates only when
   * the queue drains AND/OR the injected {@link SimulateOptions.stop} predicate
   * returns `true`. **DEFAULT FALSE / ABSENT — the determinism keystone:** when
   * absent or `false`, every guard evaluates EXACTLY as the pre-v2.0 finite path,
   * so the stream is BYTE-IDENTICAL to the existing goldens (DET-01).
   *
   * Pair this with {@link SimulateOptions.onEvent} for streaming delivery — an
   * open-ended run accumulating into `out[]` would grow without bound (use the
   * `simulate()` array surface only for the finite path).
   */
  readonly runUntilStopped?: boolean;
  /**
   * CONT-01: streaming emit callback for the open-ended driver path. When
   * provided, each event is delivered ONE BY ONE to the callback instead of being
   * accumulated in the internal `out[]` array — so an indefinite run stays
   * memory-bounded. When ABSENT, `out[]` accumulation is used (the `simulate()`
   * golden-test surface is unchanged). The events delivered are byte-identical in
   * order/content to what `simulate()` would have collected.
   */
  readonly onEvent?: (event: SimulatedEvent) => void;
  /**
   * CONT-01: cooperative stop predicate, polled before each queue pop ONLY when
   * {@link SimulateOptions.runUntilStopped} is `true`. Return `true` to terminate
   * the loop cleanly at the next iteration. The injected driver (plan-04) flips
   * its source so the open-ended run can be stopped on demand. Ignored entirely on
   * the finite path (absent/false `runUntilStopped`), so it never affects goldens.
   */
  readonly stop?: () => boolean;
  /**
   * CONT-05 (P2): when present, freight departs in burst-quiet-burst windows
   * rather than a steady trickle — observable on the live map as departure
   * surges. **OFF BY DEFAULT (absent)** — the determinism keystone: when absent,
   * the burst-gate is never entered and the package-batch schedule + RNG draws are
   * EXACTLY the pre-CONT-05 behaviour, so every golden stays byte-identical
   * (DET-01/DET-02). The cadence is pure modular arithmetic on the deterministic
   * tick clock (no RNG salt) — fully reproducible per seed when enabled.
   */
  readonly sortWave?: SortWaveConfig;
  /**
   * IND-02: OPT-IN external package induction at spoke hubs. **DEFAULT FALSE —
   * the determinism keystone.** When absent or `false`, the engine emits NO
   * `PackageInducted` events and makes ZERO `inductionRng` draws (the substream is
   * never even constructed), so the existing seed-1234 + seed-42 goldens are
   * BYTE-IDENTICAL (DET-01). When `true`, a seeded substream (`INDUCTION_RNG_SALT`)
   * drives a self-rescheduling `inductPackage` EventQueue task: freight enters the
   * network from OUTSIDE at spoke hubs, shapes optimizer priority via a deadline
   * locked at induction, and animates on the live map (VIZ-13). Fully resumable —
   * the induction RNG state AND the pending self-rescheduling task are captured in
   * the `SimContinuation`, so a chunked run is byte-identical to all-at-once.
   */
  readonly inductionEnabled?: boolean;
  /**
   * FLOW-01/02/03: OPT-IN spoke→center consolidation (bidirectional freight).
   * **DEFAULT FALSE — the determinism keystone.** When absent or `false`, the
   * engine populates NO `pendingAtSpoke` manifest, emits NO consolidation
   * `TrailerDeparted`/`arriveConsolidationAtCenter` events, and makes ZERO new
   * RNG draws ⇒ the existing seed-1234 + seed-42 goldens are BYTE-IDENTICAL
   * (DET-01). When `true`, spoke-origin freight staged in `pendingAtSpoke` (from
   * Phase-20 induction or center distribution — freight already drawn, so NO new
   * randomness) is drained onto spoke→center consolidation trailers via an atomic
   * splice (the double-drain guard), carried to the center, unloaded, and
   * re-staged into `pendingBySpoke[destSpoke]` so the existing center→spoke
   * distribution cross-docks it onward (Decision 2: spoke→spoke via the center).
   * Cadence/selection are DETERMINISTIC (modular tick arithmetic + a stable
   * priority+tick+freightId sort; idle trailers in `trailerId` order). Fully
   * resumable — `pendingAtSpoke` is captured in the `SimContinuation.world` and
   * the center-arrival is a DATA `SimTask` variant, so a chunked run is
   * byte-identical to all-at-once.
   */
  readonly consolidationEnabled?: boolean;

  /**
   * OUT-01: OPT-IN terminal delivery at destination hubs. **DEFAULT FALSE —
   * the determinism keystone.** When absent or `false`, the engine emits NO
   * `PackageDelivered` events and makes ZERO `outboundRng` draws (the substream
   * is never even constructed), so the existing seed-1234 + seed-42 goldens are
   * BYTE-IDENTICAL (DET-01). When `true`, a seeded one-shot `deliverPackage`
   * EventQueue task fires after a seeded dwell (>= 1 tick, D-22-2) from a
   * DESTINATION-hub arrival; an `onTime` SLA flag is computed at emit (D-22-5).
   * Fully resumable — the outbound RNG state, pending-delivery task(s),
   * `deliveredCounter`, and `slaDeadlineByPackage` map are captured in
   * `SimContinuation`. The flag gates ALL outbound behavior; it is checked with
   * a STRICT `=== true` comparison (never `??` or `||`, which would make an
   * absent flag accidentally truthy and perturb the golden).
   */
  readonly outboundDeliveryEnabled?: boolean;
}

/** Options for the store-driven run. */
export interface RunSimulationOptions extends SimulateOptions {
  /** Consumes each event in deterministic order (e.g. appends to the store). */
  readonly sink: (event: SimulatedEvent) => void | Promise<void>;
}

// --- Simulation constants (declarative; the network is fixed for Phase 1) ----

// Plan 19-08 Task D: `MS_PER_TICK` + `EPOCH_ISO` are the SINGLE source of truth
// in `./epoch.js`; every consumer (engine clock, ws simDay/simMs, tests) imports
// them so the literal can never drift across packages.

/** Ticks between successive package-creation batches at the center hub. */
const PACKAGE_INTERVAL_TICKS = 15;
/** Max packages created per batch (1..MAX). */
const MAX_PACKAGES_PER_BATCH = 3;
/** Package size classes, in a fixed order (RNG picks an index). */
const SIZE_CLASSES: readonly SizeClass[] = ["small", "medium", "large"];

// --- v2.0 external induction (IND-02/IND-03) --------------------------------

/** Ticks between successive external inductions at spoke hubs (one every 30 min). */
const INDUCTION_INTERVAL_TICKS = 30;
/** First induction fires at tick 1 (deterministic, fixed offset; off by default). */
const INDUCTION_START_TICK = 1;
/** SLA classes in a fixed order (the induction RNG picks an index). */
const SLA_CLASSES: readonly SlaClass[] = [
  "express",
  "priority",
  "standard",
  "economy",
];
/**
 * IND-03: whole-minute SLA buffer added on top of the travel estimate when
 * deriving `slaDeadlineIso`. Tighter classes get less slack — so the optimizer's
 * slack/critical-ratio prioritization is meaningful. Deterministic per class.
 */
const SLA_BUFFER_MIN: Record<SlaClass, number> = {
  express: 60,
  priority: 120,
  standard: 240,
  economy: 480,
};

// --- Phase-22 outbound delivery (OUT-01/OUT-02) -----------------------------

/**
 * OUT-01: the EXCLUSIVE upper bound for the seeded outbound dwell. The dwell is
 * `1 + outboundRng.int(OUTBOUND_DWELL_TICKS_MAX)` ⇒ a STRICTLY-POSITIVE 1..20
 * tick window (D-22-2): delivery always fires at a strictly-later tick than the
 * destination `PackageArrivedAtHub` that scheduled it, so the existing
 * `(fireTick, seq)` comparator orders arrival-before-delete with NO change.
 * Tuned (Claude's discretion) so deliveries are watchable in the demo without
 * instantly draining hubs.
 */
const OUTBOUND_DWELL_TICKS_MAX = 20;

/**
 * SIM-HOS-03: max extra whole-minute jitter added to EACH mandatory break/rest,
 * drawn from the `hosRng` substream at deterministic evaluation time. Models the
 * real-world slack in how long a parked driver actually rests beyond the legal
 * minimum. `0..HOS_REST_JITTER_TICKS` inclusive; the draw order is the
 * event-queue dispatch order, so it is fully reproducible per seed.
 */
const HOS_REST_JITTER_TICKS = 15;

/**
 * DRV-04: how many SPARE drivers each hub pool carries BEYOND the one-per-trailer
 * primary roster. The center dispatch hub seeds `spokes.length` primary drivers
 * (one bound to each trailer) PLUS this many spares, so when a trailer's assigned
 * driver is out of legal hours at dispatch a FRESH legal driver is usually
 * available for a relay/swap (SIM-HOS-04) — and the trailer departs on time
 * instead of parking. A deterministic constant (no RNG): the pool size is a pure
 * function of the network, so the seeded roster is byte-stable. When the pool is
 * momentarily exhausted (every spare is tired/in-flight) the engine falls back to
 * the Phase-11 park-while-resting behaviour.
 */
const RELAY_SPARE_DRIVERS = 6;

// --- Internal event-queue --------------------------------------------------

/**
 * A scheduled action: run at `fireTick`; `seq` is the deterministic tie-break.
 *
 * Plan 19-08: the action is now a `SimTask` DATA descriptor (not a closure), so
 * the queue is fully serializable into a {@link SimContinuation}. A single
 * `dispatch(task)` switch reconstructs the behaviour — same code, same order.
 */
interface Scheduled {
  readonly fireTick: number;
  readonly seq: number;
  readonly task: SimTask;
}

/**
 * A deterministic priority queue. Actions are dequeued in `(fireTick, seq)`
 * order — `seq` (insertion order) guarantees a total, stable ordering so the
 * stream never depends on array/heap implementation details.
 *
 * Plan 19-08: it holds DATA tasks and can be (de)serialized for a resumable
 * continuation. The sort comparator is unchanged, so the dispatch order — and
 * thus the byte-identical stream — is preserved exactly.
 */
class EventQueue {
  private items: Scheduled[];
  private nextSeq: number;
  private dirty = false;

  constructor(items: Scheduled[] = [], nextSeq = 0) {
    this.items = items;
    this.nextSeq = nextSeq;
    // A restored queue may be out of order if it was captured mid-run; sort lazily.
    this.dirty = items.length > 0;
  }

  /** Allocate the next monotonic insertion sequence (the stable tie-break). */
  claimSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  push(fireTick: number, seq: number, task: SimTask): void {
    this.items.push({ fireTick, seq, task });
    this.dirty = true;
  }

  /** Pop the earliest `(fireTick, seq)` action, or `undefined` when empty. */
  pop(): Scheduled | undefined {
    if (this.items.length === 0) return undefined;
    if (this.dirty) {
      this.items.sort((a, b) =>
        a.fireTick !== b.fireTick ? a.fireTick - b.fireTick : a.seq - b.seq,
      );
      this.dirty = false;
    }
    return this.items.shift();
  }

  /** The next insertion seq — captured into the continuation. */
  peekNextSeq(): number {
    return this.nextSeq;
  }

  /**
   * Snapshot the pending items in deterministic `(fireTick, seq)` order — the
   * serializable form carried in a {@link SimContinuation}. Sorting here makes the
   * captured order stable regardless of the internal `dirty`/shift bookkeeping.
   */
  snapshot(): SerializedScheduled[] {
    const sorted = [...this.items].sort((a, b) =>
      a.fireTick !== b.fireTick ? a.fireTick - b.fireTick : a.seq - b.seq,
    );
    return sorted.map((s) => ({ fireTick: s.fireTick, seq: s.seq, task: s.task }));
  }
}

// --- The generation core ----------------------------------------------------

/** What {@link runToHorizon} returns: the chunk's events + the resume point. */
export interface RunToHorizonResult {
  /** The events emitted in this chunk, in deterministic order. */
  readonly events: SimulatedEvent[];
  /** The serializable continuation to resume from (state AFTER this chunk). */
  readonly continuation: SimContinuation;
}

/**
 * THE continuation-driven generation core (Plan 19-08 Task A).
 *
 * Runs the deterministic event queue from `start` (a fresh `{ seed }` OR a
 * previously-returned {@link SimContinuation}) up to and INCLUDING `horizonTick`,
 * returning the chunk's `events` plus the {@link SimContinuation} to resume from.
 * Driving a finite run all-at-once and driving it in chunks via the continuation
 * produce a BYTE-IDENTICAL ordered stream (the continuation-equivalence keystone).
 *
 * Determinism contract (threat T-01-15 + the consult): ALL randomness comes from
 * the seeded sub-streams (captured raw in the continuation), ALL time from the
 * `VirtualClock` re-anchored at `continuation.nextTick` — NO `Date.now()`, NO
 * unseeded `Math.random()`. The queue holds DATA tasks (never closures), so the
 * continuation is plain serializable data.
 */
export function runToHorizon(
  start: SimStart,
  horizonTick: number,
  opts: Omit<SimulateOptions, "seed" | "durationTicks">,
): RunToHorizonResult {
  if (!Number.isInteger(horizonTick) || horizonTick < 0) {
    throw new RangeError(`horizonTick must be a non-negative integer, got ${horizonTick}`);
  }
  const resuming = isContinuation(start);
  // The seed comes from the start point itself — a fresh `{ seed }` OR the
  // SELF-CONTAINED continuation (which carries `seed`). On resume every sub-stream
  // is restored from raw state, so the seed is only metadata; on a fresh run it
  // seeds the sub-streams via `seed ^ salt`.
  const seed = start.seed;
  const { rfid, overCarry, timing, hosEnabled, hosConfig, fuel } = opts;
  // The finite ceiling for the queue loop. On a fresh run this IS `horizonTick`;
  // on resume the loop simply continues from `nextTick` up to the new horizon.
  const durationTicks = horizonTick;
  // CONT-01 streaming surface is handled by the public wrappers; the core always
  // collects into `out` and the caller decides whether to stream.
  const onEventSink = opts.onEvent;

  // SIM-HOS-01: driver HOS is OPT-IN and DEFAULT FALSE. Absent/false ⇒ the
  // engine emits NO driver/HOS/load-unload events and NEVER draws `hosRng`, so
  // the stream is byte-identical to the pre-v1.2 golden (the keystone).
  const hosOn = hosEnabled === true;
  const hosLimits: HosConfig = hosConfig ?? DEFAULT_HOS_CONFIG;

  // SP2 (spec §5): fuel is OPT-IN and DEFAULT OFF. Enabled ONLY when a config is
  // supplied with `enabled:true` — absent OR `enabled:false` ⇒ NO odometer, NO
  // `fuelRng`, NO `TruckRested`/`TruckRefueled`, NO arrival delay, so the stream
  // stays byte-identical to the golden (the determinism keystone). The fuel
  // config falls back to DEFAULT_FUEL_CONFIG only for the (unused-when-off) knobs.
  const fuelConfig: FuelConfig = fuel ?? DEFAULT_FUEL_CONFIG;
  const fuelOn = fuelConfig.enabled === true;

  // v2.0 IND-02: external induction is OPT-IN and DEFAULT OFF. Absent/false ⇒ the
  // engine emits NO `PackageInducted` and NEVER constructs/draws `inductionRng`,
  // so all existing goldens are byte-identical (the determinism keystone).
  const inductionOn = opts.inductionEnabled === true;

  // FLOW-01/02/03: spoke→center consolidation is OPT-IN and DEFAULT OFF.
  // Absent/false ⇒ the engine NEVER populates `pendingAtSpoke`, emits NO
  // consolidation departure/center-arrival events, and draws NO new RNG, so the
  // existing goldens are byte-identical (the determinism keystone). When on,
  // consolidation reuses freight already drawn (induction/center-distribution),
  // so NO new substream/salt is introduced — selection/cadence are deterministic.
  const consolidationOn = opts.consolidationEnabled === true;

  // Phase-22 OUT-01: outbound delivery is OPT-IN and DEFAULT OFF. Absent/false ⇒
  // the engine emits NO `PackageDelivered`, NEVER constructs/draws `outboundRng`,
  // populates NO `slaDeadlineByPackage`, and schedules NO `deliverPackage` task,
  // so all existing goldens are byte-identical (the determinism keystone). STRICT
  // `=== true` — never `??`/`||` (an absent flag must stay falsy).
  const outboundOn = opts.outboundDeliveryEnabled === true;

  // SIM-03: RFID is OPT-IN. Absent ⇒ the engine emits the exact pre-Phase-3
  // stream (no RfidObserved, rng never drawn for reads) so goldens stay green.
  const rfidEnabled = rfid !== undefined;
  const rfidConfig: RfidSimConfig = resolveRfidConfig(rfid);

  // F-07 / SNS-05: over-carry is OPT-IN. Enabled only when a finite, positive
  // rate is supplied — absent or 0 ⇒ the over-carry substream is NEVER drawn and
  // NO spoke-origin departure is emitted, so the golden stays byte-identical.
  const overCarryRate =
    typeof overCarry === "number" && Number.isFinite(overCarry) ? overCarry : 0;
  const overCarryEnabled = overCarryRate > 0;

  // Plan 19-08: each seeded sub-stream is either constructed fresh from
  // `seed ^ salt` (a fresh run) or RESTORED from the continuation's raw state (a
  // resumed chunk). `makeRng(seed)` == `makeRngFromState(mixSeed(seed))`, so a
  // fresh run is byte-identical to the pre-19-08 behaviour; a restored run draws
  // the EXACT remaining sequence (the continuation-equivalence keystone).
  const restoredRng = resuming ? start.rng : undefined;
  const rng = restoredRng
    ? makeRngFromState(restoredRng.base)
    : makeRng(seed);
  // SIM-03: RFID draws from a SEPARATE seeded substream (seed ^ a fixed salt) so
  // enabling RFID never perturbs the operational rng — the non-RFID event order
  // is byte-identical with or without the rfid option, while the RFID stream is
  // still fully reproducible per seed.
  const rfidRng = restoredRng
    ? makeRngFromState(restoredRng.rfid)
    : makeRng((seed ^ RFID_RNG_SALT) >>> 0);
  // F-07: over-carry draws from its OWN seeded substream — a salt DISTINCT from
  // the RFID salt (0x5f1da7c3) so it never collides with / perturbs `rfidRng` or
  // `rng`. Same seed + same rate ⇒ byte-identical over-carry decisions.
  const overCarryRng = restoredRng
    ? makeRngFromState(restoredRng.overCarry)
    : makeRng((seed ^ OVER_CARRY_RNG_SALT) >>> 0);
  // Timing (dwell/transit) draws from its OWN seeded substream — a salt DISTINCT
  // from the RFID (0x5f1da7c3) and over-carry (0x3ca71d5f) salts — so the
  // log-normal timing variance is fully reproducible per seed yet NEVER perturbs
  // the operational `rng`, `rfidRng`, or `overCarryRng` draws. The draws happen
  // in deterministic event-queue order, so the timestamps are byte-identical for
  // a fixed seed + timing config.
  const timingRng = restoredRng
    ? makeRngFromState(restoredRng.timing)
    : makeRng((seed ^ TIMING_RNG_SALT) >>> 0);
  // SIM-HOS-01: the FIFTH substream. HOS draws use a salt DISTINCT from the RFID
  // (0x5f1da7c3), over-carry (0x3ca71d5f), and timing (0x00007717) salts (the
  // salt-collision test asserts this), so HOS variance is fully reproducible per
  // seed yet NEVER perturbs the other four streams. Constructing the generator is
  // side-effect-free (independent state); it is only DRAWN when `hosOn`, so the
  // HOS-off stream consumes ZERO `hosRng` values and stays byte-identical.
  const hosRng = restoredRng
    ? makeRngFromState(restoredRng.hos)
    : makeRng((seed ^ HOS_RNG_SALT) >>> 0);
  // SP2: the SIXTH substream. Created ONLY when fuel is on (the determinism
  // keystone — a fuel-off run never even constructs it). The salt is DISTINCT from
  // the five above (asserted by the salt-collision test) so any future refuel
  // jitter draw would be fully reproducible per seed yet never perturb the other
  // streams. The current tank model is deterministic (no draw), so `fuelRng` is
  // reserved; it is `undefined` when off so the off path is provably draw-free.
  const fuelRng: Rng | undefined = fuelOn
    ? restoredRng && restoredRng.fuel !== undefined
      ? makeRngFromState(restoredRng.fuel)
      : makeRng((seed ^ FUEL_RNG_SALT) >>> 0)
    : undefined;
  void fuelRng;
  // v2.0 IND-02: the SEVENTH substream. Created ONLY when induction is on (the
  // determinism keystone — an induction-off run never even constructs it). The
  // salt is DISTINCT from the six above (asserted by the salt-collision test) so
  // induction draws are fully reproducible per seed yet never perturb the other
  // streams. On resume it is restored from the captured raw state so a chunked
  // run draws the EXACT remaining sequence (continuation-equivalence keystone).
  const inductionRng: Rng | undefined = inductionOn
    ? restoredRng && restoredRng.induction !== undefined
      ? makeRngFromState(restoredRng.induction)
      : makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0)
    : undefined;
  // Phase-22 OUT-01: the EIGHTH substream. Created ONLY when outbound delivery is
  // on (the determinism keystone — an outbound-off run never even constructs it).
  // The salt is DISTINCT from the seven above (asserted by the salt-collision
  // test) so dwell draws are reproducible per seed yet never perturb the other
  // streams. On resume it is restored from the captured raw state so a chunked run
  // draws the EXACT remaining sequence (continuation-equivalence keystone).
  const outboundRng: Rng | undefined = outboundOn
    ? restoredRng && restoredRng.outbound !== undefined
      ? makeRngFromState(restoredRng.outbound)
      : makeRng((seed ^ OUTBOUND_RNG_SALT) >>> 0)
    : undefined;
  // SP2: per-trailer odometer (miles since last refuel), init 0 at roster
  // seeding. Only mutated when `fuelOn`; an off run leaves it empty (no state).
  // On resume it is restored from the continuation's world state.
  const odometerByTrailer = new Map<string, number>(
    resuming ? start.world.odometerByTrailer.map(([k, v]) => [k, v]) : [],
  );
  const timingConfig: TimingConfig = timing ?? DEFAULT_TIMING_CONFIG;
  // TIME-01: per-DIRECTED-LEG transit params, with each leg's MEDIAN derived from
  // the real great-circle (haversine) distance between its two hubs at an 80 km/h
  // average HGV speed — replacing the single flat ~30-min global transit median.
  // The leg's log-space spread (sigma) is carried in from the timing config's
  // `transit.sigma`. The map is keyed by directed routeId (`route-<from>-<to>`)
  // and is a pure function of hub coordinates + sigma (deterministic).
  //
  // DIP OVERRIDE: per-leg geography drives the DEFAULT path. When a caller passes
  // an EXPLICIT `timing` config, its flat `transit` params win for every leg —
  // so a test that pins transit to a small constant (to make round-trips complete
  // in a short horizon) keeps full control. The default config (no override) uses
  // the realistic geography-derived per-leg medians.
  //
  // NO-ORS-KEY PATH: see `transitParamsForLeg` in routes.ts — swap each leg's
  // median to its ORS `summary.duration` once VIZ-06's road-geometry exists.
  const useGeographyTransit = timing === undefined;
  const transitByLeg = buildTransitParamsByLeg(USA_HUBS, timingConfig.transit.sigma);
  /** Draw a whole-tick transit duration (≥1) for one departure on a directed leg. */
  const drawTransitTicks = (fromHubId: string, toHubId: string): number => {
    const params = useGeographyTransit
      ? transitByLeg.get(routeId(fromHubId, toHubId)) ?? timingConfig.transit
      : timingConfig.transit;
    return Math.max(1, Math.round(sampleLogNormal(timingRng, params)));
  };
  /** Draw a whole-tick dwell duration (≥1) for one arrival, chosen by hub role. */
  const drawDwellTicks = (role: "spoke" | "center"): number => {
    const params = role === "center" ? timingConfig.dwellCenter : timingConfig.dwellSpoke;
    return Math.max(1, Math.round(sampleLogNormal(timingRng, params)));
  };
  // Plan 19-08: the queue is restored from the captured DATA tasks on resume; a
  // fresh run starts with an empty queue (byte-identical to the pre-19-08 path).
  // The clock starts at the epoch in BOTH cases — it is NOT re-anchored, because
  // each fired task does `clock.advance(fireTick - currentTick(clock))`, which
  // sets the absolute virtual time to EXACTLY `fireTick` (a pure function of the
  // task's `fireTick`, never wall-clock). Every captured task has
  // `fireTick > prevHorizon`, so the advance is always non-negative on resume.
  const clock = new VirtualClock(EPOCH_ISO, MS_PER_TICK);
  const queue = resuming
    ? new EventQueue(
        start.queue.map((s) => ({ fireTick: s.fireTick, seq: s.seq, task: s.task })),
        start.nextSeq,
      )
    : new EventQueue();
  const out: SimulatedEvent[] = [];
  // Monotonic GLOBAL emit sequence id — continues across chunks so the total
  // order `(virtualTime, sequenceId)` is uninterrupted on resume.
  let nextSequenceId = resuming ? start.nextSequenceId : 0;

  const hubs = USA_HUBS;
  const center = hubs[0]!;
  const spokes = hubs.slice(1);
  const routes = buildRoutes(hubs);

  // SP2 (spec §5) + FIX 5 — per-DIRECTED-leg miles on the SAME distance basis as
  // the trailer-fuel projection + twin-snapshot, so the sim odometer, the twin's
  // `milesSinceRefuel`, and the optimizer's `distanceMiles` never diverge (an
  // endpoint-haversine odometer under-counts a road-following leg by ~10–15%, which
  // makes the optimizer over-predict refuels). PREFER the committed ORS road
  // `distance_m` (mirroring `buildTransitParamsByLeg` + twin-snapshot's
  // `distanceMiles`: `distance_m / 1000 km × 0.621371`), else the great-circle
  // (haversine) miles between the two hub coords. The road file is loaded ONLY on
  // the fuel-on path (no I/O when fuel is off ⇒ the off-mode stream stays
  // byte-identical), and `legMilesFor` is only READ when `fuelOn`. Pure +
  // deterministic: the static file is committed (no clock, no RNG, no network).
  const KM_TO_MILES = 0.621_371;
  const hubById = new Map<string, Hub>(hubs.map((h) => [h.hubId, h]));
  const roadGeometry = fuelOn ? loadStaticRoadGeometry() : undefined;
  const legMilesFor = (fromHubId: string, toHubId: string): number => {
    const from = hubById.get(fromHubId);
    const to = hubById.get(toHubId);
    if (from === undefined || to === undefined) return 0;
    // PREFER the ORS road distance (the SAME basis as the twin + projection).
    const orsDistanceM = roadGeometry?.legs[routeId(fromHubId, toHubId)]?.distance_m;
    if (orsDistanceM !== undefined) return (orsDistanceM / 1000) * KM_TO_MILES;
    return haversineKm(from, to) * KM_TO_MILES;
  };

  // Demo richness knob (DEFAULT 1 ⇒ byte-identical golden stream).
  const fleetPerSpoke = Math.max(1, Math.floor(opts.fleetPerSpoke ?? 1));
  // Initial-departure stagger (ticks) for extra fleet slots so they spread along
  // a route instead of bunching at the center. Slot 0 keeps the tick-1 departure
  // (so fleetPerSpoke=1 is unchanged); slot s departs at 1 + s·STAGGER.
  const TRAILER_STAGGER_TICKS = 7;
  // Per-batch package volume scales with the fleet so the extra trailers have
  // freight to carry (×1 ⇒ the unchanged golden draw `rng.int(3)`).
  const maxPackagesPerBatch = MAX_PACKAGES_PER_BATCH * fleetPerSpoke;

  /**
   * Trailer roster: trailerId ⇆ primary driverId ⇆ spoke ⇆ initial-departure
   * tick. Slot 0 reproduces the legacy one-per-spoke roster EXACTLY (T001…T00N,
   * D001…D00N, depart tick 1), so fleetPerSpoke=1 is byte-identical; slots ≥1
   * append further trailers (continuing the id sequence) with staggered starts.
   */
  interface TrailerRosterEntry {
    readonly trailerId: string;
    readonly driverId: string;
    readonly spoke: Hub;
    readonly departTick: number;
  }
  const trailerRoster: TrailerRosterEntry[] = [];
  {
    let n = 0;
    for (let slot = 0; slot < fleetPerSpoke; slot += 1) {
      for (const spoke of spokes) {
        n += 1;
        const id = String(n).padStart(3, "0");
        trailerRoster.push({
          trailerId: `T${id}`,
          driverId: `D${id}`,
          spoke,
          departTick: slot === 0 ? 1 : 1 + slot * TRAILER_STAGGER_TICKS,
        });
        // SP2: seed the per-trailer odometer at 0 (only when fuel is on, so an
        // off run leaves `odometerByTrailer` empty — no state, no deltas).
        if (fuelOn) odometerByTrailer.set(`T${id}`, 0);
      }
    }
  }

  // Monotonic id counters — stable ids make the stream reproducible.
  // Monotonic id counters — restored from the continuation on resume so package /
  // trip ids continue the same sequence (stable ids keep the stream reproducible).
  let packageCounter = resuming ? start.world.packageCounter : 0;
  let tripCounter = resuming ? start.world.tripCounter : 0;
  // v2.0 IND-02: monotonic external-induction id counter; restored on resume so
  // EXT ids continue the same sequence (stable ids keep the stream reproducible).
  let inductionCounter = resuming ? start.world.inductionCounter : 0;
  // Phase-22 OUT-01: monotonic delivered-package counter; restored on resume.
  let deliveredCounter = resuming ? start.world.deliveredCounter : 0;
  // Phase-22 OUT-01: packageId → locked slaDeadlineIso (whole-minute ISO) for
  // inducted packages awaiting delivery. Only populated when `outboundOn`; empty
  // on the off path (byte-identical to pre-Phase-22). Restored on resume so a
  // mid-dwell continuation can still compute `onTime` deterministically.
  const slaDeadlineByPackage = new Map<string, string>(
    resuming ? start.world.slaDeadlineByPackage.map(([k, v]) => [k, v]) : [],
  );

  /**
   * Emit one event onto its stream at the current domain time. CONT-01: when an
   * `onEvent` callback is provided (the open-ended streaming path), the event is
   * delivered one-by-one to the callback instead of being accumulated in `out[]`,
   * so an indefinite run stays memory-bounded. Absent ⇒ `out[]` accumulation (the
   * `simulate()` golden-test surface, byte-identical).
   *
   * Plan 19-08: every emit increments the global `nextSequenceId` (carried in the
   * continuation) so the total order `(virtualTime, sequenceId)` is uninterrupted
   * across chunk boundaries.
   */
  const emit = (streamId: string, event: DomainEvent): void => {
    const item: SimulatedEvent = { streamId, event, occurredAt: clock.nowIso() };
    nextSequenceId += 1;
    if (onEventSink !== undefined) {
      onEventSink(item);
    } else {
      out.push(item);
    }
  };

  /**
   * SIM-03: emit the seeded RFID reads for one portal load / antenna dwell.
   * packageIds map to tags via the `TAG-${packageId}` scheme; each resulting
   * `RfidObserved` is placed on the (planned) trailer's stream. ALL miss/jitter
   * decisions are drawn from the shared seeded `rng` (determinism), and time is
   * the current virtual-clock instant.
   */
  const emitRfid = (
    readerType: "portal" | "antenna",
    trailerId: string,
    hubId: string,
    packageIds: readonly string[],
  ): void => {
    const tags = packageIds.map((packageId) => `TAG-${packageId}`);
    const reads = emitRfidReads({
      tags,
      readerType,
      trailerId,
      hubId,
      occurredAt: clock.nowIso(),
      rng: rfidRng,
      config: rfidConfig,
    });
    for (const read of reads) emit(`trailer-${trailerId}`, read);
  };

  // --- SIM-HOS-02/03/04 + DRV-04: driver state + hub pool (active when `hosOn`)
  //
  // Phase 11 bound exactly ONE driver to each trailer for the whole sim. Phase 12
  // (DRV-04, SIM-HOS-04) upgrades this to a per-hub driver POOL with RELAY: each
  // driver carries its own integer-minute {@link HosClock}, advanced by the
  // SHARED {@link applyDrivingLeg} engine (DRY — no HOS math is reimplemented).
  // At each dispatch the engine asks whether the trailer's CURRENT driver can
  // legally complete the NEXT leg (Phase-10 {@link remainingLegalDriveMinutes} /
  // {@link mayDriveNow}); if not, it RELAYS the trailer to a fresh legal driver
  // from the center pool (`DriverSwappedAtHub` + `DriverAssignedToTrip`) and the
  // tired driver enters `resting` (a 10h reset) so the trailer departs on time.
  // When the pool is momentarily exhausted the engine falls back to the Phase-11
  // park-while-resting behaviour (mid-leg break/rest via `applyDrivingLeg`).

  // Plan 19-08: the HOS driver state is restored from the continuation on resume
  // (a fresh run starts empty and seeds the pool at bootstrap below). Only ever
  // populated when `hosOn`, so an HOS-off run carries empty maps.
  /** trailerId → the driver currently bound to it (mutated on a relay). */
  const driverByTrailer = new Map<string, string>(
    resuming ? start.world.driverByTrailer.map(([k, v]) => [k, v]) : [],
  );
  /** driverId → its live HOS clock (advanced by `applyDrivingLeg` / a reset). */
  const clockByDriver = new Map<string, HosClock>(
    resuming ? start.world.clockByDriver.map(([k, v]) => [k, { ...v }]) : [],
  );
  /**
   * driverId → the epoch-MINUTE the driver becomes available again. A driver that
   * is in-flight or resting is `> now`; a free driver is `<= now`. The relay pool
   * scan reads this (never wall-clock) so re-entry after a 10h reset is purely a
   * function of the deterministic virtual clock + the driver's accrued state.
   */
  const availableAtMinByDriver = new Map<string, number>(
    resuming ? start.world.availableAtMinByDriver.map(([k, v]) => [k, v]) : [],
  );
  /**
   * driverIds that are NOT bound to a trailer's primary slot — the SPARE pool the
   * relay scan draws fresh drivers from. In a stable, seed-independent order
   * (registration order) so the relay selection is byte-deterministic.
   */
  const sparePool: string[] = resuming ? [...start.world.sparePool] : [];

  /** A fresh, post-10h-reset HOS clock anchored at the current virtual instant. */
  const freshHosClock = (nowIso: string): HosClock => ({
    driveTodayMin: 0,
    dutyWindowStartAt: nowIso,
    sinceLastBreakMin: 0,
    weeklyOnDutyMin: 0,
    comeOnDutyAt: nowIso,
    sleeperBerthLongMin: 0,
    sleeperBerthShortMin: 0,
  });

  /** Emit a `DriverDutyStateChanged` with the authoritative clock snapshot. */
  const emitDutyState = (
    driverId: string,
    dutyStatus: DutyStatus,
    reason: string,
    snapshot: HosClock,
  ): void => {
    const event: DriverDutyStateChanged = {
      type: "DriverDutyStateChanged",
      schemaVersion: 1,
      payload: {
        driverId,
        dutyStatus,
        reason,
        // Plan 19-08 (determinism fix): emit the clock in the SINGLE canonical key
        // order so the bytes are independent of which HOS builder produced the
        // source clock — making all-at-once and chunked-via-continuation runs
        // byte-identical even when a clock survives a continuation boundary.
        clock: canonicalHosClock(snapshot),
        occurredAt: clock.nowIso(),
      },
    };
    emit(`driver-${driverId}`, event);
  };

  /** Emit the trailer-scoped `LoadStarted` / `UnloadStarted` / `UnloadCompleted`. */
  const emitPhase = (
    type: "LoadStarted" | "UnloadStarted" | "UnloadCompleted",
    trailerId: string,
    hubId: string,
    tripId: string,
  ): void => {
    const payload = { trailerId, hubId, tripId, occurredAt: clock.nowIso() };
    const event: LoadStarted | UnloadStarted | UnloadCompleted = {
      type,
      schemaVersion: 1,
      payload,
    };
    emit(`trailer-${trailerId}`, event);
  };

  /**
   * SP2 (spec §5): emit a located `TruckRested` ALONGSIDE the HOS rest/break that
   * triggered it (same trailer, same `occurredAt`, the segment's whole `minutes`),
   * mapping the HOS segment kind to the closed reason enum. NO lon/lat, NO RNG in
   * the payload — the geo-track projection computes the map position from the
   * logged leg geometry. No-op (zero events) unless `fuelOn`.
   */
  const emitTruckRested = (
    trailerId: string,
    tripId: string,
    reason: "rest-10h" | "break-30min",
    durationMin: number,
  ): void => {
    const event: TruckRested = {
      type: "TruckRested",
      schemaVersion: 1,
      payload: { trailerId, tripId, reason, durationMin, occurredAt: clock.nowIso() },
    };
    emit(`trailer-${trailerId}`, event);
  };

  /**
   * SP2 (spec §5): emit a located `TruckRefueled` when the per-trailer odometer
   * crosses `refuelThresholdMiles` on a departing leg. `gallons` is the
   * deterministic refilled amount from the tank model
   * (`round(min(odometerMiles / mpg, tankCapacityGallons))`); `odometerMiles` is
   * the cumulative miles at the refuel (PRE-reset, integer-rounded for a byte-stable
   * payload). NO lon/lat, NO RNG in the payload (geometry-free). The caller resets
   * the odometer to 0 after this.
   */
  const emitTruckRefueled = (
    trailerId: string,
    tripId: string,
    odometerMiles: number,
  ): void => {
    const odo = Math.round(odometerMiles);
    const gallons = Math.round(
      Math.min(odo / fuelConfig.milesPerGallon, fuelConfig.tankCapacityGallons),
    );
    const event: TruckRefueled = {
      type: "TruckRefueled",
      schemaVersion: 1,
      payload: {
        trailerId,
        tripId,
        gallons,
        odometerMiles: odo,
        durationMin: Math.round(fuelConfig.refuelTimeMinutes),
        occurredAt: clock.nowIso(),
      },
    };
    emit(`trailer-${trailerId}`, event);
  };

  // Plan 19-08: the bootstrap (hub/route registration + driver-pool seeding +
  // initial schedule) runs ONLY on a FRESH run. A resumed chunk restores all of
  // that state from the continuation, so re-running the bootstrap would
  // double-emit and corrupt the stream — it is gated on `!resuming` throughout.
  // --- Bootstrap: register every hub then every route, all at tick 0. -------
  if (!resuming) {
    for (const hub of hubs) {
      emit(`hub-${hub.hubId}`, hubRegisteredEvent(hub));
    }
    for (const route of routes) {
      const event: DomainEvent = {
        type: "RouteRegistered",
        schemaVersion: 1,
        payload: {
          routeId: route.routeId,
          fromHubId: route.fromHubId,
          toHubId: route.toHubId,
          geometry: route.geometry,
        },
      };
      emit(`route-${route.routeId}`, event);
    }
  }

  // --- SIM-HOS-02 + DRV-04: seed the center driver POOL at bootstrap (tick 0).
  // Mirrors how trailers are seeded one-per-spoke: a `DriverRegistered` per
  // driver, rostered at the CENTER (the dispatch hub), each with a fresh
  // post-reset HOS clock anchored at the epoch. The pool is the PRIMARY roster
  // (one driver per trailer) PLUS `RELAY_SPARE_DRIVERS` spares — so a relay
  // (SIM-HOS-04) usually finds a fresh legal driver. This runs ONLY when HOS is
  // on, so the off-mode stream is byte-unchanged. Every registration precedes the
  // first `DriverAssignedToTrip` (first dispatch is at tick 1). The pool size is a
  // pure function of the network (no RNG) ⇒ the roster is byte-deterministic.
  if (hosOn && !resuming) {
    const nowIso = clock.nowIso();
    const nowMin = isoToEpochMinutes(nowIso);
    const registerDriver = (driverId: string): void => {
      clockByDriver.set(driverId, freshHosClock(nowIso));
      availableAtMinByDriver.set(driverId, nowMin);
      const registered: DriverRegistered = {
        type: "DriverRegistered",
        schemaVersion: 1,
        payload: { driverId, homeHubId: center.hubId, occurredAt: nowIso },
      };
      emit(`driver-${driverId}`, registered);
    };
    // Primary roster: one driver bound to each trailer (from `trailerRoster`;
    // D001…D00N at fleetPerSpoke=1, continuing the sequence for extra slots).
    for (const entry of trailerRoster) {
      driverByTrailer.set(entry.trailerId, entry.driverId);
      registerDriver(entry.driverId);
    }
    // Spare pool: extra fresh drivers a relay hands a trailer to, scaled by the
    // fleet so more concurrent trailers still usually find a fresh legal driver.
    // Ids continue the sequence after the primary roster so they sort stably AFTER it.
    const spareCount = RELAY_SPARE_DRIVERS * fleetPerSpoke;
    for (let k = 0; k < spareCount; k += 1) {
      const driverId = `D${String(trailerRoster.length + k + 1).padStart(3, "0")}`;
      registerDriver(driverId);
      sparePool.push(driverId);
    }
  }

  // --- Package generation: batches created at the center over time. ---------
  // Each package is created, scanned inbound at the center, and queued to ride
  // the next trailer toward its destination spoke. The queue per spoke is a
  // FIFO manifest the spoke's trailer drains on departure. Plan 19-08: restored
  // from the continuation on resume (a fresh run starts every spoke empty).
  const pendingBySpoke = new Map<string, string[]>();
  if (resuming) {
    for (const [hubId, ids] of start.world.pendingBySpoke) {
      pendingBySpoke.set(hubId, [...ids]);
    }
  }
  for (const s of spokes) if (!pendingBySpoke.has(s.hubId)) pendingBySpoke.set(s.hubId, []);

  // FLOW-01: the SECOND queue — spoke-origin freight awaiting a spoke→center
  // CONSOLIDATION trailer (the mirror of `pendingBySpoke`, which is center→spoke
  // distribution). Populated ONLY when `consolidationOn`; on the off path it
  // stays empty and emits zero behaviour, so the goldens are byte-identical.
  // Restored from the continuation on resume so a chunked run is byte-identical
  // to all-at-once (the determinism keystone — captured in `captureContinuation`).
  const pendingAtSpoke = new Map<string, string[]>();
  if (resuming) {
    for (const [hubId, ids] of start.world.pendingAtSpoke) {
      pendingAtSpoke.set(hubId, [...ids]);
    }
  }
  for (const s of spokes) if (!pendingAtSpoke.has(s.hubId)) pendingAtSpoke.set(s.hubId, []);

  // FLOW-02: the onward (post-center) destination spoke of each consolidation
  // package (packageId → destHubId), so `arriveConsolidationAtCenter` can re-stage
  // it into `pendingBySpoke[destSpoke]` (the cross-dock). Resolved at induction
  // from the package's `destHubId` — freight already drawn, NO new RNG. Captured
  // in the continuation so a chunk boundary between staging and the center re-sort
  // resolves the dest identically (the determinism keystone). Off path empty.
  const consolidationDestByPackage = new Map<string, string>();
  if (resuming) {
    for (const [packageId, destHubId] of start.world.consolidationDestByPackage) {
      consolidationDestByPackage.set(packageId, destHubId);
    }
  }

  const createPackageBatch = (tick: number): void => {
    // CONT-05 (P2): sort-wave burst-quiet gate. ENTERED ONLY when `sortWave` is
    // present — so an absent config leaves the original code path (and RNG draw)
    // EXACTLY as before (byte-identical goldens, DET-01/DET-02). When present:
    // during the QUIET window create nothing (no draw, no events); during the
    // BURST window create exactly `burstPackagesPerBatch`. The window is pure
    // modular arithmetic on the deterministic tick (no RNG salt).
    let count: number;
    if (opts.sortWave !== undefined) {
      const period =
        opts.sortWave.burstWindowTicks + opts.sortWave.quietWindowTicks;
      const cycle = period > 0 ? tick % period : 0;
      if (cycle >= opts.sortWave.burstWindowTicks) {
        // Quiet window — emit nothing, but keep self-rescheduling (below).
        const nextTick = tick + PACKAGE_INTERVAL_TICKS;
        scheduleNext(nextTick, { kind: "createPackageBatch", tick: nextTick });
        return;
      }
      count = opts.sortWave.burstPackagesPerBatch;
    } else {
      count = 1 + rng.int(maxPackagesPerBatch); // 1..(MAX × fleetPerSpoke)
    }
    for (let i = 0; i < count; i += 1) {
      packageCounter += 1;
      const packageId = `P${String(packageCounter).padStart(5, "0")}`;
      const dest = rng.pick(spokes);
      const sizeClass = SIZE_CLASSES[rng.int(SIZE_CLASSES.length)]!;
      const weight = 1 + rng.int(50); // 1..50 kg (integer, byte-stable)

      const created: PackageCreated = {
        type: "PackageCreated",
        schemaVersion: 1,
        payload: {
          packageId,
          originHubId: center.hubId,
          destHubId: dest.hubId,
          sizeClass,
          weight,
          // SIM-03/SNS-02: deterministic tag→package key. Only attached when RFID
          // is enabled so the non-RFID golden payloads are byte-unchanged.
          ...(rfidEnabled ? { rfidTagId: `TAG-${packageId}` } : {}),
        },
      };
      emit(`package-${packageId}`, created);

      const inbound: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: center.hubId, scanType: "inbound" },
      };
      emit(`package-${packageId}`, inbound);

      pendingBySpoke.get(dest.hubId)!.push(packageId);
    }
    const nextTick = tick + PACKAGE_INTERVAL_TICKS;
    // CONT-02 / Plan 19-08: keep self-scheduling so freight generation sustains
    // indefinitely. `scheduleNext` decides whether the task is RETAINED (resumable
    // path — captured into the continuation) or DROPPED past `durationTicks` (the
    // finite all-at-once path — byte-identical goldens, DET-01).
    scheduleNext(nextTick, { kind: "createPackageBatch", tick: nextTick });
  };

  /**
   * v2.0 IND-02/IND-03: external induction — freight enters the network FROM
   * OUTSIDE at a spoke hub. A self-rescheduling EventQueue task (like
   * {@link createPackageBatch}) so the order stays single-threaded + deterministic
   * — never an external append. Draws EXCLUSIVELY from `inductionRng` (byte-
   * isolated from every other substream). Guards on `inductionOn` so the off path
   * NEVER runs (the determinism keystone): zero draws, zero events.
   *
   * The deadline (`slaDeadlineIso`) is LOCKED at induction from the shared travel
   * estimator: `occurredAt + expectedTransit(inductionHub→center→destHub) +
   * center-dwell + SLA-class buffer`. All times use the VIRTUAL clock
   * (`clock.nowIso()`) — never `Date.now()`.
   */
  const inductPackage = (tick: number): void => {
    if (!inductionOn || inductionRng === undefined) return; // never runs when off

    inductionCounter += 1;
    const externalOriginRef = `EXT-${String(inductionCounter).padStart(5, "0")}`;
    const packageId = `EXT-P${String(inductionCounter).padStart(5, "0")}`;

    // Draw from inductionRng ONLY. Spoke→spoke routes via the center (Decision 2):
    // the induction hub is a spoke; the destination is a DIFFERENT spoke.
    const inductionHub = inductionRng.pick(spokes);
    const destCandidates = spokes.filter((s) => s.hubId !== inductionHub.hubId);
    // Fail-loud invariant: with the fixed 11-spoke topology there is ALWAYS at
    // least one different spoke, so this NEVER fires for a valid run (goldens
    // unaffected — zero extra RNG draws). A silent `: inductionHub` fallback
    // would emit a self-destined induction (destHubId === inductionHubId),
    // violating the `inductionHubId !== destHubId` invariant the projections and
    // tests rely on. Throw instead of producing an impossible-but-quiet state.
    if (destCandidates.length === 0) {
      throw new Error(
        `inductPackage: no destination spoke distinct from induction hub ` +
          `"${inductionHub.hubId}" (${spokes.length} spoke(s) total) — ` +
          `the fixed topology guarantees candidates, so this is an invalid state`,
      );
    }
    const destHub = inductionRng.pick(destCandidates);
    const slaClass = SLA_CLASSES[inductionRng.int(SLA_CLASSES.length)]!;

    // Deadline = occurredAt + expectedTravel(inductionHub→center→destHub) + buffer.
    // The same `expectedMinutes`-backed estimator the optimizer uses (one source
    // of truth). Locked here; never regenerated.
    const transitMin =
      expectedTransitMinutes(inductionHub, center, timingConfig) +
      expectedDwellMinutes("center", timingConfig) +
      expectedTransitMinutes(center, destHub, timingConfig);
    const occurredAtIso = clock.nowIso();
    const deadlineMin =
      isoToEpochMinutes(occurredAtIso) +
      Math.round(transitMin) +
      SLA_BUFFER_MIN[slaClass];
    const slaDeadlineIso = epochMinutesToIso(deadlineMin);

    const inducted: PackageInducted = {
      type: "PackageInducted",
      schemaVersion: 1,
      payload: {
        packageId,
        inductionHubId: inductionHub.hubId,
        destHubId: destHub.hubId,
        slaClass,
        slaDeadlineIso,
        externalOriginRef,
        occurredAt: occurredAtIso,
      },
    };
    emit(`package-${packageId}`, inducted);

    // Phase-22 OUT-01: when outbound delivery is ON, retain this inducted
    // package's LOCKED slaDeadlineIso so the later one-shot `deliverPackage` task
    // can compute `onTime` deterministically (even across a continuation boundary).
    // Gated on `outboundOn` so the off path keeps `slaDeadlineByPackage` empty
    // (byte-identical to pre-Phase-22). Reuses the already-derived deadline — NO
    // new RNG draw, NO new event.
    if (outboundOn) {
      slaDeadlineByPackage.set(packageId, slaDeadlineIso);
    }

    // FLOW-01/02: when consolidation is ON, stage this spoke-origin package into
    // the induction hub's consolidation manifest so a spoke→center consolidation
    // trailer carries it to the center, where it cross-docks into
    // `pendingBySpoke[destHub]` toward its onward spoke (Decision 2: spoke→spoke
    // via the center). Reuses freight ALREADY drawn (the induction RNG above) — NO
    // new randomness. Gated on `consolidationOn` so the off path is byte-identical
    // (`pendingAtSpoke`/`consolidationDestByPackage` stay empty, zero events).
    if (consolidationOn) {
      pendingAtSpoke.get(inductionHub.hubId)!.push(packageId);
      consolidationDestByPackage.set(packageId, destHub.hubId);
    }

    // Self-reschedule the NEXT induction at an ABSOLUTE tick (same discipline as
    // createPackageBatch). `scheduleNext` RETAINS the task on the resumable path
    // (captured into the continuation) or DROPS it past the horizon (finite path).
    const nextTick = tick + INDUCTION_INTERVAL_TICKS;
    scheduleNext(nextTick, { kind: "inductPackage", tick: nextTick });
  };

  /**
   * OUT-01: the ONE-SHOT terminal delivery. Fired by a `deliverPackage` queue
   * task (scheduled at a DESTINATION-hub arrival after a seeded dwell >= 1 tick).
   * Emits `PackageDelivered` carrying the whole-minute-canonical `deliveredAt`
   * and the computed `onTime` SLA flag, then purges the package's deadline from
   * world state.
   *
   * Determinism: guarded by `outboundOn` + a constructed `outboundRng` so the off
   * path never reaches here (no event, no draw). `deliveredAt` is canonicalized to
   * whole minutes via `epochMinutesToIso(isoToEpochMinutes(...))` so it matches the
   * `slaDeadlineIso` format (both `YYYY-MM-DDTHH:MM:00.000Z`) and avoids sub-minute
   * key-order/formatting drift across a continuation boundary (D-22-5). `onTime`
   * is the ISO-8601 LEXICOGRAPHIC comparison `deliveredAt <= slaDeadlineIso`;
   * center-origin freight with no induction deadline is `onTime: true` by
   * convention. This is ONE-SHOT — NO `scheduleNext` here (the key difference from
   * `inductPackage`).
   */
  const deliverPackage = (
    packageId: string,
    hubId: string,
    slaDeadlineIso: string | undefined,
  ): void => {
    if (!outboundOn || outboundRng === undefined) return; // never runs when off

    deliveredCounter += 1;
    const deliveredAt = epochMinutesToIso(isoToEpochMinutes(clock.nowIso()));
    const onTime =
      slaDeadlineIso !== undefined ? deliveredAt <= slaDeadlineIso : true;
    const delivered: PackageDelivered = {
      type: "PackageDelivered",
      schemaVersion: 1,
      payload: { packageId, hubId, deliveredAt, onTime, occurredAt: deliveredAt },
    };
    emit(`package-${packageId}`, delivered);
    // Clean up the in-flight deadline so `slaDeadlineByPackage` stays bounded
    // (one entry per in-flight delivery). A missing key is a natural no-op.
    slaDeadlineByPackage.delete(packageId);
  };

  /**
   * SIM-HOS-03: accrue one transit leg's DRIVING minutes through the SHARED
   * forward-labeling engine ({@link applyDrivingLeg}) and inject any mandatory
   * break/rest as ADDED queue time before the arrival fires (a parked trailer = a
   * resting driver). Returns the EXTRA minutes the legal rests add to the leg's
   * wall-clock (0 when the leg fits inside the driver's remaining hours). Emits
   * the `DriverDutyStateChanged` transitions for each inserted break/rest and the
   * recovering `driving` transition. ALL randomness is a `hosRng` jitter drawn
   * HERE, at deterministic evaluation time, in event-queue order — never at the
   * wall-clock instant the rest begins. No-op (and ZERO `hosRng` draws) unless
   * `hosOn`.
   *
   * @param driverId   The driver bound to this trip.
   * @param legMinutes Whole minutes of DRIVING this leg requires (the drawn transit).
   * @param departIso  The ISO instant the leg begins (the `TrailerDeparted` time).
   * @returns Extra minutes the inserted rests add to the leg (>= 0).
   */
  const accrueDrivingLeg = (
    driverId: string,
    legMinutes: number,
    departIso: string,
  ): { extra: number; rests: readonly { reason: "rest-10h" | "break-30min"; minutes: number }[] } => {
    const before = clockByDriver.get(driverId)!;
    const result = applyDrivingLeg(before, hosLimits, legMinutes, departIso);
    clockByDriver.set(driverId, result.clock);

    // Sum the non-driving segments the engine inserted; each break/rest is a
    // mandatory pause that pushes the arrival later. A small deterministic
    // `hosRng` jitter (0..HOS_REST_JITTER_TICKS) is drawn PER inserted pause, in
    // queue order, so two replays draw the same values in the same sequence.
    let extra = 0;
    const rests: { reason: "rest-10h" | "break-30min"; minutes: number }[] = [];
    for (const seg of result.segments) {
      if (seg.kind === "drive") continue;
      const jitter = hosRng.int(HOS_REST_JITTER_TICKS + 1); // 0..JITTER inclusive
      const pauseMinutes = seg.minutes + jitter;
      extra += pauseMinutes;
      const isBreak = seg.kind === "break";
      const status: DutyStatus = isBreak ? "on_break" : "resting";
      const reason = isBreak ? "30-min-break-due" : "10h-reset";
      emitDutyState(driverId, status, reason, result.clock);
      // SP2 (spec §5): record this mid-leg park so `departTrailer` can emit a
      // co-located `TruckRested` (the new map-visible event). Recorded ALWAYS;
      // emission is gated on `fuelOn` at the call site so the fuel-off stream is
      // byte-identical (the `hosRng` jitter draw count/order above is unchanged).
      rests.push({ reason: isBreak ? "break-30min" : "rest-10h", minutes: pauseMinutes });
    }
    // If the leg required any pause, the driver resumes driving afterward.
    if (extra > 0) {
      emitDutyState(driverId, "driving", "rest-complete", result.clock);
    }
    return { extra, rests };
  };

  /**
   * SIM-HOS-04: decide which driver dispatches the trailer's NEXT leg — the
   * Phase-12 relay/swap-at-hub. The trailer's CURRENTLY-bound driver is checked
   * against the Phase-10 HOS engine: it keeps the trailer iff it `mayDriveNow`
   * AND has enough {@link remainingLegalDriveMinutes} to complete the whole leg
   * with NO mandatory rest. Otherwise the engine RELAYS to a fresh legal driver
   * from the center spare pool (DRV-04): it emits `DriverSwappedAtHub`, puts the
   * tired driver into a 10h `resting` reset (so it re-enters the pool later), and
   * rebinds the trailer to the fresh driver — so the trailer departs ON TIME
   * instead of parking. When NO fresh legal driver is free, it returns the tired
   * driver unchanged and the caller falls back to the Phase-11 park-while-resting
   * path ({@link accrueDrivingLeg} injects the mid-leg rest). Pure deterministic
   * selection — the spare scan is in STABLE registration order and reads only the
   * virtual-clock `availableAtMin` map, never wall-clock; it makes ZERO `hosRng`
   * draws (the relay adds duty events, not random durations).
   *
   * @returns The driverId that will drive the leg (post-swap when a relay fired).
   */
  const selectDriverForLeg = (
    trailerId: string,
    tripId: string,
    legMinutes: number,
    departIso: string,
  ): string => {
    const nowMin = isoToEpochMinutes(departIso);
    const current = driverByTrailer.get(trailerId)!;
    const currentClock = clockByDriver.get(current)!;

    // Remaining legal drive minutes for a driver evaluated AT the dispatch
    // instant (Phase-10 HOS-03). The bound driver keeps the trailer iff it can
    // legally complete the WHOLE leg with no mandatory rest (so the trailer would
    // not park). A driver whose clock is freshly anchored at `nowMin` has the
    // full 11h/14h budget; one mid-cycle has less.
    const remainingFor = (clock: HosClock): number =>
      mayDriveNow(clock, hosLimits, nowMin)
        ? remainingLegalDriveMinutes(clock, hosLimits, nowMin)
        : 0;
    const currentRemaining = remainingFor(currentClock);

    // No relay when the bound driver can finish the leg outright (the common,
    // short-leg case).
    if (currentRemaining >= legMinutes) {
      availableAtMinByDriver.set(current, nowMin); // confirm it is on-duty now.
      return current;
    }

    // The bound driver cannot finish the leg → look for a FRESH relay driver from
    // the spare pool. A spare is eligible iff it is free now (`availableAtMin <=
    // now`); its clock is RE-ANCHORED to the dispatch instant when it comes on
    // duty for the relay (it just took a ≥10h reset waiting in the pool), so a
    // chosen spare has the full legal budget. We swap only when the fresh driver
    // would legally drive STRICTLY MORE of the leg than the tired bound driver —
    // i.e. the handoff actually moves freight further before any park. Scan in
    // stable registration order; the FIRST eligible spare wins (deterministic).
    const fullFreshBudget = remainingFor(freshHosClock(departIso));
    let fresh: string | undefined;
    if (fullFreshBudget > currentRemaining) {
      for (const candidate of sparePool) {
        if (candidate === current) continue;
        if (availableAtMinByDriver.get(candidate)! > nowMin) continue; // busy.
        fresh = candidate;
        break;
      }
    }

    if (fresh === undefined) {
      // Pool exhausted (or a fresh driver would not help) — fall back to the
      // Phase-11 park: keep the tired driver and let `accrueDrivingLeg` inject
      // the mid-leg rest.
      return current;
    }

    // RELAY (SIM-HOS-04). Emit the swap, rebind the trailer to the fresh driver
    // (clock re-anchored at the dispatch instant), and put the tired driver into
    // a 10h off-duty reset so it re-enters the pool later.
    const swap: DriverSwappedAtHub = {
      type: "DriverSwappedAtHub",
      schemaVersion: 1,
      payload: {
        outgoingDriverId: current,
        incomingDriverId: fresh,
        hubId: center.hubId,
        tripId,
        trailerId,
        occurredAt: departIso,
      },
    };
    emit(`trailer-${trailerId}`, swap);

    // The tired driver rests (a 10h reset anchored at the swap instant). Its
    // per-shift clocks zero and it becomes available again after the reset
    // elapses — re-entering the spare pool to relay a future trailer.
    const restedClock: HosClock = {
      ...freshHosClock(epochMinutesToIso(nowMin + hosLimits.resetOffDutyMin)),
      weeklyOnDutyMin: currentClock.weeklyOnDutyMin,
    };
    clockByDriver.set(current, restedClock);
    availableAtMinByDriver.set(current, nowMin + hosLimits.resetOffDutyMin);
    emitDutyState(current, "resting", "relay-handoff", restedClock);
    if (!sparePool.includes(current)) sparePool.push(current);
    const idx = sparePool.indexOf(fresh);
    if (idx >= 0) sparePool.splice(idx, 1);

    // The fresh driver comes on duty NOW with a clock anchored at this instant
    // (full legal budget for the leg).
    driverByTrailer.set(trailerId, fresh);
    clockByDriver.set(fresh, freshHosClock(departIso));
    availableAtMinByDriver.set(fresh, nowMin);
    return fresh;
  };

  // --- Trailer trips: one trailer per spoke, looping center -> spoke -> center.
  const departTrailer = (trailerId: string, spoke: Hub, departTick: number): void => {
    tripCounter += 1;
    const tripId = `TRIP${String(tripCounter).padStart(5, "0")}`;

    // Drain this spoke's pending manifest onto the trailer (load scans first).
    const manifest = pendingBySpoke.get(spoke.hubId)!;
    const loaded = manifest.splice(0, manifest.length);
    for (const packageId of loaded) {
      const loadScan: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: center.hubId, scanType: "load" },
      };
      emit(`package-${packageId}`, loadScan);
    }

    // SIM-HOS-05: LoadStarted is emitted BEFORE the TrailerDeparted (after the
    // load scans), gated by `hosOn` so off-mode stays byte-identical.
    if (hosOn) {
      emitPhase("LoadStarted", trailerId, center.hubId, tripId);
    }

    const departed: TrailerDeparted = {
      type: "TrailerDeparted",
      schemaVersion: 1,
      payload: {
        trailerId,
        fromHubId: center.hubId,
        toHubId: spoke.hubId,
        tripId,
        packageIds: loaded,
      },
    };
    emit(`trailer-${trailerId}`, departed);

    // Per-departure seeded log-normal transit (right-skewed; same seed ⇒ same).
    // TIME-01: the outbound leg is center→spoke, so transit is drawn from THAT
    // leg's geography-derived per-leg params (a long coast leg dwarfs a short one).
    // Drawn HERE (before the HOS dispatch decision) so the relay can ask whether
    // the bound driver can legally complete THIS leg's minutes. No other timing
    // draw is interleaved in this function, so the timing-substream draw ORDER is
    // unchanged vs Phase 11 — the HOS-off stream stays byte-identical.
    const transitTicks = drawTransitTicks(center.hubId, spoke.hubId);

    // SIM-HOS-02/04: pick the dispatch driver — a relay/swap fires here when the
    // bound driver is out of legal hours for the leg (DriverSwappedAtHub), else
    // the bound driver keeps the trailer. Then open the driving shift for the
    // CHOSEN driver. The driver↔trip linkage is carried by `DriverAssignedToTrip`
    // (the `TrailerDeparted` payload is `.strict()` with no driver field — the
    // assignment event is the single source of the binding, DRY with DRV-03).
    let restTicks = 0;
    if (hosOn) {
      const driverId = selectDriverForLeg(
        trailerId,
        tripId,
        transitTicks,
        clock.nowIso(),
      );
      const assigned: DriverAssignedToTrip = {
        type: "DriverAssignedToTrip",
        schemaVersion: 1,
        payload: { driverId, tripId, trailerId, occurredAt: clock.nowIso() },
      };
      emit(`driver-${driverId}`, assigned);
      emitDutyState(driverId, "driving", "trip-dispatched", clockByDriver.get(driverId)!);
    }

    // SIM-03: DOCK-PORTAL reads as the loaded packages cross the door. Strong
    // RSSI, one candidate read per tag, subject to missRate (drops are omitted).
    if (rfidEnabled && loaded.length > 0) {
      emitRfid("portal", trailerId, center.hubId, loaded);
    }

    // SIM-HOS-03: accrue the driving leg through the shared HOS engine and push
    // the arrival later by any mandatory break/rest minutes. After a successful
    // relay the dispatched driver is fresh, so the leg fits with no rest and the
    // trailer departs ON TIME; only when the pool was exhausted (no swap) does
    // the tired driver park mid-leg. ZERO `hosRng` draws when HOS is off.
    let legRests: readonly { reason: "rest-10h" | "break-30min"; minutes: number }[] = [];
    if (hosOn) {
      const driverId = driverByTrailer.get(trailerId)!;
      const accrued = accrueDrivingLeg(driverId, transitTicks, clock.nowIso());
      restTicks = accrued.extra;
      legRests = accrued.rests;
    }

    // SP2 (spec §5): accrue this leg's MILES onto the trailer's odometer and decide
    // whether the trailer refuels on this leg (odometer crosses the threshold).
    // The leg miles are outbound center→spoke (matching `transitTicks`'s directed
    // leg). ZERO state when fuel is off (the odometer map is empty) ⇒ byte-identical.
    let refuelTicks = 0;
    let refuelOdometer = 0;
    let didRefuel = false;
    if (fuelOn) {
      const accrued = (odometerByTrailer.get(trailerId) ?? 0) + legMilesFor(center.hubId, spoke.hubId);
      if (accrued >= fuelConfig.refuelThresholdMiles) {
        didRefuel = true;
        refuelOdometer = accrued;
        odometerByTrailer.set(trailerId, 0);
        refuelTicks = Math.round(fuelConfig.refuelTimeMinutes);
      } else {
        odometerByTrailer.set(trailerId, accrued);
      }
    }

    // No-double-count (spec §5): the leg's added arrival time is `max(rest,
    // refuel)` — the refuel OVERLAPS any co-located rest, so a refuel inside a
    // >= refuelTime rest adds NO extra delay and a lone refuel adds exactly
    // `refuelTimeMinutes`. With refuel off (`refuelTicks === 0`) this is exactly
    // `restTicks` — byte-identical to the prior HOS-only arrival.
    const addedTicks = Math.max(restTicks, refuelTicks);
    if (hosOn) {
      const driverId = driverByTrailer.get(trailerId)!;
      // The driver is in-flight until the leg (plus any park/refuel) completes, so
      // it is unavailable for relay until then — re-entering the pool on arrival.
      availableAtMinByDriver.set(
        driverId,
        isoToEpochMinutes(clock.nowIso()) + transitTicks + addedTicks,
      );
    }
    const arriveTick = departTick + transitTicks + addedTicks;

    // SP2 (spec §5/§6): schedule the MAP-VISIBLE stop events at a deterministic
    // MID-LEG tick (halfway through the driving portion) so the geo-track
    // projection interpolates a genuine MID-ROUTE position (a stop stamped at the
    // departure tick would render on top of the origin hub). The mid-leg tick is a
    // pure function of `departTick + transitTicks` (no RNG), so it is fully
    // reproducible; emitting via the queue keeps `occurredAt` non-decreasing. Gated
    // on `fuelOn` ⇒ ZERO extra events when fuel is off (byte-identical golden).
    if (fuelOn && (legRests.length > 0 || didRefuel)) {
      const midLegTick = departTick + Math.floor(transitTicks / 2);
      schedule(midLegTick, {
        kind: "midLegStops",
        trailerId,
        tripId,
        legRests: legRests.map((r) => ({ reason: r.reason, minutes: r.minutes })),
        didRefuel,
        refuelOdometer,
      });
    }

    schedule(arriveTick, {
      kind: "arriveTrailer",
      trailerId,
      spokeHubId: spoke.hubId,
      tripId,
      carried: loaded,
      arriveTick,
    });
  };

  const arriveTrailer = (
    trailerId: string,
    spoke: Hub,
    tripId: string,
    carried: readonly string[],
    arriveTick: number,
  ): void => {
    const arrived: TrailerArrivedAtHub = {
      type: "TrailerArrivedAtHub",
      schemaVersion: 1,
      payload: { trailerId, hubId: spoke.hubId, tripId },
    };
    emit(`trailer-${trailerId}`, arrived);

    const docked: TrailerDocked = {
      type: "TrailerDocked",
      schemaVersion: 1,
      payload: { trailerId, hubId: spoke.hubId, dockDoorId: `${spoke.hubId}-DOCK1` },
    };
    emit(`trailer-${trailerId}`, docked);

    // SIM-HOS-05: UnloadStarted follows TrailerDocked (gated by `hosOn`).
    if (hosOn) {
      emitPhase("UnloadStarted", trailerId, spoke.hubId, tripId);
    }

    // SIM-03: TRAILER-ANTENNA burst during the dwell window — multiple noisier,
    // zone-ish reads per carried tag so the fusion engine's dwell windowing is
    // exercised. Subject to missRate; dropped reads are simply omitted.
    if (rfidEnabled && carried.length > 0) {
      emitRfid("antenna", trailerId, spoke.hubId, carried);
    }

    // F-07 / SNS-05: OPT-IN over-carry. Before unloading, decide (against the
    // seeded over-carry substream) whether to HOLD BACK at most ONE carried
    // package — modelling an operator that fails to pull one block at the spoke.
    // The held-back package is destined for THIS spoke yet rides on, so once the
    // spoke records a departure the SNS-05 detector (UNCHANGED) can catch it.
    // The draw is gated on `overCarryEnabled`, so the over-carry substream is
    // NEVER consumed when the knob is off ⇒ the golden stream is byte-identical.
    let heldBack: string | undefined;
    if (overCarryEnabled && carried.length > 0) {
      if (overCarryRng.next() < overCarryRate) {
        // Deterministic choice: the LAST carried package (stable, id-free pick).
        heldBack = carried[carried.length - 1];
      }
    }

    // Unload each carried package at the destination spoke EXCEPT the held-back
    // one: unload scan then arrival (the package has reached its destination hub).
    for (const packageId of carried) {
      if (packageId === heldBack) continue;
      const unload: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: spoke.hubId, scanType: "unload" },
      };
      emit(`package-${packageId}`, unload);

      const atHub: PackageArrivedAtHub = {
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId, hubId: spoke.hubId },
      };
      emit(`package-${packageId}`, atHub);

      // Phase-22 OUT-01: a package unloaded at this spoke has reached its
      // DESTINATION hub (in a hub-and-spoke network a package only lands at a
      // spoke when that spoke is its destination; center arrivals are
      // transshipment and never schedule delivery). When outbound delivery is ON,
      // schedule a ONE-SHOT `deliverPackage` after a seeded dwell >= 1 tick — so
      // `PackageDelivered` fires at a STRICTLY-LATER tick than this arrival
      // (D-22-2). The task is DATA (carries the locked slaDeadlineIso, undefined
      // for center-origin freight) so a chunk boundary mid-dwell is byte-identical.
      if (outboundOn && outboundRng !== undefined) {
        const dwell = 1 + outboundRng.int(OUTBOUND_DWELL_TICKS_MAX); // >= 1
        const fireTick = arriveTick + dwell;
        scheduleNext(fireTick, {
          kind: "deliverPackage",
          packageId,
          hubId: spoke.hubId,
          slaDeadlineIso: slaDeadlineByPackage.get(packageId),
          fireTick,
        });
      }
    }

    // SIM-HOS-05: UnloadCompleted follows the last unload scan at this spoke
    // (gated by `hosOn`). The held-back over-carried package keeps riding, but
    // the spoke's unload PHASE for the dropped packages is complete here.
    if (hosOn) {
      emitPhase("UnloadCompleted", trailerId, spoke.hubId, tripId);
    }

    // F-07: emit the SPOKE-ORIGIN return departure carrying the held-back
    // package, then schedule its unload back at the center. This is the ONLY
    // place a `TrailerDeparted.fromHubId != center` is produced — and only when
    // over-carry actually fires — so the missed-unload gate becomes satisfiable
    // WITHOUT changing the detector or perturbing the golden.
    if (heldBack !== undefined) {
      tripCounter += 1;
      const returnTripId = `TRIP${String(tripCounter).padStart(5, "0")}`;
      const overCarried = [heldBack];

      const returnDeparted: TrailerDeparted = {
        type: "TrailerDeparted",
        schemaVersion: 1,
        payload: {
          trailerId,
          fromHubId: spoke.hubId,
          toHubId: center.hubId,
          tripId: returnTripId,
          packageIds: overCarried,
        },
      };
      emit(`trailer-${trailerId}`, returnDeparted);

      // SIM-03: a DOCK-PORTAL read positively observes the over-carried package
      // aboard the trailer AFTER the spoke is recorded departed — the corroborated
      // strong-RSSI read the fusion layer needs to clear the calibrated detection
      // gate (a single antenna read alone sits near the uniform floor).
      if (rfidEnabled) {
        emitRfid("portal", trailerId, spoke.hubId, overCarried);
      }

      // Schedule the return arrival at the center, which unloads the over-carried
      // package there (so it does NOT skew spoke utilization/SLA). A fresh
      // per-departure transit draw (the return leg is its own departure).
      // TIME-01: the return leg is spoke→center, so it draws from that directed
      // leg's geography-derived params.
      const returnArriveTick = arriveTick + drawTransitTicks(spoke.hubId, center.hubId);
      const overCarriedId = heldBack;
      schedule(returnArriveTick, {
        kind: "arriveOverCarriedAtCenter",
        trailerId,
        packageId: overCarriedId,
        tripId: returnTripId,
      });
    }

    // FLOW-01/02/03: spoke→center CONSOLIDATION. When consolidation is ON, this
    // arriving trailer (now at the spoke, about to turn around for the center)
    // picks up the spoke's staged consolidation freight for the return leg —
    // mirroring the over-carry return leg but carrying the WHOLE drained manifest
    // (real freight, not a single held-back package). `arriveTrailer` fires ONE
    // trailer at a time in queue order, and the drain is an ATOMIC splice, so two
    // trailers can NEVER take the same packages (the double-drain guard); a second
    // trailer at the same spoke sees an empty manifest and departs EMPTY (FLOW-03,
    // a valid, deterministic empty return — no silent/random empties).
    if (consolidationOn) {
      const atSpoke = pendingAtSpoke.get(spoke.hubId)!;
      // Deterministic sort key (priority + tick + freightId): the manifest is
      // filled in induction order; sorting by the unique, monotonic freightId
      // (packageId) before the splice gives a stable, replay-identical order
      // independent of any incidental insertion timing. NO RNG.
      atSpoke.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // ATOMIC peek+pop in one statement — the double-drain guard.
      const consolidated = atSpoke.splice(0, atSpoke.length);

      tripCounter += 1;
      const consolidationTripId = `TRIP${String(tripCounter).padStart(5, "0")}`;

      // Load scans for the consolidation freight at the spoke (origin of the leg).
      for (const packageId of consolidated) {
        const loadScan: PackageScanned = {
          type: "PackageScanned",
          schemaVersion: 1,
          payload: { packageId, hubId: spoke.hubId, scanType: "load" },
        };
        emit(`package-${packageId}`, loadScan);
      }

      // SPOKE-ORIGIN consolidation departure (fromHubId=spoke, toHubId=center).
      // packageIds may be EMPTY (a valid empty return) — a deterministic
      // consequence of an empty `pendingAtSpoke` at this scheduled turnaround.
      const consolidationDeparted: TrailerDeparted = {
        type: "TrailerDeparted",
        schemaVersion: 1,
        payload: {
          trailerId,
          fromHubId: spoke.hubId,
          toHubId: center.hubId,
          tripId: consolidationTripId,
          packageIds: consolidated,
        },
      };
      emit(`trailer-${trailerId}`, consolidationDeparted);

      // SIM-03: a DOCK-PORTAL read positively observes the consolidation freight
      // aboard the trailer as it departs the spoke (parity with the over-carry
      // return leg's corroborating read). Gated on RFID so the non-RFID stream is
      // unaffected; skipped for an empty return (no freight to observe).
      if (rfidEnabled && consolidated.length > 0) {
        emitRfid("portal", trailerId, spoke.hubId, consolidated);
      }

      // Schedule the center arrival + re-sort. A fresh per-departure transit draw
      // for the spoke→center return leg (its own departure). Carries the drained
      // packageIds ARRAY as DATA so a resume reconstructs the cross-dock exactly.
      const consolidationArriveTick =
        arriveTick + drawTransitTicks(spoke.hubId, center.hubId);
      schedule(consolidationArriveTick, {
        kind: "arriveConsolidationAtCenter",
        trailerId,
        packageIds: consolidated,
        tripId: consolidationTripId,
      });
    }

    // TIME-02: model the trailer's full turnaround as TWO role-keyed dwells, each
    // applied EXACTLY ONCE (PITFALLS P4 — no double-count). The trailer first
    // turns around at the SPOKE (`dwellSpoke`), then returns to the center where
    // the cross-dock re-dispatch incurs the distinct, longer `dwellCenter`. The
    // next outbound departure is `arriveTick + dwellSpoke + dwellCenter`. Both
    // draws come from the seeded timing substream in deterministic queue order,
    // so a fixed seed + config stays byte-identical. (The over-carried return
    // arrival at the center is a terminal unload, not a re-dispatch, so it does
    // NOT draw a center dwell — the center dwell is owned by this re-dispatch site
    // alone.)
    const spokeDwell = drawDwellTicks("spoke");
    const centerDwell = drawDwellTicks("center");
    const nextDepart = arriveTick + spokeDwell + centerDwell;
    // CONT-02 / Plan 19-08: keep re-dispatching so the fleet cycles indefinitely.
    // `scheduleNext` RETAINS the task on the resumable path (captured into the
    // continuation) and DROPS it past `durationTicks` on the finite all-at-once
    // path (byte-identical goldens, DET-01).
    scheduleNext(nextDepart, {
      kind: "departTrailer",
      trailerId,
      spokeHubId: spoke.hubId,
      departTick: nextDepart,
    });
  };

  /**
   * F-07: the return-leg arrival at the center for an over-carried package. It
   * mirrors the normal arrival (TrailerArrivedAtHub + TrailerDocked) and unloads
   * the single over-carried package at the center, so the package finally leaves
   * the trailer and the demo stays utilization/SLA-clean. Time + ids are all
   * deterministic (no draw against any rng here).
   */
  const arriveOverCarriedAtCenter = (
    trailerId: string,
    packageId: string,
    tripId: string,
  ): void => {
    const arrived: TrailerArrivedAtHub = {
      type: "TrailerArrivedAtHub",
      schemaVersion: 1,
      payload: { trailerId, hubId: center.hubId, tripId },
    };
    emit(`trailer-${trailerId}`, arrived);

    const docked: TrailerDocked = {
      type: "TrailerDocked",
      schemaVersion: 1,
      payload: { trailerId, hubId: center.hubId, dockDoorId: `${center.hubId}-DOCK1` },
    };
    emit(`trailer-${trailerId}`, docked);

    const unload: PackageScanned = {
      type: "PackageScanned",
      schemaVersion: 1,
      payload: { packageId, hubId: center.hubId, scanType: "unload" },
    };
    emit(`package-${packageId}`, unload);

    const atHub: PackageArrivedAtHub = {
      type: "PackageArrivedAtHub",
      schemaVersion: 1,
      payload: { packageId, hubId: center.hubId },
    };
    emit(`package-${packageId}`, atHub);
  };

  /**
   * FLOW-02: the spoke→center CONSOLIDATION trailer's center arrival + RE-SORT
   * (the cross-dock). It mirrors {@link arriveOverCarriedAtCenter} (the trailer's
   * arrival + dock) but, for EACH consolidated package, unloads it at the center
   * AND re-stages it into `pendingBySpoke[destSpoke]` — so the existing
   * center→spoke distribution picks it up toward its onward spoke (Decision 2).
   * An EMPTY manifest (a valid empty return) docks the trailer and re-stages
   * nothing. All ids/times are deterministic (no draw against any rng here).
   */
  const arriveConsolidationAtCenter = (
    trailerId: string,
    packageIds: readonly string[],
    tripId: string,
  ): void => {
    const arrived: TrailerArrivedAtHub = {
      type: "TrailerArrivedAtHub",
      schemaVersion: 1,
      payload: { trailerId, hubId: center.hubId, tripId },
    };
    emit(`trailer-${trailerId}`, arrived);

    const docked: TrailerDocked = {
      type: "TrailerDocked",
      schemaVersion: 1,
      payload: { trailerId, hubId: center.hubId, dockDoorId: `${center.hubId}-DOCK1` },
    };
    emit(`trailer-${trailerId}`, docked);

    for (const packageId of packageIds) {
      const unload: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: center.hubId, scanType: "unload" },
      };
      emit(`package-${packageId}`, unload);

      const atHub: PackageArrivedAtHub = {
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId, hubId: center.hubId },
      };
      emit(`package-${packageId}`, atHub);

      // The cross-dock: re-stage into the onward spoke's distribution manifest so
      // the existing center→spoke departure carries it the rest of the way. The
      // dest was locked at induction (`consolidationDestByPackage`); fail loud if
      // a package arrived without a recorded dest (an impossible-but-quiet state).
      const destHubId = consolidationDestByPackage.get(packageId);
      if (destHubId === undefined) {
        throw new Error(
          `arriveConsolidationAtCenter: no onward destination recorded for ` +
            `consolidation package "${packageId}" — invalid state`,
        );
      }
      consolidationDestByPackage.delete(packageId);
      pendingBySpoke.get(destHubId)!.push(packageId);
    }
  };

  /** Schedule an action at `fireTick` with a stable insertion-order tie-break. */
  function schedule(fireTick: number, task: SimTask): void {
    queue.push(fireTick, queue.claimSeq(), task);
  }

  /**
   * Self-rescheduling helper for the unbounded generators (package batches +
   * trailer re-dispatch). Plan 19-08: it ALWAYS schedules the next task so the
   * work is RETAINED in the queue and captured into the continuation — the
   * resumable core's drain loop is the SOLE horizon ceiling. This is byte-identical
   * to the pre-19-08 finite path because a task scheduled BEYOND `durationTicks`
   * has a strictly-greater `fireTick`, so the drain loop never pops it (it can
   * never tie with an in-horizon task), and scheduling is pure (no RNG, no emit).
   * The legacy `runUntilStopped` open-ended streaming path keeps polling `stop`.
   */
  function scheduleNext(fireTick: number, task: SimTask): void {
    schedule(fireTick, task);
  }

  /** Dispatch one DATA task — the single switch that reconstructs every action. */
  function dispatch(task: SimTask): void {
    switch (task.kind) {
      case "createPackageBatch":
        createPackageBatch(task.tick);
        return;
      case "inductPackage":
        inductPackage(task.tick);
        return;
      case "departTrailer":
        departTrailer(task.trailerId, hubById.get(task.spokeHubId)!, task.departTick);
        return;
      case "arriveTrailer":
        arriveTrailer(
          task.trailerId,
          hubById.get(task.spokeHubId)!,
          task.tripId,
          task.carried,
          task.arriveTick,
        );
        return;
      case "midLegStops":
        for (const rest of task.legRests) {
          emitTruckRested(task.trailerId, task.tripId, rest.reason, rest.minutes);
        }
        if (task.didRefuel) {
          emitTruckRefueled(task.trailerId, task.tripId, task.refuelOdometer);
        }
        return;
      case "arriveOverCarriedAtCenter":
        arriveOverCarriedAtCenter(task.trailerId, task.packageId, task.tripId);
        return;
      case "arriveConsolidationAtCenter":
        arriveConsolidationAtCenter(task.trailerId, task.packageIds, task.tripId);
        return;
      case "deliverPackage":
        // Phase-22 OUT-01: one-shot terminal delivery. The locked slaDeadlineIso
        // travels on the DATA task (undefined for center-origin freight), so a
        // resume mid-dwell computes `onTime` identically without the world map.
        deliverPackage(task.packageId, task.hubId, task.slaDeadlineIso);
        return;
    }
  }

  // --- Seed the initial schedule (FRESH run only) ---------------------------
  // First package batch at tick 0; one trailer per spoke departs at tick 1 so
  // the first batch is available to load (deterministic, fixed offsets). On a
  // RESUME the queue is restored from the continuation, so this is skipped.
  if (!resuming) {
    schedule(0, { kind: "createPackageBatch", tick: 0 });
    for (const entry of trailerRoster) {
      schedule(entry.departTick, {
        kind: "departTrailer",
        trailerId: entry.trailerId,
        spokeHubId: entry.spoke.hubId,
        departTick: entry.departTick,
      });
    }
    // v2.0 IND-02: seed the first induction (off by default). On a RESUME the
    // pending induction task is restored from the captured queue, so this is
    // skipped — the self-rescheduling chain continues uninterrupted.
    if (inductionOn) {
      schedule(INDUCTION_START_TICK, {
        kind: "inductPackage",
        tick: INDUCTION_START_TICK,
      });
    }
  }

  // --- Drive the queue up to the horizon ------------------------------------
  // Plan 19-08: the resumable core drains tasks with `fireTick <= horizonTick`
  // and STOPS at the horizon, leaving later tasks in the queue for the next chunk
  // (captured into the continuation). The legacy `runUntilStopped` streaming path
  // (open-ended.unit.test) ignores the horizon and polls the cooperative `stop()`
  // predicate instead. Either way the emitted stream up to the horizon is
  // byte-identical to the all-at-once `simulate()` (the keystone).
  const openEnded = opts.runUntilStopped === true;
  const shouldStop = opts.stop;
  for (;;) {
    if (openEnded && shouldStop !== undefined && shouldStop()) break;
    const action = queue.pop();
    if (action === undefined) break;
    if (!openEnded && action.fireTick > durationTicks) {
      // Past the horizon — put it back so the continuation captures it intact.
      queue.push(action.fireTick, action.seq, action.task);
      break;
    }
    clock.advance(action.fireTick - currentTick(clock));
    dispatch(action.task);
  }

  // --- Capture the continuation (the resume point AFTER this chunk) ---------
  const continuation = captureContinuation();

  return { events: out, continuation };

  /** Build the serializable continuation from the current engine state. */
  function captureContinuation(): SimContinuation {
    const world: SerializedWorldState = {
      pendingBySpoke: [...pendingBySpoke.entries()].map(
        ([k, v]) => [k, [...v]] as const,
      ),
      // FLOW-01: capture the consolidation queue so a chunked run that crosses a
      // boundary mid-consolidation is byte-identical to all-at-once. On the off
      // path every spoke maps to [] (zero behaviour), so this does not perturb the
      // off-path stream — the captured shape matches the empty restore.
      pendingAtSpoke: [...pendingAtSpoke.entries()].map(
        ([k, v]) => [k, [...v]] as const,
      ),
      // FLOW-02: the consolidation package → onward-destination map, captured so a
      // resume between staging and the center re-sort cross-docks to the same
      // spoke. Empty on the off path (byte-identical to pre-Phase-21).
      consolidationDestByPackage: [...consolidationDestByPackage.entries()].map(
        ([k, v]) => [k, v] as const,
      ),
      odometerByTrailer: [...odometerByTrailer.entries()].map(
        ([k, v]) => [k, v] as const,
      ),
      driverByTrailer: [...driverByTrailer.entries()].map(([k, v]) => [k, v] as const),
      clockByDriver: [...clockByDriver.entries()].map(
        ([k, v]) => [k, serializeHosClock(v)] as const,
      ),
      availableAtMinByDriver: [...availableAtMinByDriver.entries()].map(
        ([k, v]) => [k, v] as const,
      ),
      sparePool: [...sparePool],
      packageCounter,
      tripCounter,
      inductionCounter,
      // Phase-22 OUT-01: the delivered counter + the in-flight delivery deadline
      // map, captured so a chunked run that crosses a boundary mid-dwell is
      // byte-identical to all-at-once. Empty/0 on the off path (byte-identical to
      // pre-Phase-22), so this does not perturb the off-path stream.
      deliveredCounter,
      slaDeadlineByPackage: [...slaDeadlineByPackage.entries()].map(
        ([k, v]) => [k, v] as const,
      ),
    };
    return {
      version: 1,
      seed,
      // The next virtual tick to resume at: one past the horizon we drained to
      // (the clock is currently at the last-fired tick ≤ horizon; the next chunk
      // re-anchors at this value). Use the horizon+1 so resume math is uniform.
      nextTick: durationTicks + 1,
      rng: {
        base: rng.getState(),
        rfid: rfidRng.getState(),
        overCarry: overCarryRng.getState(),
        timing: timingRng.getState(),
        hos: hosRng.getState(),
        fuel: fuelRng?.getState(),
        induction: inductionRng?.getState(),
        outbound: outboundRng?.getState(),
      },
      queue: queue.snapshot(),
      nextSeq: queue.peekNextSeq(),
      world,
      nextSequenceId,
    };
  }
}

/**
 * Plan 19-08 (determinism fix) — the SINGLE canonical HOS-clock key order.
 *
 * The domain HOS builders (`freshHosClock`, `applyDrivingLeg`'s mid-leg reset at
 * `hos.ts:250`, the various `{ ...current, … }` spread-updates) each produce a
 * `HosClock` with a DIFFERENT object key order — same VALUES, different insertion
 * order. The all-at-once path emits whichever order the builder produced; a
 * chunked run that crosses a continuation boundary rehydrates the clock via
 * {@link serializeHosClock} (this fixed order) and re-emits it — so the SAME clock
 * serialized to DIFFERENT bytes, breaking byte-identity (the
 * continuation-equivalence keystone hashes key-order-sensitive `JSON.stringify`).
 *
 * The fix: normalize EVERY emitted `DriverDutyStateChanged.payload.clock` (and the
 * serialized continuation form) through this ONE canonical key order, so both
 * paths emit byte-identical events. Values are untouched — only key order is
 * fixed. HOS is OFF by default, so the HOS-off goldens (seed-42 10k, seed-1234)
 * contain NO HosClock and are unaffected.
 */
function canonicalHosClock(c: HosClock): HosClock {
  return {
    driveTodayMin: c.driveTodayMin,
    dutyWindowStartAt: c.dutyWindowStartAt,
    sinceLastBreakMin: c.sinceLastBreakMin,
    weeklyOnDutyMin: c.weeklyOnDutyMin,
    comeOnDutyAt: c.comeOnDutyAt,
    sleeperBerthLongMin: c.sleeperBerthLongMin,
    sleeperBerthShortMin: c.sleeperBerthShortMin,
  };
}

/** Serialize an HOS clock into the continuation's plain-data form (canonical order). */
function serializeHosClock(c: HosClock): SerializedHosClock {
  // Shares the SINGLE canonical key order with the emit site (DRY): the
  // SerializedHosClock shape is exactly the canonical HosClock field set.
  return canonicalHosClock(c);
}


/** Current tick of the clock relative to the epoch (integer ticks elapsed). */
function currentTick(clock: VirtualClock): number {
  const elapsed = clock.now().getTime() - Date.parse(EPOCH_ISO);
  return Math.round(elapsed / MS_PER_TICK);
}

// --- Public API -------------------------------------------------------------

/**
 * Pure generator: the full deterministic event stream for `opts`, with no
 * database and no ambient state. Same seed -> byte-identical array.
 *
 * Plan 19-08: REIMPLEMENTED on top of the resumable {@link runToHorizon} core —
 * a fresh run to the `durationTicks` horizon, returning the collected events. The
 * result is BYTE-IDENTICAL to the pre-19-08 finite path (the seed-1234 + seed-42
 * goldens are unchanged; the continuation-equivalence test proves the chunked
 * path matches this all-at-once stream exactly). When `runUntilStopped` +
 * `onEvent` are supplied (the legacy streaming surface) events are delivered to
 * the callback and the returned array is empty — unchanged behaviour.
 */
export function simulate(opts: SimulateOptions): SimulatedEvent[] {
  if (!Number.isInteger(opts.durationTicks) || opts.durationTicks < 0) {
    throw new RangeError(
      `durationTicks must be a non-negative integer, got ${opts.durationTicks}`,
    );
  }
  const { events } = runToHorizon({ seed: opts.seed }, opts.durationTicks, opts);
  return events;
}

/**
 * Drive the SAME deterministic stream into the injected `sink` (typically
 * `appendToStream` + inline projections). Events are delivered strictly in
 * generation order; the sink may be async (awaited sequentially) so per-stream
 * version ordering is preserved.
 */
export async function runSimulation(opts: RunSimulationOptions): Promise<void> {
  const stream = simulate(opts);
  for (const item of stream) {
    await opts.sink(item);
  }
}
