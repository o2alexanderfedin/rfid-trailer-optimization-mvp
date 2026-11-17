/**
 * `@mm/simulation` — the deterministic, seeded USA hub-network simulator
 * (SIM-01 + SIM-02). It is the ONLY data source for every later phase, so
 * determinism is non-negotiable: same seed -> byte-identical event stream.
 *
 *  - `network/hubs`   : ~10 real US metro hubs (SIM-01).
 *  - `network/routes` : great-circle hub-and-spoke linehaul routes (SIM-01).
 *  - `rng`            : seeded PRNG — ALL randomness flows through it (SIM-02).
 *  - `clock`          : virtual domain clock — ALL time comes from it (SIM-02).
 *  - `engine`         : the tick/event-queue engine emitting typed DomainEvents.
 */

// --- SIM-01: network --------------------------------------------------------
export { USA_HUBS, MEMPHIS, hubRegisteredEvent, generateBigCityHubs } from "./network/hubs.js";
export {
  pickRegionalCenters,
  buildBackbone,
  deriveCenterPartition,
  DEFAULT_CENTER_COUNT,
} from "./network/centers.js";
export type { CenterPartition, BackboneLeg } from "./network/centers.js";
export {
  buildRoutes,
  greatCircle,
  routeId,
  haversineKm,
  transitParamsForLeg,
  transitParamsFromDuration,
  buildTransitParamsByLeg,
  loadStaticRoadGeometry,
  applyRoadGeometry,
  hubCoordsChecksum,
} from "./network/routes.js";
export type { RoadLeg, RoadGeometryFile } from "./network/routes.js";

// --- SIM-02: deterministic primitives ---------------------------------------
export type { Rng } from "./rng.js";
export { makeRng, makeRngFromState } from "./rng.js";
// Plan 19-08 Task D: the SINGLE-SOURCE epoch constants (no duplicated literals).
export { EPOCH_ISO, EPOCH_MS, MS_PER_TICK } from "./epoch.js";
export { VirtualClock } from "./clock.js";
export type { LogNormalParams, TimingConfig } from "./timing.js";
export { sampleLogNormal, DEFAULT_TIMING_CONFIG } from "./timing.js";

// --- SIM-02: the deterministic tick/event-queue engine ----------------------
export type {
  SimulatedEvent,
  SimulateOptions,
  RunSimulationOptions,
  SortWaveConfig,
  RunToHorizonResult,
} from "./engine.js";
export { simulate, runSimulation, runToHorizon } from "./engine.js";

// --- Plan 19-08 (CONT-04): the resumable continuation DTO -------------------
export type {
  SimContinuation,
  SimStart,
  SimTask,
  SerializedScheduled,
  SerializedWorldState,
  SerializedRngStates,
  SerializedHosClock,
} from "./continuation.js";
export { isContinuation } from "./continuation.js";

// --- SIM-03: seeded probabilistic RFID emission -----------------------------
export type { RfidSimConfig, ReaderType, EmitRfidReadsArgs } from "./rfid.js";
export { emitRfidReads, resolveRfidConfig, DEFAULT_RFID_CONFIG } from "./rfid.js";

// --- SIM-04: deterministic scenario-injection model -------------------------
export type { ScenarioKnobs } from "./scenario.js";
export { applyScenario } from "./scenario.js";

// --- Phase-24 OODA decision core (OODA-01/04, DET-03) -----------------------
// The PURE, synchronous OODA primitives the engine wiring (plan 24-02) builds
// against: per-agent seeded substreams, sorted-by-stable-id iteration, the frozen
// truck observation, and the pure truck Decide. No engine state / async / clock.
export {
  deriveAgentRng,
  OODA_RNG_SALT,
  stableAgentHash,
  sortAgentsByStableId,
  decideTruck,
} from "./ooda/index.js";
export type {
  Agent,
  AgentKind,
  AgentObservation,
  ObservedHosClock,
  TruckDecision,
  DivertReason,
  HoldReason,
  RestReason,
} from "./ooda/index.js";
