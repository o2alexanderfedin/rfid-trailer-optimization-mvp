/**
 * `@mm/simulation/coordinator` — the deterministic, PURE coordination process-
 * manager primitives (Phase 25). A synchronous, import-restricted leaf: it imports
 * ONLY from `../rng.js` and `@mm/domain` types — NO engine state, NO async, NO
 * wall-clock, NO `Math.random` (DET-03; the static ESLint guard scoped to
 * `coordinator/**` lands in Plan 05, mirroring the `ooda/**` guard). The engine
 * wiring (the `stepCoordinators` SimTask + the `coordinatorsEnabled` flag + the
 * `pendingSuggestionsByTarget` map) is Plan 02 Task 2/3; this surface is the
 * contract that wiring implements against.
 */

// COORD-02 — canonicalize the ActionSuggested hashed payload (Plan 01).
export { canonicalizeSuggestionPayload } from "./canonical.js";

// COORD-01 / DET-03 — per-center seeded substream primitives.
export {
  COORDINATOR_RNG_SALT,
  deriveCoordinatorRng,
  stableCenterHash,
} from "./rng.js";

// COORD-01 — the frozen per-center observation surface.
export type {
  CoordinatorObservation,
  ObservedSpoke,
  ObservedTruck,
} from "./observe.js";

// COORD-01/COORD-02 — the pure rule-based suggestion generator.
export {
  COORDINATOR_THRESHOLDS,
  decideCoordinatorSuggestions,
} from "./coordinator.js";
export type {
  CoordinatorSuggestion,
  CoordinatorSuggestionKind,
} from "./coordinator.js";

// COORD-02 (consume half) — the pure accept/reject arbitration (the un-overridable
// feasibility contract; the engine consumes this in stepAgents, Plan 03 Task 2).
export { arbitrateSuggestion } from "./handshake.js";
export type {
  SuggestionArbitration,
  SuggestionBindingKind,
  SuggestionRejectReason,
} from "./handshake.js";

// COORD-04 — the named sim-time constant envelope for the five guards.
export {
  BACKOFF_BASE_SIM_MS,
  BACKOFF_CAP_SIM_MS,
  BACKOFF_JITTER_SIM_MS,
  HYSTERESIS_DWELL_SIM_MS,
  LEASE_SIM_MS,
  REJECT_COOLDOWN_K,
  SUGGESTION_TTL_SIM_MS,
} from "./constants.js";

// COORD-04 — the five pure / sim-time / seeded guard predicates (hysteresis,
// seeded-jitter backoff, sim-time TTL, single-owner lease, reject-path pruning).
export {
  acquireLease,
  clearPruneOnZoneChange,
  inBackoff,
  isExpired,
  isPruned,
  leaseAvailable,
  nextBackoffUntil,
  passesHysteresis,
  recordReject,
  updateHysteresisMarker,
} from "./guards.js";
export type { CoordinatorLease } from "./guards.js";

// COORD-06 (Phase 26, Plan 01) — the PURE in-fold optimizer adapter: build a
// per-center @mm/optimizer twin from a fold slice + translate an EpochResult into
// reroute-only suggestions. Plan 02 wires these into the engine fold.
export {
  buildCenterTwinFromFold,
  epochResultToRerouteSuggestions,
} from "./optimize.js";
export type {
  CenterFoldRouteLeg,
  CenterFoldSlice,
  CenterFoldTrailer,
} from "./optimize.js";
