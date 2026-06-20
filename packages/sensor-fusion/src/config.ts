/**
 * `@mm/sensor-fusion` — fusion configuration (the single source of every tunable
 * constant the engine reads).
 *
 * Every probabilistic guard the Phase-3 research (`03-RESEARCH.md`, the Google AI
 * Mode consult) prescribes against overconfident RFID lock-on (P5b) is encoded
 * here as DATA, not buried in code:
 *
 *   - `maxLikelihood` (0.85) — the per-read likelihood CAP. A single strong RSSI
 *     can never yield P(RSSI|Zone) = 1.0, so one outlier cannot hijack the
 *     posterior.
 *   - `entropyFloor` (0.02) — the 1–5% uniform uncertainty blended into the
 *     posterior each step, so no zone probability ever reaches 1.0 and the
 *     estimate recovers quickly when the asset moves.
 *   - `readerTypeWeights` — reader/antenna-TYPE priors: a `dock-portal` is
 *     high-reliability; a `trailer-antenna` is zone-ish (lower reliability).
 *   - `zoneTransition` — the Markov zone-transition matrix: near-zero prior for
 *     physically impossible jumps (rear→nose without passing middle).
 *   - `defaultPrior` — a uniform prior over the three zones.
 *
 * The module is PURE: this file holds only data + types, no clock, no RNG.
 */

/**
 * The three-zone discriminant. Defined LOCALLY (sensor-fusion must NOT import
 * `@mm/load-planner` — sideways deps are forbidden; deps point downward only).
 * `rear` = the door (easiest access), `nose` = the deep end; `middle` lies
 * physically between them (the Markov constraint below relates them).
 */
export type Zone = "rear" | "middle" | "nose";

/** The canonical zone order, rear→nose. Single-sourced so iteration is stable. */
export const ZONES: readonly Zone[] = ["rear", "middle", "nose"] as const;

/**
 * The reader/antenna TYPE vocabulary. A `dock-portal` (the fixed dock-door
 * portal a trailer passes through on dock/load) is high-reliability; a
 * `trailer-antenna` (mounted inside the trailer, reading during dwell) is
 * zone-ish and noisier.
 */
export type ReaderType = "dock-portal" | "trailer-antenna";

/**
 * A probability distribution over the three zones. Components are non-negative
 * and (for a well-formed prior/posterior) sum to 1.
 */
export type ZoneDistribution = Readonly<Record<Zone, number>>;

/**
 * A row-stochastic Markov transition matrix over zones: `zoneTransition[from]`
 * is the prior distribution of the NEXT zone given the asset was last in `from`.
 * Physically impossible single-step jumps (rear→nose) carry a near-zero (not
 * exactly zero — see {@link FusionConfig.transitionFloor}) prior.
 */
export type ZoneTransitionMatrix = Readonly<Record<Zone, ZoneDistribution>>;

/**
 * The complete, documented fusion configuration. All knobs the engine reads.
 */
