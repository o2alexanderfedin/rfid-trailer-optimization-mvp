import type {
  ActionSuggested,
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
  SuggestionAccepted,
  SuggestionRejected,
  TrailerArrivedAtHub,
  TrailerDeparted,
  TrailerDiverted,
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
import { USA_HUBS, generateBigCityHubs, hubRegisteredEvent } from "./network/hubs.js";
import {
  buildRoutes,
  buildTransitParamsByLeg,
  loadStaticRoadGeometry,
  routeId,
  type RouteTopology,
} from "./network/routes.js";
import {
  DEFAULT_CENTER_COUNT,
  DEFAULT_LEG_CAP_KM,
  assignSpokesToNearestCenter,
  buildBackbone,
  pickRegionalCenters,
} from "./network/centers.js";
import { makeRng, makeRngFromState, type Rng } from "./rng.js";
import {
  type AgentObservation,
  type HubObservation,
  canonicalizeOodaPayload,
  decideHub,
  decideTruck,
  deriveAgentRng,
  hubDockFeasibility,
  sortAgentsByStableId,
  truckLegFeasibility,
} from "./ooda/index.js";
import {
  type CoordinatorLease,
  type CoordinatorObservation,
  type CoordinatorSuggestion,
  type ObservedSpoke,
  type ObservedTruck,
  acquireLease,
  arbitrateSuggestion,
  canonicalizeSuggestionPayload,
  decideCoordinatorSuggestions,
  deriveCoordinatorRng,
  inBackoff,
  isExpired,
  isPruned,
  leaseAvailable,
  nextBackoffUntil,
  passesHysteresis,
  recordReject,
  updateHysteresisMarker,
} from "./coordinator/index.js";
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

  /**
   * NET-01 (Phase 23): OPT-IN continental multi-center topology. **DEFAULT FALSE —
   * the determinism keystone.** When absent or `false`, the engine runs the legacy
   * 10-hub single-center (Memphis) star EXACTLY as before: `hubs = USA_HUBS`,
   * `center = hubs[0]`, `buildRoutes(hubs)` (no topology) ⇒ the seed-1234 + seed-42
   * goldens are BYTE-IDENTICAL (DET-01). It is checked with a STRICT `=== true`
   * comparison (never `??`/`||`, which would make an absent flag accidentally
   * truthy and perturb the golden).
   *
   * When `true`, the engine swaps in the committed continental big-city hub set
   * (`generateBigCityHubs`), picks {@link centerCount} regional sort centers
   * (`pickRegionalCenters`), assigns each spoke to its nearest center within
   * {@link legCapKm} (`assignSpokesToNearestCenter`), and builds a near-full-mesh
   * center<->center backbone. Freight then flows spoke -> its center -> backbone ->
   * destination center -> destination spoke, with each spoke's center resolved per
   * spoke (NOT a single global Memphis). The topology is PURE (committed data, no
   * RNG): NO new substream/salt is constructed for it, so the flag-off path draws
   * exactly the same values it always did.
   */
  readonly continentalTopology?: boolean;
  /**
   * NET-02: number of regional centers when {@link continentalTopology} is on.
   * Ignored when the flag is off. Defaults to the topology module's
   * `DEFAULT_CENTER_COUNT` (a sensible value inside the locked 4-8 envelope); the
   * concrete empirical value is finalized in plan 23-05's center-count checkpoint.
   */
  readonly centerCount?: number;
  /**
   * NET-03: spoke->center leg-length cap (km) when {@link continentalTopology} is
   * on. Ignored when the flag is off. Defaults to the topology module's
   * `DEFAULT_LEG_CAP_KM`.
   */
  readonly legCapKm?: number;

  /**
   * OODA-01/02 (Phase 24): OPT-IN decentralized agent decision core. **DEFAULT
   * FALSE — the determinism keystone.** When absent or `false`, the engine
   * schedules NO `stepAgents` task, constructs ZERO per-agent OODA substreams,
   * and runs the EXISTING centralized decision code UNCHANGED ⇒ the seed-42 10k
   * golden is BYTE-IDENTICAL to `3920accc…` (the two-part flags-off gate, like
   * `outboundDeliveryEnabled`/`continentalTopology`). It is checked with a STRICT
   * `=== true` comparison (never `??`/`||`, which would make an absent flag
   * accidentally truthy and perturb the golden).
   *
   * When `true`, a self-rescheduling `stepAgents` EventQueue task fires at a fixed
   * `OODA_INTERVAL_TICKS` cadence (mirroring `inductPackage`). Each pass builds a
   * FROZEN observation per agent at pass entry, iterates agents in
   * sorted-by-stable-id order, applies an "anything-to-decide?" guard, and routes
   * each decision's Act through the EXISTING `emit` (plus the new `TrailerDiverted`
   * for the divert choice) via the pure 24-01 `decideTruck` / 24-02 `decideHub`.
   * Under the flag the agents OWN the dispatch/hold/refuel/rest/consolidate
   * decisions and the engine's centralized code for those points is BYPASSED (no
   * double-decision). Per-agent OODA substreams are constructed LAZILY (only on
   * the on path). A flag-on run is REPRODUCIBLE per seed (same seed twice ⇒
   * byte-identical); capturing the full OODA-on golden is plan 24-04.
   */
  readonly oodaAgentsEnabled?: boolean;

  /**
   * COORD-01/02 (Phase 25): OPT-IN per-center advisory coordination process-
   * managers. **DEFAULT FALSE — the determinism keystone.** When absent or
   * `false`, the engine schedules NO `stepCoordinators` task, constructs ZERO
   * per-center coordinator substreams, emits NO `ActionSuggested`, and populates NO
   * `pendingSuggestionsByTarget` ⇒ the seed-42 10k golden is BYTE-IDENTICAL to
   * `3920accc…` (the two-part flags-off gate, like `oodaAgentsEnabled`). It is
   * checked with a STRICT `=== true` comparison (never `??`/`||`, which would make
   * an absent flag accidentally truthy and perturb the golden).
   *
   * When `true`, a self-rescheduling `stepCoordinators` EventQueue task fires at a
   * fixed `COORDINATOR_INTERVAL_TICKS` cadence (mirroring `stepAgents`). Each pass
   * builds a FROZEN per-center observation at pass entry, iterates the regional
   * centers in sorted-by-centerId order over a BOUNDED per-center scope, generates
   * RULE-BASED advisory suggestions for all four kinds (reroute / hold /
   * consolidate / dispatch) via the pure 25-02 `decideCoordinatorSuggestions`, and
   * emits each as an `ActionSuggested` (on `coordinator-<centerId>`, payload pinned
   * through `canonicalizeSuggestionPayload`) AND records it in an in-engine
   * `pendingSuggestionsByTarget` map for the SAME-tick agent handshake (consumed by
   * the Phase-24 `stepAgents` step in Plan 03). Per-center coordinator substreams
   * are constructed LAZILY (only on the on path, only for a center that suggests).
   * A flag-on run is REPRODUCIBLE per seed (same seed twice ⇒ byte-identical);
   * capturing the full coordinator-on golden is Plan 05.
   */
  readonly coordinatorsEnabled?: boolean;
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

// --- Phase-24 OODA step-agents (OODA-01/02) ---------------------------------

/**
 * OODA-01/02: ticks between successive `stepAgents` passes — a fixed modular
 * constant like {@link PACKAGE_INTERVAL_TICKS}/{@link INDUCTION_INTERVAL_TICKS}
 * (pure tick arithmetic, no wall-clock). Chosen 5 (Claude's discretion per
 * ARCHITECTURE §3: "1 or 5"): a per-5-tick cadence is cheaper than every tick yet
 * fine-grained enough for the demo. The cadence is PART of the OODA model, so it is
 * baked into the new OODA-on golden (captured in 24-04). OFF by default ⇒ no pass
 * is ever scheduled, so this constant never affects the flags-off golden.
 */
const OODA_INTERVAL_TICKS = 5;
/** First `stepAgents` pass fires at tick 1 (deterministic, fixed offset; off by default). */
const OODA_START_TICK = 1;
/**
 * COORD-01: ticks between successive `stepCoordinators` passes. SAME cadence as
 * `OODA_INTERVAL_TICKS` so a coordinator pass ALWAYS lands on the same tick as an
 * agent pass — the precondition for the SAME-TICK suggestion handshake (Plan 03
 * consumes `pendingSuggestionsByTarget` in `stepAgents`). The cadence is PART of
 * the coordinator model, so it is baked into the coordinator-on golden (captured in
 * Plan 05). OFF by default ⇒ no pass is ever scheduled, so this never affects the
 * flags-off golden.
 */
const COORDINATOR_INTERVAL_TICKS = 5;
/**
 * First `stepCoordinators` pass fires at the SAME start tick as `stepAgents`
 * (deterministic, fixed offset; off by default). The bootstrap seeds the
 * coordinator task BEFORE the agent task at this tick, so it claims a LOWER queue
 * seq and dispatches FIRST within the tick — coordinators emit, then the agents
 * arbitrate the suggestions in the same tick (the same-tick handshake, Plan 03).
 */
const COORDINATOR_START_TICK = 1;
/**
 * COORD-04: the sim-time TTL stamped on every `ActionSuggested` (~6 sim-minutes).
 * An unaccepted suggestion self-destructs after this window (the Plan-04 TTL
 * guard owns the expiry/enforcement; this plan just STAMPS it from a named
 * constant so the value is reproducible + baked into the Plan-05 coordinator-on
 * golden). 6 ticks × `MS_PER_TICK` (1 tick = 1 sim-minute) = 360_000 sim-ms.
 */
const COORDINATOR_TTL_SIM_MS = 6 * MS_PER_TICK;
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

  // Phase-24 OODA-01/02: the decentralized agent decision core is OPT-IN and
  // DEFAULT OFF. Absent/false ⇒ the engine schedules NO `stepAgents` task,
  // constructs ZERO per-agent OODA substreams, and runs the existing centralized
  // decision code UNCHANGED, so all existing goldens are byte-identical (the
  // determinism keystone). STRICT `=== true` — never `??`/`||` (an absent flag
  // must stay falsy). When ON, agents OWN dispatch/hold/refuel/rest/consolidate and
  // the centralized code for those points is bypassed (no double-decision).
  const oodaAgentsEnabled = opts.oodaAgentsEnabled === true;

  // Phase-25 COORD-01/02: the per-center advisory coordinators are OPT-IN and
  // DEFAULT OFF. Absent/false ⇒ the engine schedules NO `stepCoordinators` task,
  // constructs ZERO per-center coordinator substreams, emits NO `ActionSuggested`,
  // and populates NO `pendingSuggestionsByTarget`, so all existing goldens are
  // byte-identical to 3920accc… (the determinism keystone). STRICT `=== true` —
  // never `??`/`||` (an absent flag must stay falsy). When ON, one coordinator per
  // center generates rule-based advisory suggestions in-fold (Task 3 body).
  const coordinatorsEnabled = opts.coordinatorsEnabled === true;

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

  /**
   * Phase-24 OODA-01: per-trailer ACTIVE trip context the `stepAgents` truck
   * observation reads — the trip id + the directed leg the trailer is currently
   * driving (`fromHubId -> toHubId`). Populated at `departTrailer` ONLY when
   * `oodaAgentsEnabled` (a single map write, no event), so a flag-off run leaves it
   * empty and adds ZERO behaviour to the centralized stream. In-process for 24-02;
   * OODA-05 serializes it into the continuation for chunked-run equivalence.
   */
  const activeTripByTrailer = new Map<
    string,
    { readonly tripId: string; readonly fromHubId: string; readonly toHubId: string }
  >();
  // OODA-05: restore the captured active-trip context on resume so a chunked OODA-on
  // run picks up each in-flight leg exactly where the previous chunk left it (the
  // continuation-equivalence keystone). Empty on a fresh run and on the off path
  // (the captured array is `[]` whenever `oodaAgentsEnabled` is off), so this adds
  // ZERO behaviour to the flag-off stream.
  if (resuming) {
    for (const [trailerId, trip] of start.world.activeTripByTrailer) {
      activeTripByTrailer.set(trailerId, {
        tripId: trip.tripId,
        fromHubId: trip.fromHubId,
        toHubId: trip.toHubId,
      });
    }
  }
  const timingConfig: TimingConfig = timing ?? DEFAULT_TIMING_CONFIG;

  /**
   * Phase-25 COORD-01/02: the in-engine same-tick suggestion handshake substrate.
   * Each `ActionSuggested` the in-fold `stepCoordinators` pass emits is ALSO
   * recorded here, keyed by `targetAgentId`, so the SAME tick's `stepAgents` pass
   * (Plan 03) can consume the pending suggestions and accept/reject them. Populated
   * ONLY on the coordinators-on path (Task 3); on the off path NO entry is ever
   * written (no coordinator runs), so it stays empty and the flag-off stream is
   * byte-identical to 3920accc… — the off-path inertness guarantee. The map is
   * allocated unconditionally (an empty Map is semantically inert — it changes no
   * draw/emit/ordering); what MUST be off-path-inert is any write into it, which
   * only happens under the flag. Serialization into the continuation is Plan 05.
   */
  const pendingSuggestionsByTarget = new Map<string, ActionSuggested[]>();
  // COORD-01/02 continuation-equivalence: restore any captured cross-tick pending
  // suggestions on resume. Each pending event is rebuilt through the SAME
  // `canonicalizeSuggestionPayload` the emit site uses, so the rehydrated payload key
  // order is byte-identical to the all-at-once form. Empty on the off path and on a
  // within-tick-consumed run (the captured array is `[]`), so this adds ZERO behaviour
  // to the flag-off stream.
  if (resuming) {
    for (const [target, list] of start.world.pendingSuggestionsByTarget) {
      pendingSuggestionsByTarget.set(
        target,
        list.map((s) => ({
          type: "ActionSuggested",
          schemaVersion: 1,
          payload: canonicalizeSuggestionPayload({
            suggestionId: s.suggestionId,
            coordinatorId: s.coordinatorId,
            targetAgentId: s.targetAgentId,
            kind: s.kind,
            params: s.params.toHubId !== undefined ? { toHubId: s.params.toHubId } : {},
            issuedAtSimMs: s.issuedAtSimMs,
            ttlSimMs: s.ttlSimMs,
          }),
        })),
      );
    }
  }

  /**
   * Phase-25 COORD-04: the five-guard sim-time STATE, threaded through the
   * `stepCoordinators` filter + the `stepAgents` handshake. Each is a plain Map of
   * a stable composite-string key → a plain integer / lease value (the smallest
   * serializable shape — Plan 05 persists these into `SerializedWorldState`). They
   * are read/advanced ONLY on the coordinators-on path (every WRITE is under the
   * flag), so a flag-off run never touches them and the 3920accc… golden holds.
   *
   *  - `leaseByAgent`         : targetAgentId → the live single-owner lease (GUARD 4).
   *  - `rejectCountByOption`  : `${coordinatorId}|${targetAgentId}|${kind}` →
   *                             rejection count (GUARDs 2+5 — pruning + backoff key).
   *  - `backoffUntilByOption` : same option key → backoff-until sim-ms (GUARD 2).
   *  - `metricAboveSinceByOption`: `${coordinatorId}|${targetAgentId}|${kind}` →
   *                             the metric-above-since sim-ms marker (GUARD 1).
   *  - `lastCenterByAgent`    : targetAgentId → the agent's last-seen owning center;
   *                             a change clears that agent's prune/hysteresis (the
   *                             shift/zone-change reset, GUARD 5).
   */
  const leaseByAgent = new Map<string, CoordinatorLease>();
  const rejectCountByOption = new Map<string, number>();
  const backoffUntilByOption = new Map<string, number>();
  const metricAboveSinceByOption = new Map<string, number>();
  const lastCenterByAgent = new Map<string, string>();
  // COORD-04 continuation-equivalence: restore the five guard state maps on resume so
  // a chunked/continued coordinator-on run picks up each lease/prune/backoff/
  // hysteresis exactly where the previous chunk left it (T-25-19). Empty on a fresh
  // run AND on the off path (the captured arrays are `[]` whenever
  // `coordinatorsEnabled` is off), so this adds ZERO behaviour to the flag-off stream
  // (the 3920accc… keystone holds).
  if (resuming) {
    for (const [agentId, lease] of start.world.leaseByAgent) {
      leaseByAgent.set(agentId, {
        coordinatorId: lease.coordinatorId,
        expiresAtSimMs: lease.expiresAtSimMs,
      });
    }
    for (const [key, count] of start.world.rejectCountByOption) rejectCountByOption.set(key, count);
    for (const [key, until] of start.world.backoffUntilByOption)
      backoffUntilByOption.set(key, until);
    for (const [key, since] of start.world.metricAboveSinceByOption)
      metricAboveSinceByOption.set(key, since);
    for (const [agentId, centerId] of start.world.lastCenterByAgent)
      lastCenterByAgent.set(agentId, centerId);
  }
  /** The stable per-option guard key (GUARDs 2+5+1). */
  const optionKey = (coordinatorId: string, targetAgentId: string, kind: string): string =>
    `${coordinatorId}|${targetAgentId}|${kind}`;

  // NET-01 (Phase 23): resolve the network topology. The flag is read with a
  // STRICT `=== true` (never `??`/`||`) so an absent flag stays falsy and the
  // legacy single-center star runs byte-identically (the determinism keystone).
  // When OFF: `hubs = USA_HUBS`, `routeTopology = undefined`, and `centerOf`
  // collapses to the single `hubs[0]` center — so every downstream call site is
  // EXACTLY today's behavior. When ON: the committed continental hub set, the
  // picked regional centers, the nearest-center spoke assignment, and the
  // near-full-mesh backbone drive a multi-center `RouteTopology`. The topology is
  // PURE (committed data, deterministic functions) — NO new RNG substream is
  // constructed, so the off path draws the exact same sequence it always did.
  const continentalOn = opts.continentalTopology === true;
  const hubs: readonly Hub[] = continentalOn ? generateBigCityHubs() : USA_HUBS;
  const centerCount = Math.max(2, Math.floor(opts.centerCount ?? DEFAULT_CENTER_COUNT));
  const legCapKm = opts.legCapKm ?? DEFAULT_LEG_CAP_KM;
  // The multi-center assignment (spoke hubId -> center hubId). Empty when off.
  const continentalCenterOf: ReadonlyMap<string, string> = continentalOn
    ? (() => {
        const bigCityHubs = generateBigCityHubs();
        const centers = pickRegionalCenters(bigCityHubs, centerCount);
        const centerIds = new Set(centers.map((c) => c.hubId));
        const spokeHubs = bigCityHubs.filter((h) => !centerIds.has(h.hubId));
        return assignSpokesToNearestCenter(spokeHubs, centers, legCapKm);
      })()
    : new Map<string, string>();
  // The directed center<->center backbone (empty when off).
  const continentalBackbone = continentalOn
    ? buildBackbone(pickRegionalCenters(generateBigCityHubs(), centerCount))
    : [];
  const routeTopology: RouteTopology | undefined = continentalOn
    ? { centerOf: continentalCenterOf, backbone: continentalBackbone }
    : undefined;

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
  // NET-01: when continental, build the per-leg map over the full hub set + the
  // multi-center topology so EVERY spoke<->center + backbone leg has params. When
  // off, this is `buildTransitParamsByLeg(USA_HUBS, sigma)` — byte-identical.
  const transitByLeg = buildTransitParamsByLeg(
    hubs,
    timingConfig.transit.sigma,
    undefined,
    routeTopology,
  );
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

  // NET-01: `center` is the LEGACY single center (`hubs[0]`) — still the global
  // dispatch hub when the flag is off (byte-identical). When continental, the
  // per-spoke center is resolved via `centerOf(spokeHubId)` instead; `center` is
  // then only the deterministic fallback for any spoke without an explicit
  // assignment (e.g. a center hub itself, which is never iterated as a spoke).
  const center = hubs[0]!;
  // Spokes: when off, every hub after `hubs[0]`. When continental, every hub that
  // is NOT a center (the assignment's key set), sorted by hubId for stable order.
  const centerIds = new Set(continentalCenterOf.values());
  const spokes: readonly Hub[] = continentalOn
    ? hubs.filter((h) => !centerIds.has(h.hubId)).slice()
    : hubs.slice(1);
  const routes = buildRoutes(hubs, undefined, routeTopology);

  // NET-01: resolve a spoke's owning center. OFF ⇒ always the single `hubs[0]`
  // center (so every legacy `center.hubId` use is byte-identical). ON ⇒ the
  // spoke's assigned center from `assignSpokesToNearestCenter`, falling back to
  // `hubs[0]` only for an unmapped id (defensive; never hit for a valid spoke).
  const hubByIdAll = new Map<string, Hub>(hubs.map((h) => [h.hubId, h]));
  const centerOf = (spokeHubId: string): Hub => {
    if (!continentalOn) return center;
    const centerHubId = continentalCenterOf.get(spokeHubId);
    const resolved = centerHubId !== undefined ? hubByIdAll.get(centerHubId) : undefined;
    return resolved ?? center;
  };

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
        // OODA-05 fix (T-24-12): seed to 0 ONLY on a FRESH run — on a RESUME the
        // odometer was already restored from `start.world.odometerByTrailer` above,
        // so this seeding MUST NOT overwrite the restored mid-leg miles back to 0
        // (a latent continuation gap the OODA-on refuel decision — which reads the
        // accrued odometer — makes observable: a chunk boundary would lose the
        // accrued miles and the agent would never cross the refuel threshold).
        if (fuelOn && !resuming) odometerByTrailer.set(`T${id}`, 0);
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

  /**
   * Phase-25 COORD-02 (consume half): emit the agent's accept/reject verdict on a
   * coordinator's `ActionSuggested`. Both fire on the TARGET agent's OWN stream
   * (`trailer-<id>` / `hub-<id>`) — the agent is the author of record (the un-
   * overridable contract: the agent, not the coordinator, decides). `occurredAt` is
   * the virtual clock (DET-03: never `Date.now()`); only the `suggestionId` (+ the
   * closed `reasonCode` on a reject) is carried, so no new hashed payload shape
   * needs a canonicalizer this plan.
   */
  const emitSuggestionAccepted = (
    targetStreamId: string,
    suggestionId: string,
  ): void => {
    const event: SuggestionAccepted = {
      type: "SuggestionAccepted",
      schemaVersion: 1,
      payload: { suggestionId, occurredAt: clock.nowIso() },
    };
    emit(targetStreamId, event);
  };
  const emitSuggestionRejected = (
    targetStreamId: string,
    suggestionId: string,
    reasonCode: SuggestionRejected["payload"]["reasonCode"],
  ): void => {
    const event: SuggestionRejected = {
      type: "SuggestionRejected",
      schemaVersion: 1,
      payload: { suggestionId, reasonCode, occurredAt: clock.nowIso() },
    };
    emit(targetStreamId, event);
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
    const registerDriver = (driverId: string, homeHubId: string = center.hubId): void => {
      clockByDriver.set(driverId, freshHosClock(nowIso));
      availableAtMinByDriver.set(driverId, nowMin);
      const registered: DriverRegistered = {
        type: "DriverRegistered",
        schemaVersion: 1,
        payload: { driverId, homeHubId, occurredAt: nowIso },
      };
      emit(`driver-${driverId}`, registered);
    };
    // Primary roster: one driver bound to each trailer (from `trailerRoster`;
    // D001…D00N at fleetPerSpoke=1, continuing the sequence for extra slots).
    // NET-01: a primary driver homes at its trailer's spoke center. OFF ⇒ `hubs[0]`
    // (byte-identical to the legacy single dispatch hub).
    for (const entry of trailerRoster) {
      driverByTrailer.set(entry.trailerId, entry.driverId);
      registerDriver(entry.driverId, centerOf(entry.spoke.hubId).hubId);
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
      // NET-01: the package is created at the DEST spoke's owning center (so the
      // existing center->spoke distribution carries it). OFF ⇒ `hubs[0]` (the
      // legacy single center, byte-identical); ON ⇒ `centerOf(dest)`.
      const originCenter = centerOf(dest.hubId);

      const created: PackageCreated = {
        type: "PackageCreated",
        schemaVersion: 1,
        payload: {
          packageId,
          originHubId: originCenter.hubId,
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
        payload: { packageId, hubId: originCenter.hubId, scanType: "inbound" },
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
    // NET-01: the route legs are inductionHub → centerOf(inductionHub) → [backbone
    // → centerOf(destHub)] → destHub. OFF ⇒ `centerOf` returns `hubs[0]` = `center`,
    // so the two-leg estimate is byte-identical to the legacy single-center one.
    const originCenter = centerOf(inductionHub.hubId);
    const destCenter = centerOf(destHub.hubId);
    const backboneMin =
      continentalOn && destCenter.hubId !== originCenter.hubId
        ? expectedTransitMinutes(originCenter, destCenter, timingConfig)
        : 0;
    const transitMin =
      expectedTransitMinutes(inductionHub, originCenter, timingConfig) +
      expectedDwellMinutes("center", timingConfig) +
      backboneMin +
      expectedTransitMinutes(destCenter, destHub, timingConfig);
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
   * Phase-24 OODA-02: the HUB AGENT's consolidate/dispatch Act. Drains the spoke's
   * staged consolidation manifest (`pendingAtSpoke`) onto its home trailer and emits
   * the SAME spoke→center consolidation `TrailerDeparted` + `arriveConsolidationAtCenter`
   * the centralized cadence emits (REUSE existing events, CONTEXT decision) — just
   * DECIDED locally by the hub agent. Mirrors the inline block in `arriveTrailer`,
   * but the departure fires at the CURRENT tick (the agent's pass), not on a
   * trailer's scheduled turnaround. Only reached on the OODA-on path (the
   * centralized cadence is bypassed under the flag), so the off stream is unaffected.
   *
   * Determinism: the home trailer is the FIRST trailer rostered to this spoke
   * (stable roster order, no RNG); the manifest is drained by an ATOMIC splice after
   * a stable id sort (the double-drain guard); the center-arrival transit is a
   * seeded `timingRng` draw in deterministic queue order.
   */
  const dispatchHubConsolidation = (spoke: Hub): void => {
    const atSpoke = pendingAtSpoke.get(spoke.hubId);
    if (atSpoke === undefined || atSpoke.length === 0) return; // nothing staged
    // The hub's home trailer: the first trailer rostered to this spoke (stable).
    const home = trailerRoster.find((e) => e.spoke.hubId === spoke.hubId);
    if (home === undefined) return;
    const trailerId = home.trailerId;
    const spokeCenter = centerOf(spoke.hubId);

    // Stable id sort + ATOMIC splice (the double-drain guard, no RNG).
    atSpoke.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const consolidated = atSpoke.splice(0, atSpoke.length);

    tripCounter += 1;
    const consolidationTripId = `TRIP${String(tripCounter).padStart(5, "0")}`;

    for (const packageId of consolidated) {
      const loadScan: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: spoke.hubId, scanType: "load" },
      };
      emit(`package-${packageId}`, loadScan);
    }

    const consolidationDeparted: TrailerDeparted = {
      type: "TrailerDeparted",
      schemaVersion: 1,
      payload: {
        trailerId,
        fromHubId: spoke.hubId,
        toHubId: spokeCenter.hubId,
        tripId: consolidationTripId,
        packageIds: consolidated,
      },
    };
    emit(`trailer-${trailerId}`, consolidationDeparted);

    if (rfidEnabled && consolidated.length > 0) {
      emitRfid("portal", trailerId, spoke.hubId, consolidated);
    }

    const consolidationArriveTick =
      isoToEpochMinutes(clock.nowIso()) + drawTransitTicks(spoke.hubId, spokeCenter.hubId);
    schedule(consolidationArriveTick, {
      kind: "arriveConsolidationAtCenter",
      trailerId,
      packageIds: consolidated,
      tripId: consolidationTripId,
      ...(continentalOn ? { centerHubId: spokeCenter.hubId } : {}),
    });
  };

  /**
   * Phase-24 OODA-01/02: the per-tick agent step pass — the decentralized decision
   * core. A self-rescheduling EventQueue task (like {@link inductPackage}) so the
   * order stays single-threaded + deterministic. Guards on `oodaAgentsEnabled` so
   * the off path NEVER runs (the determinism keystone): zero passes, zero events,
   * zero per-agent substream construction — the flags-off golden is byte-identical.
   *
   * On the ON path it builds a FROZEN observation per agent at pass ENTRY, iterates
   * agents in sorted-by-stable-id order (the order-independence witness), applies
   * the "anything-to-decide?" guard, runs the pure 24-01 `decideTruck` / 24-02
   * `decideHub` over each frozen observation, and routes each decision's Act through
   * the EXISTING emit helpers (plus the new `TrailerDiverted`). The pass body lands
   * in Task 3; this skeleton is the empty-but-self-rescheduling foundation so the
   * OFF path is provably inert (byte-identical) before any agent logic is wired.
   */
  const stepAgents = (tick: number): void => {
    if (!oodaAgentsEnabled) return; // never runs when off (the determinism keystone)

    // === OBSERVE: build the FROZEN observation surface at pass ENTRY ===========
    // PITFALLS Pitfall 4 (T-24-05): read the in-engine fold maps ONCE here, into a
    // plain-data snapshot per agent. The Decide/Act loop below NEVER re-reads the
    // fold maps — so a peer's same-tick Act can't couple another agent's decision
    // to iteration order (the agent-order-shuffle test is the witness).

    // Frozen per-hub inbound queue depth (center→spoke distribution manifest).
    const queueDepthByHub = new Map<string, number>();
    for (const [hubId, ids] of pendingBySpoke) queueDepthByHub.set(hubId, ids.length);
    // Frozen per-hub pending-consolidation manifest size (spoke→center staging).
    const consolidationDepthByHub = new Map<string, number>();
    for (const [hubId, ids] of pendingAtSpoke) consolidationDepthByHub.set(hubId, ids.length);
    // A hub's single dock is "busy" once its inbound queue reaches this depth — a
    // deterministic integer proxy for dock occupancy (no live dock fold map). Tuned
    // so a lightly-loaded hub proceeds and a congested one blocks (drives divert).
    const DOCK_BUSY_QUEUE = 8;
    const dockAvailableForHub = (hubId: string): boolean =>
      (queueDepthByHub.get(hubId) ?? 0) < DOCK_BUSY_QUEUE;

    /** Build a FROZEN truck observation from the fold maps (integers/strings only). */
    const observeTruck = (entry: TrailerRosterEntry): AgentObservation => {
      const trailerId = entry.trailerId;
      const trip = activeTripByTrailer.get(trailerId);
      const nextHubId = trip?.toHubId ?? null;
      // HOS remaining (when HOS on): forward-labeled remaining legal drive minutes,
      // rounded to a whole integer (Pitfall 2). When HOS is off there is no driver
      // clock — a benign full-budget default so a non-HOS truck never falsely rests.
      const driverId = driverByTrailer.get(trailerId);
      const hosClock = driverId !== undefined ? clockByDriver.get(driverId) : undefined;
      const nowMin = isoToEpochMinutes(clock.nowIso());
      const remaining =
        hosClock !== undefined
          ? Math.max(
              0,
              Math.round(
                mayDriveNow(hosClock, hosLimits, nowMin)
                  ? remainingLegalDriveMinutes(hosClock, hosLimits, nowMin)
                  : 0,
              ),
            )
          : Number.MAX_SAFE_INTEGER;
      const sinceBreak =
        hosClock !== undefined ? Math.max(0, Math.round(hosClock.sinceLastBreakMin)) : 0;
      const observedClock: AgentObservation["hosClock"] =
        hosClock !== undefined
          ? canonicalHosClock(hosClock)
          : {
              driveTodayMin: 0,
              dutyWindowStartAt: clock.nowIso(),
              sinceLastBreakMin: 0,
              weeklyOnDutyMin: 0,
              comeOnDutyAt: clock.nowIso(),
              sleeperBerthLongMin: 0,
              sleeperBerthShortMin: 0,
            };
      return {
        kind: "truck",
        stableId: trailerId,
        tick,
        tripId: trip?.tripId ?? null,
        assignedCenterId: centerOf(entry.spoke.hubId).hubId,
        currentLegKey:
          trip !== undefined ? `${trip.fromHubId}->${trip.toHubId}` : null,
        // Round the odometer to a whole integer at THIS boundary (Pitfall 2) — the
        // miles are geometry-derived, so they never enter a hashed decision as a float.
        odometerMiles: Math.round(odometerByTrailer.get(trailerId) ?? 0),
        remainingLegalDriveMinutes: remaining,
        minutesSinceLastBreak: sinceBreak,
        hosClock: observedClock,
        nextHubId,
        nextHubQueueDepth: nextHubId !== null ? queueDepthByHub.get(nextHubId) ?? 0 : 0,
        nextHubDockAvailable: nextHubId !== null ? dockAvailableForHub(nextHubId) : true,
      };
    };

    /** Build a FROZEN hub observation from the fold maps (integers/strings only). */
    const observeHub = (hub: Hub): HubObservation => {
      const hubId = hub.hubId;
      return {
        kind: "hub",
        stableId: hubId,
        tick,
        assignedCenterId: centerOf(hubId).hubId,
        inboundQueueDepth: queueDepthByHub.get(hubId) ?? 0,
        outboundQueueDepth: consolidationDepthByHub.get(hubId) ?? 0,
        dockDoorsAvailable: dockAvailableForHub(hubId) ? 1 : 0,
        trailerFillCount: consolidationDepthByHub.get(hubId) ?? 0,
        pendingConsolidationCount: consolidationDepthByHub.get(hubId) ?? 0,
      };
    };

    // Build the combined agent list. Trucks carry their roster entry (for the Act),
    // hubs carry their Hub. The unified total order is sorted-by-stable-id across
    // BOTH kinds (ARCHITECTURE §3): trailer ids (`T…`) and hub ids share one
    // codepoint-ordered sort, so the per-pass emit `seq` order is a pure function of
    // the stable ids — never Map/Set/array insertion order (T-24-07).
    type TruckAgent = { readonly stableId: string; readonly entry: TrailerRosterEntry };
    type HubAgent = { readonly stableId: string; readonly hub: Hub };
    const truckAgents: TruckAgent[] = trailerRoster.map((entry) => ({
      stableId: entry.trailerId,
      entry,
    }));
    const hubAgents: HubAgent[] = spokes.map((hub) => ({ stableId: hub.hubId, hub }));
    const agents = sortAgentsByStableId<
      ({ readonly kind: "truck" } & TruckAgent) | ({ readonly kind: "hub" } & HubAgent)
    >([
      ...truckAgents.map((a) => ({ kind: "truck" as const, ...a })),
      ...hubAgents.map((a) => ({ kind: "hub" as const, ...a })),
    ]);

    /**
     * Phase-25 COORD-02 (consume half): reconstruct the pure `CoordinatorSuggestion`
     * arbitration input from a recorded `ActionSuggested` event. `arbitrateSuggestion`
     * keys on `kind` (+ `toHubId` for reroute/dispatch) only — this is a thin, total,
     * deterministic adapter (no engine read, no clock, no RNG).
     */
    const suggestedToCoordinatorSuggestion = (
      suggested: ActionSuggested,
    ): CoordinatorSuggestion => {
      const { kind, targetAgentId, params } = suggested.payload;
      switch (kind) {
        case "reroute":
          return { kind, targetAgentId, toHubId: params.toHubId ?? "" };
        case "dispatch":
          return { kind, targetAgentId, toHubId: params.toHubId ?? "" };
        case "hold":
          return { kind, targetAgentId };
        case "consolidate":
          return { kind, targetAgentId };
      }
    };

    /**
     * Phase-25 COORD-02/COORD-03: helper to emit the EXISTING `TrailerDiverted`
     * binding event for an accepted reroute, REUSING the exact same payload
     * construction (+ canonicalizer) the autonomous divert uses — there is NO new
     * binding path. `toHubId` comes from the accepted suggestion's params.
     */
    const emitAcceptedDivert = (
      trailerId: string,
      trip: { readonly tripId: string; readonly fromHubId: string },
      toHubId: string,
    ): void => {
      const diverted: TrailerDiverted = {
        type: "TrailerDiverted",
        schemaVersion: 1,
        payload: canonicalizeOodaPayload({
          trailerId,
          tripId: trip.tripId,
          fromHubId: trip.fromHubId,
          // A coordinator-accepted reroute reuses the OODA divert reason vocabulary
          // (the destination is congested-relief, same as an autonomous divert).
          toHubId,
          reason: "next-hub-congested",
          occurredAt: clock.nowIso(),
        }),
      };
      emit(`trailer-${trailerId}`, diverted);
    };

    /**
     * Phase-25 COORD-04 (GUARDs 2+5): record a rejection of a coordinator
     * suggestion. Advances the (coordinatorId, targetAgentId, kind) option's reject
     * count (toward the K-prune cooldown — GUARD 5) and sets a seeded-jitter
     * exponential backoff-until (GUARD 2) so the NEXT `stepCoordinators` pass
     * suppresses the just-rejected option — this is what bounds events-per-tick under
     * an all-reject scenario (Pitfall 10 Zeno). The backoff jitter is drawn from the
     * per-CENTER coordinator substream (`deriveCoordinatorRng`, DET-03: never
     * `Math.random`). The handshake fires at the SAME tick as the coordinator pass,
     * so `nowSimMs = tick * MS_PER_TICK` is the SAME sim-time the suggestion was
     * stamped with (the guards read one shared clock).
     */
    const recordSuggestionReject = (suggested: ActionSuggested): void => {
      const { coordinatorId, targetAgentId, kind } = suggested.payload;
      const key = `${coordinatorId}|${targetAgentId}|${kind}`;
      const nowSimMs = tick * MS_PER_TICK;
      const count = recordReject(rejectCountByOption.get(key) ?? 0);
      rejectCountByOption.set(key, count);
      // Seeded jitter from the rejecting suggestion's OWN center substream (the same
      // substream `stepCoordinators` derived for that center) — deterministic + lazy.
      const rng = deriveCoordinatorRng(seed, coordinatorId);
      backoffUntilByOption.set(key, nextBackoffUntil(count, nowSimMs, rng));
    };

    // === DECIDE + ACT (sorted iteration; anything-to-decide guard) =============
    for (const agent of agents) {
      if (agent.kind === "truck") {
        const obs = observeTruck(agent.entry);
        const trip = activeTripByTrailer.get(agent.stableId);

        // --- Phase-25 SAME-TICK HANDSHAKE (COORD-02 consume / COORD-03) ----------
        // BINDING LOCAL FEASIBILITY (24-03): the agent's OWN verdict — the un-
        // overridable basis a coordinator cannot override. Computed once here from
        // the SAME shared HOS limits + fuel threshold + virtual-clock epoch-minute
        // the autonomous Decide uses (DRY). `now` is the frozen clock (DET-03).
        const nowMin = isoToEpochMinutes(clock.nowIso());
        const truckVerdict = truckLegFeasibility(
          obs,
          hosLimits,
          {
            // Fuel OFF ⇒ an unreachable threshold so `mustRefuel` never fires (no
            // fuel-driven reject in a fuel-off run); ON ⇒ the SAME engine threshold.
            refuelThresholdMiles: fuelOn
              ? fuelConfig.refuelThresholdMiles
              : Number.MAX_SAFE_INTEGER,
          },
          nowMin,
        );
        // Drain THIS agent's pending suggestions in their stable-ordered list (the
        // coordinator pass appended them in sorted center / sorted index order). For
        // each: arbitrate against the agent's own verdict, then accept (→
        // SuggestionAccepted + the binding event) or reject (→ SuggestionRejected +
        // reasonCode). An accepted suggestion SUPPRESSES the autonomous Act this tick
        // (deterministic precedence — no double-emit, T-25-12).
        const pendingTruck = pendingSuggestionsByTarget.get(agent.stableId);
        let truckSuggestionAccepted = false;
        // The shared sim-time clock for the TTL guard (GUARD 3) + the reject-path
        // backoff: the handshake fires at the SAME tick the coordinator stamped, so
        // `nowSimMs = tick × MS_PER_TICK` is the one virtual clock both read (DET-03:
        // never `Date.now`).
        const nowSimMs = tick * MS_PER_TICK;
        if (pendingTruck !== undefined) {
          for (const suggested of pendingTruck) {
            // GUARD 3 (sim-time TTL): a pending suggestion that survived to a LATER
            // tick (a cross-tick entry restored from a serialized continuation, never
            // drained in its issuing tick) self-destructs once `nowSimMs` passes
            // `issuedAtSimMs + ttlSimMs` — it is DROPPED, never acted on (no
            // accept/reject/binding event, no reject-path counter advance; T-25-17).
            // In the strictly-within-tick handshake `issuedAtSimMs == nowSimMs`, so a
            // fresh suggestion is NEVER expired ⇒ this is a no-op on that path and the
            // goldens are unchanged.
            if (isExpired(suggested.payload.issuedAtSimMs, nowSimMs, suggested.payload.ttlSimMs)) {
              continue;
            }
            const suggestion = suggestedToCoordinatorSuggestion(suggested);
            const verdict = arbitrateSuggestion(suggestion, truckVerdict);
            if (verdict.accepted) {
              emitSuggestionAccepted(`trailer-${agent.stableId}`, suggested.payload.suggestionId);
              // The only truck binding kind is `divert`; `hold`/`none` emit no event.
              if (verdict.bindingKind === "divert" && trip !== undefined) {
                const toHubId = suggested.payload.params.toHubId;
                if (toHubId !== undefined) emitAcceptedDivert(agent.stableId, trip, toHubId);
              }
              truckSuggestionAccepted = true;
            } else {
              emitSuggestionRejected(
                `trailer-${agent.stableId}`,
                suggested.payload.suggestionId,
                verdict.reasonCode,
              );
              // GUARDs 2+5: a reject advances this (coordinator,target,kind) option's
              // reject count (toward the K-prune) AND sets a seeded-jitter exponential
              // backoff so the NEXT coordinator pass suppresses the just-rejected
              // option (the Pitfall-10 re-suggest loop closes). Jitter from the
              // per-CENTER coordinator substream (DET-03: never Math.random).
              recordSuggestionReject(suggested);
            }
          }
          // Clear the per-target entry after consumption (within-tick lifecycle).
          pendingSuggestionsByTarget.delete(agent.stableId);
        }

        // "anything-to-decide?" guard (T-24-05): a truck only runs the AUTONOMOUS
        // Decide/Act when its FROZEN observation shows a pending decision — a binding
        // HOS/fuel trigger or a congested next hub. A mid-leg truck with nothing to
        // choose (or no active trip) is SKIPPED. An accepted suggestion already Acted
        // this tick, so the autonomous Act is suppressed (precedence; no double-emit).
        const hosTrigger =
          obs.remainingLegalDriveMinutes <= 0 || obs.minutesSinceLastBreak >= 8 * 60;
        const fuelTrigger = fuelOn && obs.odometerMiles >= fuelConfig.refuelThresholdMiles;
        const divertTrigger = obs.nextHubId !== null && obs.nextHubQueueDepth > 50;
        if (
          truckSuggestionAccepted ||
          trip === undefined ||
          (!hosTrigger && !fuelTrigger && !divertTrigger)
        ) {
          continue; // nothing to decide (or a suggestion already Acted) — skip
        }
        // Lazy per-agent substream — constructed ONLY here, on the on path, for an
        // agent that actually decides (flag-off allocates nothing).
        const rng = deriveAgentRng(seed, agent.stableId);
        // BINDING LOCAL FEASIBILITY (OODA-03): hand the SHARED HOS limits + fuel
        // threshold + the virtual-clock epoch-minute to the Decide so its first
        // ladder step delegates to the domain HOS engine (`mayDriveNow`/
        // `applyDrivingLeg`) — an infeasible proceed/divert is structurally
        // unreachable. `now` is the frozen observation's virtual clock (DET-03:
        // never `Date.now()`).
        const decision = decideTruck(obs, rng, {
          hosConfig: hosLimits,
          // When fuel is OFF the refuel rule must never fire (no fuel events in a
          // fuel-off run) — pass an unreachable threshold so `mustRefuel` stays
          // false; when ON, pass the SAME `refuelThresholdMiles` the engine uses.
          fuelConfig: {
            refuelThresholdMiles: fuelOn
              ? fuelConfig.refuelThresholdMiles
              : Number.MAX_SAFE_INTEGER,
          },
          now: nowMin,
        });
        // ACT: route each outcome through the EXISTING emit helpers (+ the new
        // TrailerDiverted). proceed/hold are no-ops (no event).
        switch (decision.kind) {
          case "rest":
            emitTruckRested(agent.stableId, trip.tripId, decision.reason, decision.durationMin);
            break;
          case "refuel":
            // The agent owns the refuel under the flag: emit + reset the odometer
            // (the centralized refuel in departTrailer is bypassed when on).
            emitTruckRefueled(agent.stableId, trip.tripId, decision.odometerMiles);
            odometerByTrailer.set(agent.stableId, 0);
            break;
          case "divert": {
            const diverted: TrailerDiverted = {
              type: "TrailerDiverted",
              schemaVersion: 1,
              // DET-03 (Pitfall 7): route the agent-decided payload through the ONE
              // canonicalizer so its hashed key order is byte-stable regardless of
              // how the literal is built or later refactored.
              payload: canonicalizeOodaPayload({
                trailerId: agent.stableId,
                tripId: trip.tripId,
                fromHubId: trip.fromHubId,
                toHubId: decision.toHubId,
                reason: decision.reason,
                occurredAt: clock.nowIso(),
              }),
            };
            emit(`trailer-${agent.stableId}`, diverted);
            break;
          }
          case "proceed":
          case "hold":
            break; // no-op (no event)
        }
      } else {
        const obs = observeHub(agent.hub);

        // --- Phase-25 SAME-TICK HANDSHAKE (COORD-02 consume / COORD-03) ----------
        // The hub's OWN binding dock feasibility verdict (24-03) — a coordinator
        // cannot force a consolidate/dispatch onto a full dock. Drain + arbitrate
        // this hub's pending suggestions BEFORE the autonomous guard so a hub with
        // empty queues still consumes (and honestly rejects) a coordinator advice.
        const hubVerdict = hubDockFeasibility(obs);
        const pendingHub = pendingSuggestionsByTarget.get(agent.stableId);
        let hubSuggestionAccepted = false;
        // The shared sim-time clock for the TTL guard (mirrors the truck branch).
        const nowSimMs = tick * MS_PER_TICK;
        if (pendingHub !== undefined) {
          for (const suggested of pendingHub) {
            // GUARD 3 (sim-time TTL): drop a cross-tick EXPIRED pending suggestion —
            // no accept/reject/binding event, no counter advance (T-25-17). Within-tick
            // (`issuedAtSimMs == nowSimMs`) it never fires ⇒ no golden change.
            if (isExpired(suggested.payload.issuedAtSimMs, nowSimMs, suggested.payload.ttlSimMs)) {
              continue;
            }
            const suggestion = suggestedToCoordinatorSuggestion(suggested);
            const verdict = arbitrateSuggestion(suggestion, hubVerdict);
            if (verdict.accepted) {
              emitSuggestionAccepted(`hub-${agent.stableId}`, suggested.payload.suggestionId);
              // consolidate/dispatch ⇒ the existing consolidation departure; hold ⇒
              // no binding event (the feasible no-op). REUSE — no new binding path.
              if (verdict.bindingKind === "consolidate" || verdict.bindingKind === "dispatch") {
                dispatchHubConsolidation(agent.hub);
              }
              hubSuggestionAccepted = true;
            } else {
              emitSuggestionRejected(
                `hub-${agent.stableId}`,
                suggested.payload.suggestionId,
                verdict.reasonCode,
              );
              // GUARDs 2+5 — advance the reject count + seeded-jitter backoff for the
              // just-rejected (coordinator,target,kind) option (mirrors the truck branch).
              recordSuggestionReject(suggested);
            }
          }
          pendingSuggestionsByTarget.delete(agent.stableId);
        }

        // "anything-to-decide?" guard for hubs: skip a hub with empty inbound +
        // outbound queues AND no pending consolidation (nothing to dispatch/hold/
        // consolidate beyond the no-op default). An accepted suggestion already Acted
        // this tick ⇒ suppress the autonomous Act (precedence; no double-emit).
        if (
          hubSuggestionAccepted ||
          (obs.inboundQueueDepth === 0 &&
            obs.outboundQueueDepth === 0 &&
            obs.pendingConsolidationCount === 0)
        ) {
          continue;
        }
        const rng = deriveAgentRng(seed, agent.stableId);
        const decision = decideHub(obs, rng);
        // ACT: dispatch/consolidate map to the existing consolidation departure; a
        // hold is a no-op. For 24-02 the hub's binding Act is the consolidation
        // dispatch it now owns (the centralized cadence is bypassed under the flag).
        if (decision.kind === "consolidate" || decision.kind === "dispatch") {
          dispatchHubConsolidation(agent.hub);
        }
      }
    }

    // Self-reschedule the NEXT pass at an ABSOLUTE tick (same discipline as
    // inductPackage). `scheduleNext` RETAINS the task on the resumable path
    // (captured into the continuation) or DROPS it past the horizon (finite path).
    const nextTick = tick + OODA_INTERVAL_TICKS;
    scheduleNext(nextTick, { kind: "stepAgents", tick: nextTick });
  };

  /**
   * Phase-25 COORD-01/02: the in-fold per-center coordinator process-manager pass
   * (the structural mirror of `stepAgents`). Self-rescheduling on the
   * `COORDINATOR_INTERVAL_TICKS` cadence; OFF path returns IMMEDIATELY so NO draw,
   * NO emit, NO `pendingSuggestionsByTarget` write, NO reschedule ever happens when
   * the flag is off (the determinism keystone — the off path is provably inert).
   *
   * ON path: build the FROZEN per-center observations ONCE at pass entry from the
   * fold maps (the Decide loop NEVER re-reads them — the order-independence
   * witness, Pitfall 4). Iterate the regional centers in SORTED-by-centerId
   * (codepoint) order. For each center, build its BOUNDED observation (ONLY that
   * center's spokes + in-region trucks — never another center's, COORD-01 scaling
   * thesis), skip a center with nothing to suggest (the anything-to-suggest guard),
   * lazily derive the per-center substream, generate rule-based suggestions, and for
   * each emit an `ActionSuggested` (payload pinned through
   * `canonicalizeSuggestionPayload`) on `coordinator-<centerId>` AND record it in
   * `pendingSuggestionsByTarget` keyed by `targetAgentId` (the same-tick handshake,
   * consumed by `stepAgents` in Plan 03). The coordinator pass fires one queue-seq
   * BEFORE `stepAgents` at a shared tick, so the suggestions are present when the
   * agents run.
   */
  const stepCoordinators = (tick: number): void => {
    if (!coordinatorsEnabled) return; // never runs when off (the determinism keystone)

    // === OBSERVE: build the FROZEN snapshot of the fold maps at pass ENTRY ======
    // Read each fold map ONCE here into plain-data per-hub integers; the per-center
    // Decide below reads ONLY these frozen maps (never the live fold maps), so a
    // peer center's pass can't couple another center's suggestions to iteration
    // order (the order-shuffle witness, Pitfall 4).
    const inboundDepthByHub = new Map<string, number>();
    for (const [hubId, ids] of pendingBySpoke) inboundDepthByHub.set(hubId, ids.length);
    const consolidationDepthByHub = new Map<string, number>();
    for (const [hubId, ids] of pendingAtSpoke) consolidationDepthByHub.set(hubId, ids.length);
    // A spoke's single dock is "busy" once its inbound queue reaches this depth — a
    // deterministic integer proxy for dock occupancy (mirrors the stepAgents
    // DOCK_BUSY_QUEUE proxy; no live dock fold map exists).
    const DOCK_BUSY_QUEUE = 8;
    const dockAvailableForHub = (hubId: string): boolean =>
      (inboundDepthByHub.get(hubId) ?? 0) < DOCK_BUSY_QUEUE;

    // The set of regional centers the coordinators run for: the continental center
    // ids when the topology is on, else the single legacy center (`hubs[0]`) so a
    // coordinator always exists for the demo/test even on the legacy star.
    const coordinatorCenterIds: readonly string[] = (
      centerIds.size > 0 ? [...centerIds] : [center.hubId]
    )
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Sim-time milliseconds since epoch at this frame (non-negative integer; the
    // COORD-04 sim-time TTL substrate). Derived from the tick clock — NEVER
    // `Date.now()` (DET-03).
    const issuedAtSimMs = tick * MS_PER_TICK;

    // Build the FROZEN bounded observation for ONE center: ONLY its own spokes (the
    // spokes whose `centerOf === this center`) and its in-region trucks. Spokes are
    // sorted by hubId and trucks by trailerId so the suggestion order is a pure
    // function of the stable ids (never Map/array insertion order).
    const observeCenter = (centerId: string): CoordinatorObservation => {
      const spokeObs: ObservedSpoke[] = spokes
        .filter((s) => centerOf(s.hubId).hubId === centerId)
        .map((s) => s.hubId)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((hubId) => ({
          hubId,
          inboundQueueDepth: inboundDepthByHub.get(hubId) ?? 0,
          pendingConsolidationCount: consolidationDepthByHub.get(hubId) ?? 0,
          dockAvailable: dockAvailableForHub(hubId),
        }));
      const truckObs: ObservedTruck[] = trailerRoster
        .filter((entry) => centerOf(entry.spoke.hubId).hubId === centerId)
        .slice()
        .sort((a, b) =>
          a.trailerId < b.trailerId ? -1 : a.trailerId > b.trailerId ? 1 : 0,
        )
        .map((entry) => {
          const trip = activeTripByTrailer.get(entry.trailerId);
          const nextHubId = trip?.toHubId ?? null;
          return {
            trailerId: entry.trailerId,
            nextHubId,
            nextHubQueueDepth:
              nextHubId !== null ? inboundDepthByHub.get(nextHubId) ?? 0 : 0,
          };
        });
      return { centerId, tick, issuedAtSimMs, spokes: spokeObs, trucks: truckObs };
    };

    // === DECIDE + GUARD-FILTER + ACT (sorted-by-centerId) ======================
    for (const centerId of coordinatorCenterIds) {
      const obs = observeCenter(centerId);
      // Anything-to-suggest guard (mirror the agent guard): a center with no spokes
      // and no trucks in scope is SKIPPED (never a substream construction). This
      // also makes the lazy-substream contract observable — a center that suggests
      // nothing constructs no `deriveCoordinatorRng`.
      if (obs.spokes.length === 0 && obs.trucks.length === 0) continue;
      // Lazy per-center substream — constructed ONLY here, on the on path, for a
      // center that actually has scope (a flag-off run allocates nothing).
      const rng = deriveCoordinatorRng(seed, centerId);
      const candidates = decideCoordinatorSuggestions(obs, rng);

      // --- GUARD 5 (prune-clearing on zone change) -----------------------------
      // A `centerOf` change for a target (a shift/zone change) re-opens every option
      // for it: clear its accrued reject counts + hysteresis markers so it is not
      // permanently pruned/backed-off from a prior region. Detected per target by
      // comparing the agent's last-seen owning center to this center; a target this
      // center is now scoping that was last scoped by ANOTHER center is "moved".
      for (const c of candidates) {
        const target = c.targetAgentId;
        const prevCenter = lastCenterByAgent.get(target);
        if (prevCenter !== undefined && prevCenter !== centerId) {
          // Zone change: clear this target's per-option guard state across kinds.
          for (const kind of ["reroute", "hold", "consolidate", "dispatch"] as const) {
            const k = optionKey(prevCenter, target, kind);
            rejectCountByOption.delete(k);
            backoffUntilByOption.delete(k);
            metricAboveSinceByOption.delete(k);
          }
        }
        lastCenterByAgent.set(target, centerId);
      }

      // --- GUARD 1 (hysteresis): advance the metric-above-since markers ---------
      // Each candidate's generating rule fired ⇒ its metric is ABOVE threshold this
      // pass. Update the marker for every (centerId, target, kind) option this
      // coordinator MIGHT key on: candidates that fired ⇒ "above" (start/retain the
      // dwell); options with a prior marker that did NOT fire this pass ⇒ cleared
      // (a transient breach that fell back — the dwell resets). Pure helpers only.
      const firedKeys = new Set(
        candidates.map((c) => optionKey(centerId, c.targetAgentId, c.kind)),
      );
      // Clear markers for this center's options whose metric fell back below.
      for (const key of [...metricAboveSinceByOption.keys()]) {
        if (!key.startsWith(`${centerId}|`)) continue;
        if (!firedKeys.has(key)) metricAboveSinceByOption.delete(key);
      }
      // Start/retain markers for the fired candidates.
      for (const c of candidates) {
        const key = optionKey(centerId, c.targetAgentId, c.kind);
        const next = updateHysteresisMarker(
          metricAboveSinceByOption.get(key) ?? null,
          true,
          issuedAtSimMs,
        );
        if (next === null) metricAboveSinceByOption.delete(key);
        else metricAboveSinceByOption.set(key, next);
      }

      // --- Filter each candidate through the five guards (deterministic order) --
      // lease → reject-pruning → backoff → hysteresis. TTL applies to PENDING
      // suggestions (expired on read in the handshake), not to a fresh candidate.
      let emittedIndex = 0;
      for (const suggestion of candidates) {
        const target = suggestion.targetAgentId;
        const key = optionKey(centerId, target, suggestion.kind);

        // GUARD 4 — lease: skip if ANOTHER coordinator holds a live lease on target.
        if (!leaseAvailable(leaseByAgent.get(target) ?? null, centerId, issuedAtSimMs)) {
          continue;
        }
        // GUARD 5 — reject-pruning: skip a (target,kind) rejected ≥ K times.
        if (isPruned(rejectCountByOption.get(key) ?? 0)) continue;
        // GUARD 2 — backoff: skip an option still within its backoff window.
        if (inBackoff(backoffUntilByOption.get(key) ?? null, issuedAtSimMs)) continue;
        // GUARD 1 — hysteresis: skip until the metric has persisted ≥ the dead-band.
        if (!passesHysteresis(metricAboveSinceByOption.get(key) ?? null, issuedAtSimMs)) {
          continue;
        }

        // SURVIVED all guards ⇒ stamp + emit. Deterministic, byte-stable,
        // collision-free suggestionId: one center per centerId, a distinct tick per
        // pass, a sorted SURVIVING index within the pass.
        const suggestionId = `${centerId}-${tick}-${emittedIndex}`;
        emittedIndex += 1;
        const params =
          suggestion.kind === "reroute" || suggestion.kind === "dispatch"
            ? { toHubId: suggestion.toHubId }
            : {};
        const event: ActionSuggested = {
          type: "ActionSuggested",
          schemaVersion: 1,
          // DET-03 (Pitfall 7): route the coordinator-decided payload through the ONE
          // canonicalizer so its hashed key order is byte-stable.
          payload: canonicalizeSuggestionPayload({
            suggestionId,
            coordinatorId: centerId,
            targetAgentId: target,
            kind: suggestion.kind,
            params,
            issuedAtSimMs,
            ttlSimMs: COORDINATOR_TTL_SIM_MS,
          }),
        };
        emit(`coordinator-${centerId}`, event);
        // GUARD 4 — acquire/refresh the single-owner lease on this target so a peer
        // coordinator cannot advise it until the lease expires.
        leaseByAgent.set(target, acquireLease(centerId, issuedAtSimMs));
        // Record for the SAME-tick agent handshake (Plan 03). Append to a per-target
        // list; the emit order (sorted center, sorted surviving index) is byte-stable.
        const existing = pendingSuggestionsByTarget.get(target);
        if (existing !== undefined) existing.push(event);
        else pendingSuggestionsByTarget.set(target, [event]);
      }
    }

    // Self-reschedule the NEXT pass at an ABSOLUTE tick (same discipline as
    // `stepAgents`/`inductPackage`). `scheduleNext` RETAINS the task on the
    // resumable path or DROPS it past the horizon (finite path).
    const nextTick = tick + COORDINATOR_INTERVAL_TICKS;
    scheduleNext(nextTick, { kind: "stepCoordinators", tick: nextTick });
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
    // NET-01: the trailer departs from THIS spoke's owning center. OFF ⇒ `hubs[0]`
    // (byte-identical to the legacy `center.hubId`); ON ⇒ the spoke's assigned center.
    const spokeCenter = centerOf(spoke.hubId);

    // Drain this spoke's pending manifest onto the trailer (load scans first).
    const manifest = pendingBySpoke.get(spoke.hubId)!;
    const loaded = manifest.splice(0, manifest.length);
    for (const packageId of loaded) {
      const loadScan: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: spokeCenter.hubId, scanType: "load" },
      };
      emit(`package-${packageId}`, loadScan);
    }

    // SIM-HOS-05: LoadStarted is emitted BEFORE the TrailerDeparted (after the
    // load scans), gated by `hosOn` so off-mode stays byte-identical.
    if (hosOn) {
      emitPhase("LoadStarted", trailerId, spokeCenter.hubId, tripId);
    }

    const departed: TrailerDeparted = {
      type: "TrailerDeparted",
      schemaVersion: 1,
      payload: {
        trailerId,
        fromHubId: spokeCenter.hubId,
        toHubId: spoke.hubId,
        tripId,
        packageIds: loaded,
      },
    };
    emit(`trailer-${trailerId}`, departed);

    // Phase-24 OODA-01: record this trailer's ACTIVE trip context for the agent
    // observation (the directed leg it is now driving). A single map write, ONLY
    // when OODA is on, so the flag-off stream is byte-identical (no event, no
    // ordering change). The `stepAgents` truck Observe reads this at pass entry.
    if (oodaAgentsEnabled) {
      activeTripByTrailer.set(trailerId, {
        tripId,
        fromHubId: spokeCenter.hubId,
        toHubId: spoke.hubId,
      });
    }

    // Per-departure seeded log-normal transit (right-skewed; same seed ⇒ same).
    // TIME-01: the outbound leg is center→spoke, so transit is drawn from THAT
    // leg's geography-derived per-leg params (a long coast leg dwarfs a short one).
    // Drawn HERE (before the HOS dispatch decision) so the relay can ask whether
    // the bound driver can legally complete THIS leg's minutes. No other timing
    // draw is interleaved in this function, so the timing-substream draw ORDER is
    // unchanged vs Phase 11 — the HOS-off stream stays byte-identical.
    const transitTicks = drawTransitTicks(spokeCenter.hubId, spoke.hubId);

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
      emitRfid("portal", trailerId, spokeCenter.hubId, loaded);
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
    //
    // Phase-24 OODA BYPASS (T-24-06): under `oodaAgentsEnabled` the TRUCK AGENT owns
    // the refuel decision in the `stepAgents` pass, so the centralized refuel here
    // is bypassed (`!oodaAgentsEnabled`) to avoid double-deciding. The odometer is
    // still accrued (the agent reads it as its binding-feasibility input, OODA-03),
    // but the centralized refuel-on-this-leg + reset is the agent's job when on.
    let refuelTicks = 0;
    let refuelOdometer = 0;
    let didRefuel = false;
    if (fuelOn) {
      const accrued = (odometerByTrailer.get(trailerId) ?? 0) + legMilesFor(spokeCenter.hubId, spoke.hubId);
      if (!oodaAgentsEnabled && accrued >= fuelConfig.refuelThresholdMiles) {
        // CENTRALIZED refuel decision (bypassed under OODA — the agent decides).
        didRefuel = true;
        refuelOdometer = accrued;
        odometerByTrailer.set(trailerId, 0);
        refuelTicks = Math.round(fuelConfig.refuelTimeMinutes);
      } else {
        // Always accrue the odometer (the agent's binding-feasibility input under
        // the flag; the no-refuel carry-forward otherwise). Under OODA the agent
        // pass owns the threshold-crossing refuel + reset, so we never reset here.
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
    // NET-01: the spoke's owning center (the return/consolidation legs terminate
    // here). OFF ⇒ `hubs[0]` (byte-identical); ON ⇒ the spoke's assigned center.
    const spokeCenter = centerOf(spoke.hubId);
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
          toHubId: spokeCenter.hubId,
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
      const returnArriveTick = arriveTick + drawTransitTicks(spoke.hubId, spokeCenter.hubId);
      const overCarriedId = heldBack;
      schedule(returnArriveTick, {
        kind: "arriveOverCarriedAtCenter",
        trailerId,
        packageId: overCarriedId,
        tripId: returnTripId,
        // NET-01: the center the over-carried package unloads at. Absent ⇒ the
        // dispatcher falls back to `hubs[0]` (legacy single-center, byte-identical).
        ...(continentalOn ? { centerHubId: spokeCenter.hubId } : {}),
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
    //
    // Phase-24 OODA BYPASS (T-24-06): under `oodaAgentsEnabled` the HUB AGENT owns
    // the consolidate decision in the `stepAgents` pass, so the centralized
    // consolidation-cadence dispatch here is bypassed (`!oodaAgentsEnabled`) to
    // avoid double-deciding.
    if (consolidationOn && !oodaAgentsEnabled) {
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
          toHubId: spokeCenter.hubId,
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
        arriveTick + drawTransitTicks(spoke.hubId, spokeCenter.hubId);
      schedule(consolidationArriveTick, {
        kind: "arriveConsolidationAtCenter",
        trailerId,
        packageIds: consolidated,
        tripId: consolidationTripId,
        // NET-01: the ORIGIN center this consolidation freight arrives at. Absent
        // ⇒ `hubs[0]` (legacy single-center, byte-identical). When the package's
        // dest spoke is served by a DIFFERENT center, the dispatcher hops it across
        // the backbone before final distribution (spoke->center->backbone->center->spoke).
        ...(continentalOn ? { centerHubId: spokeCenter.hubId } : {}),
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
    centerHubId: string = center.hubId,
  ): void => {
    const arrived: TrailerArrivedAtHub = {
      type: "TrailerArrivedAtHub",
      schemaVersion: 1,
      payload: { trailerId, hubId: centerHubId, tripId },
    };
    emit(`trailer-${trailerId}`, arrived);

    const docked: TrailerDocked = {
      type: "TrailerDocked",
      schemaVersion: 1,
      payload: { trailerId, hubId: centerHubId, dockDoorId: `${centerHubId}-DOCK1` },
    };
    emit(`trailer-${trailerId}`, docked);

    const unload: PackageScanned = {
      type: "PackageScanned",
      schemaVersion: 1,
      payload: { packageId, hubId: centerHubId, scanType: "unload" },
    };
    emit(`package-${packageId}`, unload);

    const atHub: PackageArrivedAtHub = {
      type: "PackageArrivedAtHub",
      schemaVersion: 1,
      payload: { packageId, hubId: centerHubId },
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
    arrivalCenterHubId: string = center.hubId,
  ): void => {
    const arrived: TrailerArrivedAtHub = {
      type: "TrailerArrivedAtHub",
      schemaVersion: 1,
      payload: { trailerId, hubId: arrivalCenterHubId, tripId },
    };
    emit(`trailer-${trailerId}`, arrived);

    const docked: TrailerDocked = {
      type: "TrailerDocked",
      schemaVersion: 1,
      payload: { trailerId, hubId: arrivalCenterHubId, dockDoorId: `${arrivalCenterHubId}-DOCK1` },
    };
    emit(`trailer-${trailerId}`, docked);

    for (const packageId of packageIds) {
      const unload: PackageScanned = {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: arrivalCenterHubId, scanType: "unload" },
      };
      emit(`package-${packageId}`, unload);

      const atHub: PackageArrivedAtHub = {
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId, hubId: arrivalCenterHubId },
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

      // NET-01: cross-center routing. The dest spoke is served by `centerOf(dest)`.
      // When that center DIFFERS from this arrival center, the package must hop the
      // backbone (arrivalCenter -> destCenter) BEFORE final center->spoke
      // distribution — the spoke -> origin center -> BACKBONE -> dest center ->
      // dest spoke flow. When the dest center IS this center (single-center, or a
      // same-center pair), the legacy cross-dock applies directly. The OFF path
      // always takes the direct branch (`centerOf` returns `hubs[0]`).
      const destCenter = centerOf(destHubId);
      if (continentalOn && destCenter.hubId !== arrivalCenterHubId) {
        // Backbone hop: a fresh directed center->center departure carrying the
        // package, then a re-staging arrival at the dest center. The dest mapping
        // is RETAINED until the package re-stages at its dest center.
        tripCounter += 1;
        const backboneTripId = `TRIP${String(tripCounter).padStart(5, "0")}`;
        const backboneDeparted: TrailerDeparted = {
          type: "TrailerDeparted",
          schemaVersion: 1,
          payload: {
            trailerId,
            fromHubId: arrivalCenterHubId,
            toHubId: destCenter.hubId,
            tripId: backboneTripId,
            packageIds: [packageId],
          },
        };
        emit(`trailer-${trailerId}`, backboneDeparted);
        // Schedule the dest-center arrival, drawing the backbone leg's transit.
        const backboneArriveTick =
          isoToEpochMinutes(clock.nowIso()) +
          drawTransitTicks(arrivalCenterHubId, destCenter.hubId);
        schedule(backboneArriveTick, {
          kind: "arriveConsolidationAtCenter",
          trailerId,
          packageIds: [packageId],
          tripId: backboneTripId,
          centerHubId: destCenter.hubId,
        });
        continue; // not yet at its final center — do NOT distribute here.
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
      case "stepAgents":
        // Phase-24 OODA-01/02: the decentralized agent step pass. Self-reschedules
        // its successor (off path returns immediately, scheduling nothing).
        stepAgents(task.tick);
        return;
      case "stepCoordinators":
        // Phase-25 COORD-01/02: the in-fold per-center coordinator pass. Self-
        // reschedules its successor (off path returns immediately, scheduling
        // nothing). Seeded one queue-seq BEFORE `stepAgents` at the same start tick
        // so it dispatches FIRST within a shared tick (the same-tick handshake).
        stepCoordinators(task.tick);
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
        arriveOverCarriedAtCenter(
          task.trailerId,
          task.packageId,
          task.tripId,
          task.centerHubId ?? center.hubId,
        );
        return;
      case "arriveConsolidationAtCenter":
        arriveConsolidationAtCenter(
          task.trailerId,
          task.packageIds,
          task.tripId,
          task.centerHubId ?? center.hubId,
        );
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
    // Phase-25 COORD-01/02: seed the first coordinator step pass (off by default).
    // SEEDED BEFORE `stepAgents` at the same start tick so it claims a STRICTLY
    // LOWER queue seq and dispatches FIRST within the shared start tick — the
    // coordinators emit `ActionSuggested` into `pendingSuggestionsByTarget`, then
    // the agents arbitrate them in the SAME tick (the same-tick handshake, Plan 03).
    // On a RESUME the pending stepCoordinators task is restored from the captured
    // queue, so this is skipped — the self-rescheduling chain continues. OFF ⇒ no
    // task scheduled, no substream constructed, golden byte-identical to 3920accc….
    if (coordinatorsEnabled) {
      schedule(COORDINATOR_START_TICK, {
        kind: "stepCoordinators",
        tick: COORDINATOR_START_TICK,
      });
    }
    // Phase-24 OODA-01/02: seed the first agent step pass (off by default). On a
    // RESUME the pending stepAgents task is restored from the captured queue, so
    // this is skipped — the self-rescheduling chain continues uninterrupted.
    if (oodaAgentsEnabled) {
      schedule(OODA_START_TICK, {
        kind: "stepAgents",
        tick: OODA_START_TICK,
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
      // Phase-24 OODA-05 (continuation-equivalence): capture the per-trailer active
      // trip context so a chunked/continued OODA-on run that crosses a boundary
      // mid-leg restores the SAME trip the next `stepAgents` pass observes — the
      // chunked OODA-on stream is then byte-identical to all-at-once (T-24-12). The
      // map is EMPTY on the off path (only `departTrailer` under `oodaAgentsEnabled`
      // writes it), so this is byte-identical to pre-Phase-24 when off. Each value
      // is re-built with a FIXED key order (`tripId, fromHubId, toHubId`) so the
      // serialized bytes are deterministic regardless of source insertion order.
      activeTripByTrailer: [...activeTripByTrailer.entries()].map(
        ([k, v]) =>
          [k, { tripId: v.tripId, fromHubId: v.fromHubId, toHubId: v.toHubId }] as const,
      ),
      // Phase-25 COORD-04 (continuation-equivalence): capture the five coordinator
      // GUARD state maps so a chunked/continued coordinator-on run that crosses a
      // boundary between two coordinator passes restores the SAME lease/prune/backoff/
      // hysteresis state the next `stepCoordinators` filter reads — the chunked
      // coordinator-on stream is then byte-identical to all-at-once (T-25-19). Each is
      // EMPTY on the off path (every WRITE is gated on `coordinatorsEnabled`), so this
      // is byte-identical to pre-Phase-25 when off (the 3920accc… keystone). Each map
      // is sorted by key so the serialized bytes are deterministic regardless of
      // source insertion order, with a FIXED value-field order on the lease tuple.
      leaseByAgent: [...leaseByAgent.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([k, v]) =>
            [k, { coordinatorId: v.coordinatorId, expiresAtSimMs: v.expiresAtSimMs }] as const,
        ),
      rejectCountByOption: [...rejectCountByOption.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v] as const),
      backoffUntilByOption: [...backoffUntilByOption.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v] as const),
      metricAboveSinceByOption: [...metricAboveSinceByOption.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v] as const),
      lastCenterByAgent: [...lastCenterByAgent.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v] as const),
      // Phase-25 COORD-01/02: capture any cross-tick pending suggestions DEFENSIVELY
      // (the handshake is strictly within-tick, so this is normally empty; serialized
      // so a suggestion targeting an agent not in the same-tick roster never desyncs a
      // chunked run). The full ActionSuggested payload is plain schema-pinned data.
      // Empty on the off path (byte-identical to pre-Phase-25). Sorted by target key;
      // the per-target list keeps its emit order (sorted center / sorted index).
      pendingSuggestionsByTarget: [...pendingSuggestionsByTarget.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([k, list]) =>
            [
              k,
              list.map((s) => ({
                suggestionId: s.payload.suggestionId,
                coordinatorId: s.payload.coordinatorId,
                targetAgentId: s.payload.targetAgentId,
                kind: s.payload.kind,
                params:
                  s.payload.params.toHubId !== undefined
                    ? { toHubId: s.payload.params.toHubId }
                    : {},
                issuedAtSimMs: s.payload.issuedAtSimMs,
                ttlSimMs: s.payload.ttlSimMs,
              })),
            ] as const,
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
