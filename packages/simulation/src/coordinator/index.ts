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