export interface FusionConfig {
  /**
   * The per-read likelihood CAP (anti-P5b). `rssiToLikelihood` never returns a
   * value above this, so no single read — however strong, however many times
   * repeated — can drive a Bayesian update with certainty. Default 0.85.
   */
  readonly maxLikelihood: number;
  /**
   * The per-read likelihood FLOOR (> 0). Even the weakest RSSI yields a strictly
   * positive likelihood, so a zone is never hard-zeroed by one weak read.
   */
  readonly minLikelihood: number;
  /**
   * The RSSI (dBm) at/below which the likelihood mapping bottoms out at
   * `minLikelihood`. Typical passive-UHF floor.
   */
  readonly rssiFloorDbm: number;
  /**
   * The RSSI (dBm) at/above which the likelihood mapping tops out at
   * `maxLikelihood`. A strong, close read.
   */
  readonly rssiCeilingDbm: number;
  /**
   * The 1–5% uniform uncertainty blended into the posterior each fusion step
   * (the entropy floor / noise floor). Keeps every zone probability strictly
   * `< 1.0`. Default 0.02.
   */
  readonly entropyFloor: number;
  /**
   * Reader/antenna-TYPE reliability weights in (0, 1]. The capped likelihood is
   * scaled toward the floor by `1 - weight`, so a `trailer-antenna` (lower
   * weight) yields a lower likelihood than a `dock-portal` for the SAME RSSI.
   */
  readonly readerTypeWeights: Readonly<Record<ReaderType, number>>;
  /**
   * Read-rate density saturation. The windowed observation's effective weight
   * grows with read count but SATURATES at this many reads — beyond it, more
   * repeats add no extra weight (anti-P5b: density cannot be farmed to certainty).
   */
  readonly readCountSaturation: number;
  /**
   * The percentile (0–100) used to aggregate a dwell window's RSSI samples. The
   * Phase-3 consult prescribes the 90th-percentile (or mode) — NOT the mean,
   * which multipath drops skew downward. Default 90.
   */
  readonly aggregationPercentile: number;
  /**
   * The Markov zone-transition matrix (row-stochastic). Applied as a prior
   * BEFORE each observation update so impossible jumps stay near-zero.
   */
  readonly zoneTransition: ZoneTransitionMatrix;
  /**
   * The near-zero probability assigned to a physically impossible single-step
   * jump in {@link zoneTransition} (kept > 0 so the chain is irreducible and the
   * posterior can recover, but small enough to block instantaneous teleports).
   */
  readonly transitionFloor: number;
  /** The default (uniform) prior over zones when the caller supplies none. */
  readonly defaultPrior: ZoneDistribution;
  /**
   * The hard confidence CEILING the fused estimate may never exceed. Derived
   * from `maxLikelihood` and the `entropyFloor`; the keystone asserts the fused
   * confidence is `< 1.0` AND `<= confidenceCeiling`.
   */
  readonly confidenceCeiling: number;
  /**
   * Which `(tagId, readerId)` reads to treat as REAR / MIDDLE / NOSE evidence.
   * A windowed observation from a reader in this map contributes likelihood mass
   * toward its mapped zone. Reads from unmapped readers contribute as diffuse
   * (uniform-ish) evidence and barely move the posterior.
   */
  readonly readerZoneEvidence: Readonly<Record<string, Zone>>;
}

/**
 * A uniform distribution over the three zones (≈0.3333 each).
 */
const UNIFORM_PRIOR: ZoneDistribution = {
  rear: 1 / 3,
  middle: 1 / 3,
  nose: 1 / 3,
};

/**
 * The default Markov zone-transition matrix. An asset tends to STAY (high
 * self-transition) or step to an ADJACENT zone; the two impossible jumps
 * (rear↔nose without passing middle) get a near-zero `transitionFloor` mass.
 * Each row sums to 1.
 */
const DEFAULT_ZONE_TRANSITION: ZoneTransitionMatrix = {
  // rear → {rear stay, middle step, nose IMPOSSIBLE}
  rear: { rear: 0.8, middle: 0.198, nose: 0.002 },
  // middle → adjacent either way
  middle: { rear: 0.149, middle: 0.702, nose: 0.149 },
  // nose → {nose stay, middle step, rear IMPOSSIBLE}
  nose: { rear: 0.002, middle: 0.198, nose: 0.8 },
};

/**
 * The default, documented fusion configuration. Concrete values come straight
 * from the Phase-3 Google AI Mode consult (`03-RESEARCH.md`): likelihood cap
 * 0.85, entropy floor 2% (within the prescribed 1–5% band), 90th-percentile RSSI
 * aggregation (in `window.ts`), read-rate density, and a Markov prior.
 */
export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  maxLikelihood: 0.85,
  minLikelihood: 0.05,
  rssiFloorDbm: -90,
  rssiCeilingDbm: -45,
  entropyFloor: 0.02,
  readerTypeWeights: {
    "dock-portal": 1.0,
    "trailer-antenna": 0.7,
  },
  readCountSaturation: 40,
  aggregationPercentile: 90,
  zoneTransition: DEFAULT_ZONE_TRANSITION,
  transitionFloor: 0.002,
  defaultPrior: UNIFORM_PRIOR,
  // confidenceCeiling = maxLikelihood blended with the entropy floor: even a
  // unanimous posterior is pulled back toward uniform by `entropyFloor`, so the
  // attainable max is (1 - entropyFloor) + entropyFloor/3.
  confidenceCeiling: (1 - 0.02) + 0.02 / 3,
  readerZoneEvidence: {},
};
