/**
 * Plan 19-08 Task A — the explicit, SERIALIZABLE simulation continuation.
 *
 * This is NOT a JS generator. It is plain, JSON-round-trippable data carrying
 * EVERYTHING needed to resume a deterministic run byte-identically:
 *
 *   - the virtual time to resume at (`nextTick`),
 *   - the raw seeded RNG sub-stream states (one `uint32` each),
 *   - the pending EventQueue contents as DATA tasks (never closures),
 *   - the entity/world state (manifests, registries, driver/fuel maps, counters),
 *   - the monotonic id counters AND a global `nextSequenceId` for total ordering.
 *
 * Determinism guards (from the consult): deterministic field order; an explicit
 * total order `(virtualTime, sequenceId)` tie-break; exclusive sim RNG (each
 * sub-stream captured); NO wall-clock anywhere (the clock is re-anchored from
 * `nextTick`). Because the continuation is pure data, a chunked-via-continuation
 * run is provably free of phantom unserialized module/closure/cache state — the
 * continuation-equivalence property test hashes the ordered stream to prove it.
 */

/**
 * The scheduled-action TASKS, as a discriminated union of DATA (no closures).
 * Each variant carries exactly the arguments the engine's dispatcher needs to
 * reconstruct the action — so the EventQueue is serializable and the run is
 * resumable. New event sources MUST add a variant here (never a closure).
 */
export type SimTask =
  | { readonly kind: "createPackageBatch"; readonly tick: number }
  // v2.0 IND-02: external-induction self-rescheduling task (same tick-based shape
  // as createPackageBatch). The pending task's absolute `fireTick` is captured by
  // SerializedScheduled, so a resume between two inductions never loses/reorders it.
  | { readonly kind: "inductPackage"; readonly tick: number }
  // Phase-24 OODA-01/02: the per-tick (per-OODA_INTERVAL_TICKS) agent step pass —
  // a self-rescheduling task with the SAME tick-based shape as `inductPackage`.
  // Seeded ONLY when `oodaAgentsEnabled` (the off path schedules none, so the
  // golden is byte-identical); on every fire it re-enqueues its `+OODA_INTERVAL`
  // successor. The absolute `fireTick` is captured by SerializedScheduled, so a
  // resume between two OODA passes never loses/reorders it (continuation-safe).
  | { readonly kind: "stepAgents"; readonly tick: number }
  // Phase-25 COORD-01/02: the per-center coordinator process-manager pass — a
  // self-rescheduling task with the SAME tick-based shape as `stepAgents`. Seeded
  // ONLY when `coordinatorsEnabled` (the off path schedules none, so the golden is
  // byte-identical to 3920accc…); on every fire it re-enqueues its
  // `+COORDINATOR_INTERVAL_TICKS` successor. The absolute `fireTick` is captured by
  // SerializedScheduled, so a resume between two coordinator passes never
  // loses/reorders it (continuation-safe). Fires in the SAME tick as `stepAgents`
  // so the suggestion handshake is same-tick (Plan 03 consumes it).
  | { readonly kind: "stepCoordinators"; readonly tick: number }
  | { readonly kind: "departTrailer"; readonly trailerId: string; readonly spokeHubId: string; readonly departTick: number }
  | {
      readonly kind: "arriveTrailer";
      readonly trailerId: string;
      readonly spokeHubId: string;
      readonly tripId: string;
      readonly carried: readonly string[];
      readonly arriveTick: number;
    }
  | {
      readonly kind: "midLegStops";
      readonly trailerId: string;
      readonly tripId: string;
      readonly legRests: readonly { readonly reason: "rest-10h" | "break-30min"; readonly minutes: number }[];
      readonly didRefuel: boolean;
      readonly refuelOdometer: number;
    }
  | {
      readonly kind: "arriveOverCarriedAtCenter";
      readonly trailerId: string;
      readonly packageId: string;
      readonly tripId: string;
      // NET-01: the center the over-carried package unloads at. ABSENT ⇒ the legacy
      // single center `hubs[0]` (byte-identical); present only under the
      // `continentalTopology` flag (additive, non-breaking).
      readonly centerHubId?: string;
    }
  // FLOW-02: a spoke→center CONSOLIDATION trailer's center arrival. Carries the
  // drained `packageIds` ARRAY (the whole manifest) — DATA, never a closure — so a
  // resume between a consolidation departure and its center arrival reconstructs
  // the re-sort/cross-dock exactly (the continuation-equivalence keystone).
  | {
      readonly kind: "arriveConsolidationAtCenter";
      readonly trailerId: string;
      readonly packageIds: readonly string[];
      readonly tripId: string;
      // NET-01: the ORIGIN/destination center this consolidation freight arrives at
      // (also reused for the cross-center backbone hop's dest-center arrival).
      // ABSENT ⇒ the legacy single center `hubs[0]` (byte-identical); present only
      // under the `continentalTopology` flag (additive, non-breaking).
      readonly centerHubId?: string;
    }
  // Phase-22 OUT-01: a ONE-SHOT terminal delivery task scheduled at a
  // DESTINATION-hub arrival (NOT self-rescheduling). Carries ALL data needed to
  // emit PackageDelivered — packageId, hubId, the locked `slaDeadlineIso`
  // (undefined for center-origin freight, which gets onTime: true by convention),
  // and the absolute `fireTick`. DATA (never a closure) so a chunk boundary
  // landing mid-dwell resumes the pending delivery byte-identically (D-22-4).
  | {
      readonly kind: "deliverPackage";
      readonly packageId: string;
      readonly hubId: string;
      readonly slaDeadlineIso: string | undefined;
      readonly fireTick: number;
    };

