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
export { USA_HUBS, MEMPHIS, hubRegisteredEvent } from "./network/hubs.js";
export { buildRoutes, greatCircle } from "./network/routes.js";

// --- SIM-02: deterministic primitives ---------------------------------------
export type { Rng } from "./rng.js";
export { makeRng } from "./rng.js";
export { VirtualClock } from "./clock.js";

// --- SIM-02: the deterministic tick/event-queue engine ----------------------
export type {
  SimulatedEvent,
  SimulateOptions,
  RunSimulationOptions,
} from "./engine.js";
export { simulate, runSimulation } from "./engine.js";
