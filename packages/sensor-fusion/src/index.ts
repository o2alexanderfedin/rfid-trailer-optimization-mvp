/**
 * `@mm/sensor-fusion` — the PURE, deterministic RFID zone-fusion engine.
 *
 * This is the OBSERVED-evidence engine of the two-layer (planned vs observed)
 * Phase-3 design, and the home of the anti-P5b defense: repeated reads of one
 * tag in one dwell can NEVER drive confidence to 1.0. It imports ONLY
 * `@mm/domain`; it reads no wall clock and calls no RNG, so the same input
 * always yields the same output (auditable, replayable).
 *
 * Pipeline: raw reads → {@link windowObservations} (anti-P5b dwell collapse) →
 * {@link fuseZone} (capped-likelihood Bayesian posterior + Markov prior +
 * entropy floor) → a {@link ZoneEstimate}.
 */
export {
  type FusionConfig,
  type ReaderType,
  type Zone,
  type ZoneDistribution,
  type ZoneTransitionMatrix,
  DEFAULT_FUSION_CONFIG,
  ZONES,
} from "./config.js";
export { rssiToLikelihood } from "./likelihood.js";
export {
  type RfidRead,
  type WindowedObservation,
  percentile,
  windowObservations,
} from "./window.js";
export {
  type FusionInput,
  type ZoneEstimate,
  fuseZone,
} from "./fuse.js";