/** One queued action: fire at `fireTick`, ordered by `(fireTick, seq)`. */
export interface SerializedScheduled {
  readonly fireTick: number;
  readonly seq: number;
  readonly task: SimTask;
}

/** An HOS clock snapshot (mirror of the domain `HosClock`, serializable). */
export interface SerializedHosClock {
  readonly driveTodayMin: number;
  readonly dutyWindowStartAt: string;
  readonly sinceLastBreakMin: number;
  readonly weeklyOnDutyMin: number;
  readonly comeOnDutyAt: string;
  readonly sleeperBerthLongMin: number;
  readonly sleeperBerthShortMin: number;
}

/**
 * The captured world state — every mutable datum the dispatch tasks read/write.
 * Maps are serialized as ordered `[key, value]` tuple arrays so the JSON form is
 * deterministic and pointer-free. Field order is fixed for a stable serialization.
 */
export interface SerializedWorldState {
  /** Per-spoke FIFO manifest of pending package ids (hubId → packageId[]). */
  readonly pendingBySpoke: readonly (readonly [string, readonly string[]])[];
  /**
   * FLOW-01: per-spoke manifest of spoke-origin freight awaiting a spoke→center
   * CONSOLIDATION trailer (the mirror of `pendingBySpoke`). Only populated when
   * `consolidationEnabled`; every spoke maps to `[]` on the off path so the
   * serialized form is byte-identical to pre-Phase-21.
   */
  readonly pendingAtSpoke: readonly (readonly [string, readonly string[]])[];
  /**
   * FLOW-02: consolidation package id → its onward (post-center) destination spoke
   * hub id, so a resume between staging at a spoke and the center re-sort
   * cross-docks the package to the same spoke. Only populated when
   * `consolidationEnabled`; empty on the off path (byte-identical to pre-Phase-21).
   */
  readonly consolidationDestByPackage: readonly (readonly [string, string])[];
  /** Per-trailer odometer miles since last refuel (only populated when fuel on). */
  readonly odometerByTrailer: readonly (readonly [string, number])[];
  /** Trailer → currently-bound driver (HOS on). */
  readonly driverByTrailer: readonly (readonly [string, string])[];
  /** Driver → live HOS clock (HOS on). */
  readonly clockByDriver: readonly (readonly [string, SerializedHosClock])[];
  /** Driver → epoch-minute it becomes available again (HOS on). */
  readonly availableAtMinByDriver: readonly (readonly [string, number])[];
  /** The spare driver pool, in stable registration order (HOS on). */
  readonly sparePool: readonly string[];
  /** Monotonic package id counter. */
  readonly packageCounter: number;
  /** Monotonic trip id counter. */
  readonly tripCounter: number;
  /** Monotonic external-induction id counter (v2.0 IND-02). 0 on a fresh run. */
  readonly inductionCounter: number;
  /** Monotonic delivered-package counter (Phase-22 OUT-01). 0 on a fresh run. */
  readonly deliveredCounter: number;
  /**
   * Phase-22 OUT-01: packageId → its locked `slaDeadlineIso` (whole-minute ISO),
   * for inducted packages awaiting delivery. Only populated when
   * `outboundDeliveryEnabled`; empty on the off path (byte-identical to
   * pre-Phase-22). Cleared on `PackageDelivered` (one entry per in-flight
   * delivery), so a resume mid-dwell can still compute `onTime` deterministically.
   */
  readonly slaDeadlineByPackage: readonly (readonly [string, string])[];
  /**
   * Phase-24 OODA-05 (continuation-equivalence): the per-trailer ACTIVE trip
   * context the `stepAgents` truck Observe reads — trailerId → the directed leg
   * the trailer is currently driving (`tripId` + `fromHubId -> toHubId`). Written
   * at `departTrailer` ONLY when `oodaAgentsEnabled`, so on the off path it is
   * ALWAYS empty (`[]`) and the serialized form is byte-identical to pre-Phase-24
   * (the determinism keystone). Captured here so a chunked/continued OODA-on run
   * that crosses a boundary mid-leg restores the same trip context the next
   * `stepAgents` pass observes — making the chunked OODA-on stream byte-identical
   * to all-at-once (T-24-12). The per-agent RNG is a STATELESS re-derive
   * (`deriveAgentRng(seed, id)` is rebuilt each pass from `seed`+id with NO stored
   * stream position), so NO new `SerializedRngStates` field is needed and the off
   * path is trivially clean. Field order is fixed; the map is serialized as an
   * ordered `[trailerId, {tripId, fromHubId, toHubId}]` tuple array (deterministic,
   * pointer-free) — mirroring `pendingBySpoke`.
   */
  readonly activeTripByTrailer: readonly (readonly [
    string,
    { readonly tripId: string; readonly fromHubId: string; readonly toHubId: string },
  ])[];
  /**
   * Phase-25 COORD-04 (continuation-equivalence): the coordinator GUARD state — the
   * five anti-oscillation/anti-deadlock state maps the `stepCoordinators` filter and
   * the `stepAgents` reject handshake read/advance ACROSS coordinator passes. Each is
   * present-only-when-on (written ONLY under `coordinatorsEnabled`), so on the off
   * path every array is `[]` and the serialized form is byte-identical to
   * pre-Phase-25 (the seed-42 10k golden stays `3920accc…` — the determinism
   * keystone). Captured + restored exactly like `activeTripByTrailer`, with a FIXED
   * key order (sorted by key) so the serialized bytes are deterministic regardless of
   * source-map insertion order, and a fixed value-field order on the lease tuple.
   *
   * Without these, a chunk boundary landing between two coordinator passes would
   * resume with EMPTY guard state — re-issuing a just-leased/backed-off/pruned
   * suggestion the all-at-once run suppressed — so the chunked coordinator-on stream
   * would diverge (the OODA odometer-clobber class of bug, T-25-19).
   *
   * GUARD 4: single-owner lease per target agent (`agentId -> {coordinatorId,
   * expiresAtSimMs}`).
   */
  readonly leaseByAgent: readonly (readonly [
    string,
    { readonly coordinatorId: string; readonly expiresAtSimMs: number },
  ])[];
  /**
   * GUARDs 2+5: per-option (`${coordinatorId}|${targetAgentId}|${kind}`) rejection
   * count (toward the K-prune cooldown). Present-only-when-on (empty `[]` off path).
   */
  readonly rejectCountByOption: readonly (readonly [string, number])[];
  /**
   * GUARD 2: per-option backoff-until sim-ms (a rejected option is suppressed until
   * this sim-time). Present-only-when-on (empty `[]` off path).
   */
  readonly backoffUntilByOption: readonly (readonly [string, number])[];
  /**
   * GUARD 1: per-option metric-above-since sim-ms hysteresis marker (a candidate must
   * persist the dwell before it fires). Present-only-when-on (empty `[]` off path).
   */
  readonly metricAboveSinceByOption: readonly (readonly [string, number])[];
  /**
   * GUARD 5: per-agent last-seen owning center; a change clears that agent's
   * prune/backoff/hysteresis (the shift/zone-change reset). Present-only-when-on
   * (empty `[]` off path).
   */
  readonly lastCenterByAgent: readonly (readonly [string, string])[];
  /**
   * Phase-25 COORD-01/02 (continuation-equivalence): the same-tick suggestion
   * handshake substrate (`targetAgentId -> the pending ActionSuggested events`). The
   * Plan-03 handshake is STRICTLY within-tick — `stepCoordinators` fires one queue-seq
   * BEFORE `stepAgents` at a shared tick, and each agent DELETES its entry after
   * consuming it — so a captured continuation is normally empty here. It is serialized
   * DEFENSIVELY anyway (present-only-when-on, empty `[]` off path) so that ANY pending
   * suggestion targeting an agent NOT in the same-tick roster (e.g. a truck that
   * arrived between the two passes) survives a chunk boundary, keeping the chunked
   * coordinator-on stream byte-identical to all-at-once unconditionally. Each value is
   * the full `ActionSuggested` event payload (plain data, schema-pinned, pointer-free).
   */
  readonly pendingSuggestionsByTarget: readonly (readonly [
    string,
    readonly {
      readonly suggestionId: string;
      readonly coordinatorId: string;
      readonly targetAgentId: string;
      readonly kind: "reroute" | "hold" | "consolidate" | "dispatch";
      readonly params: { readonly toHubId?: string };
      readonly issuedAtSimMs: number;
      readonly ttlSimMs: number;
    }[],
  ])[];
}

