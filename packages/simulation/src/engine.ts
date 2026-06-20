import type {
  DomainEvent,
  Hub,
  PackageArrivedAtHub,
  PackageCreated,
  PackageScanned,
  SizeClass,
  TrailerArrivedAtHub,
  TrailerDeparted,
  TrailerDocked,
} from "@mm/domain";
import { USA_HUBS, hubRegisteredEvent } from "./network/hubs.js";
import { buildRoutes } from "./network/routes.js";
import { makeRng } from "./rng.js";
import { VirtualClock } from "./clock.js";
import { emitRfidReads, resolveRfidConfig, type RfidSimConfig } from "./rfid.js";

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
}

/** Options for the store-driven run. */
export interface RunSimulationOptions extends SimulateOptions {
  /** Consumes each event in deterministic order (e.g. appends to the store). */
  readonly sink: (event: SimulatedEvent) => void | Promise<void>;
}

// --- Simulation constants (declarative; the network is fixed for Phase 1) ----

/** Domain ms per tick. 1 tick = 1 minute of simulated time. */
const MS_PER_TICK = 60_000;
/** The seeded domain epoch — the clock starts here; no wall-clock read. */
const EPOCH_ISO = "2026-04-01T00:00:00.000Z";

/** Ticks a trailer spends in transit on a linehaul leg. */
const TRANSIT_TICKS = 30;
/** Ticks between a trailer docking and its next departure (dwell + reload). */
const DWELL_TICKS = 10;
/** Ticks between successive package-creation batches at the center hub. */
const PACKAGE_INTERVAL_TICKS = 15;
/** Max packages created per batch (1..MAX). */
const MAX_PACKAGES_PER_BATCH = 3;
/** Package size classes, in a fixed order (RNG picks an index). */
const SIZE_CLASSES: readonly SizeClass[] = ["small", "medium", "large"];

// --- Internal event-queue --------------------------------------------------

/** A scheduled action: run at `fireTick`; `seq` is the deterministic tie-break. */
interface Scheduled {
  readonly fireTick: number;
  readonly seq: number;
  readonly run: () => void;
}

/**
 * A deterministic priority queue. Actions are dequeued in `(fireTick, seq)`
 * order — `seq` (insertion order) guarantees a total, stable ordering so the
 * stream never depends on array/heap implementation details.
 */
class EventQueue {
  private items: Scheduled[] = [];
  private nextSeq = 0;
  private dirty = false;

