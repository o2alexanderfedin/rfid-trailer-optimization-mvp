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
