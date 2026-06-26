/**
 * `@mm/simulation/ooda` — the deterministic, PURE OODA decision-core primitives
 * (Phase 24). A synchronous, import-restricted leaf: it imports ONLY from
 * `../rng.js` and `@mm/domain` types — NO engine state, NO async, NO wall-clock,
 * NO `Math.random` (DET-03; the static guard lands in 24-04). The engine wiring
 * (the `stepAgents` SimTask + flag + centralized bypass) is plan 24-02; this
 * surface is the contract that wiring implements against.
 */

// OODA-04 determinism primitives.
export { deriveAgentRng, OODA_RNG_SALT, stableAgentHash } from "./rng.js";
export { type Agent, type AgentKind, sortAgentsByStableId } from "./agent.js";
export type {
  AgentObservation,
  DivertReason,
  HoldReason,
  ObservedHosClock,
  RestReason,
  TruckDecision,
} from "./observe.js";

// OODA-01 truck Decide.
export { decideTruck } from "./truck.js";

// OODA-02 hub Decide (24-02).
export { decideHub } from "./hub.js";
export type { HubDecision, HubHoldReason, HubObservation } from "./hub.js";