  /** Allocate the next monotonic insertion sequence (the stable tie-break). */
  claimSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  push(fireTick: number, seq: number, run: () => void): void {
    this.items.push({ fireTick, seq, run });
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
}

// --- The generation core ----------------------------------------------------

/**
 * Run the deterministic simulation and return the ordered event stream. This is
 * the SINGLE source of truth shared by `simulate` and `runSimulation`.
 */
function generate(opts: SimulateOptions): SimulatedEvent[] {
  const { seed, durationTicks, rfid, overCarry } = opts;
  if (!Number.isInteger(durationTicks) || durationTicks < 0) {
    throw new RangeError(`durationTicks must be a non-negative integer, got ${durationTicks}`);
  }

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

  const rng = makeRng(seed);
  // SIM-03: RFID draws from a SEPARATE seeded substream (seed ^ a fixed salt) so
  // enabling RFID never perturbs the operational rng — the non-RFID event order
  // is byte-identical with or without the rfid option, while the RFID stream is
  // still fully reproducible per seed.
  const rfidRng = makeRng((seed ^ 0x5f_1d_a7_c3) >>> 0);
  // F-07: over-carry draws from its OWN seeded substream — a salt DISTINCT from
  // the RFID salt (0x5f1da7c3) so it never collides with / perturbs `rfidRng` or
  // `rng`. Same seed + same rate ⇒ byte-identical over-carry decisions.
  const overCarryRng = makeRng((seed ^ 0x3c_a7_1d_5f) >>> 0);
  const clock = new VirtualClock(EPOCH_ISO, MS_PER_TICK);
  const queue = new EventQueue();
  const out: SimulatedEvent[] = [];

  const hubs = USA_HUBS;
  const center = hubs[0]!;
  const spokes = hubs.slice(1);
  const routes = buildRoutes(hubs);

  // Monotonic id counters — stable ids make the stream reproducible.
  let packageCounter = 0;
  let tripCounter = 0;

  /** Emit one event onto its stream at the current domain time. */
  const emit = (streamId: string, event: DomainEvent): void => {
    out.push({ streamId, event, occurredAt: clock.nowIso() });
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

  // --- Bootstrap: register every hub then every route, all at tick 0. -------
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

  // --- Package generation: batches created at the center over time. ---------
  // Each package is created, scanned inbound at the center, and queued to ride
  // the next trailer toward its destination spoke. The queue per spoke is a
  // FIFO manifest the spoke's trailer drains on departure.
  const pendingBySpoke = new Map<string, string[]>();
  for (const s of spokes) pendingBySpoke.set(s.hubId, []);

  const createPackageBatch = (tick: number): void => {
    const count = 1 + rng.int(MAX_PACKAGES_PER_BATCH); // 1..MAX
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
    if (nextTick <= durationTicks) schedule(nextTick, () => createPackageBatch(nextTick));
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

    // SIM-03: DOCK-PORTAL reads as the loaded packages cross the door. Strong
    // RSSI, one candidate read per tag, subject to missRate (drops are omitted).
    if (rfidEnabled && loaded.length > 0) {
      emitRfid("portal", trailerId, center.hubId, loaded);
    }

    const arriveTick = departTick + TRANSIT_TICKS;
    schedule(arriveTick, () => arriveTrailer(trailerId, spoke, tripId, loaded, arriveTick));
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
      // package there (so it does NOT skew spoke utilization/SLA).
      const returnArriveTick = arriveTick + TRANSIT_TICKS;
      const overCarriedId = heldBack;
      schedule(returnArriveTick, () =>
        arriveOverCarriedAtCenter(trailerId, overCarriedId, returnTripId),
      );
    }

    // Loop: after dwell, the trailer returns toward the center and re-dispatches.
    const nextDepart = arriveTick + DWELL_TICKS;
    if (nextDepart <= durationTicks) {
      schedule(nextDepart, () => departTrailer(trailerId, spoke, nextDepart));
    }
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

  /** Schedule an action at `fireTick` with a stable insertion-order tie-break. */
  function schedule(fireTick: number, run: () => void): void {
    queue.push(fireTick, queue.claimSeq(), run);
  }

  // --- Seed the initial schedule --------------------------------------------
  // First package batch at tick 0; one trailer per spoke departs at tick 1 so
  // the first batch is available to load (deterministic, fixed offsets).
  schedule(0, () => createPackageBatch(0));
  spokes.forEach((spoke, i) => {
    const trailerId = `T${String(i + 1).padStart(3, "0")}`;
    schedule(1, () => departTrailer(trailerId, spoke, 1));
  });

  // --- Drive the queue to completion ----------------------------------------
  for (;;) {
    const action = queue.pop();
    if (action === undefined) break;
    if (action.fireTick > durationTicks) break;
    clock.advance(action.fireTick - currentTick(clock));
    action.run();
  }

  return out;
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
 */
export function simulate(opts: SimulateOptions): SimulatedEvent[] {
  return generate(opts);
}

/**
 * Drive the SAME deterministic stream into the injected `sink` (typically
 * `appendToStream` + inline projections). Events are delivered strictly in
 * generation order; the sink may be async (awaited sequentially) so per-stream
 * version ordering is preserved.
 */
export async function runSimulation(opts: RunSimulationOptions): Promise<void> {
  const stream = generate(opts);
  for (const item of stream) {
    await opts.sink(item);
  }
}