/** The raw seeded RNG sub-stream states (one `uint32` each; deterministic order). */
export interface SerializedRngStates {
  readonly base: number;
  readonly rfid: number;
  readonly overCarry: number;
  readonly timing: number;
  readonly hos: number;
  /** Present only when fuel is enabled (the off path never constructs it). */
  readonly fuel: number | undefined;
  /** Present only when inductionEnabled (the off path never constructs it). IND-02. */
  readonly induction: number | undefined;
  /** Present only when outboundDeliveryEnabled (the off path never constructs it). OUT-01. */
  readonly outbound: number | undefined;
}

/**
 * THE continuation DTO. Plain serializable data, deterministic field order.
 * `runToHorizon(continuation, horizonTick, opts)` resumes from here.
 */
export interface SimContinuation {
  /** Schema tag (future-proofing a serialized continuation). */
  readonly version: 1;
  /**
   * The original PRNG seed. Carried so the continuation is SELF-CONTAINED — a
   * resume needs no out-of-band seed. (On resume every sub-stream is restored from
   * its raw `rng` state, so the seed is informational/round-trip metadata only.)
   */
  readonly seed: number;
  /** Virtual tick to resume at — the clock is re-anchored here (no wall-clock). */
  readonly nextTick: number;
  /** Raw seeded RNG sub-stream states. */
  readonly rng: SerializedRngStates;
  /** The pending EventQueue, as ordered DATA tasks. */
  readonly queue: readonly SerializedScheduled[];
  /** The EventQueue's next insertion seq (the same-tick tie-break counter). */
  readonly nextSeq: number;
  /** The captured entity/world state. */
  readonly world: SerializedWorldState;
  /**
   * Monotonic GLOBAL emit sequence id — increments once per emitted event across
   * the WHOLE run. Carried so a resumed chunk continues the same total order
   * `(virtualTime, sequenceId)` without restarting at 0 (the explicit tie-break
   * the consult requires for a deterministic same-timestamp order).
   */
  readonly nextSequenceId: number;
}

/** The starting point for {@link runToHorizon}: a fresh seed OR a continuation. */
export type SimStart = { readonly seed: number } | SimContinuation;

/** Type guard: is the start point a resumable continuation (vs a fresh seed)? */
export function isContinuation(start: SimStart): start is SimContinuation {
  return (start as Partial<SimContinuation>).version === 1;
}
