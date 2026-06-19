import type {
  FusionConfig,
  Zone,
  ZoneDistribution,
  ZoneTransitionMatrix,
} from "./config.js";
import { ZONES } from "./config.js";
import { rssiToLikelihood } from "./likelihood.js";
import type { WindowedObservation } from "./window.js";

/**
 * The fusion input: the package being tracked plus its zone PRIOR (the OBSERVED
 * layer's belief carried forward). Optional fields seed the §8.4 output for the
 * "no observations" / first-estimate case.
 */
export interface FusionInput {
  readonly packageId: string;
  /** The prior zone distribution (carried-forward belief). */
  readonly prior: ZoneDistribution;
  /** The trailer this estimate is about (defaults from the observations). */
  readonly trailerId?: string;
  /** The last KNOWN-good checkpoint (a deterministic scan), carried through. */
  readonly lastReliableCheckpoint?: string | null;
  /** The prior's freshness time, used when there are no new observations. */
  readonly lastObservedAt?: string;
}

/**
 * The spec §8.4 zone estimate — the fusion engine's output. RFID is probabilistic
 * EVIDENCE, never coordinates: there is only a `estimatedZone` + a bounded
 * `confidence`, plus the full `posterior` (for auditing / the read model) and the
 * freshness/anchor fields. `confidence` is STRICTLY `< 1.0` and `<= ceiling`.
 */
export interface ZoneEstimate {
  readonly packageId: string;
  readonly trailerId: string;
  readonly estimatedZone: Zone;
  readonly confidence: number;
  readonly posterior: ZoneDistribution;
  readonly lastReliableCheckpoint: string | null;
  readonly lastObservedAt: string;
}

/**
 * `fuseZone` (SNS-03) — rule-based Bayesian zone fusion over {rear, middle, nose}.
 *
 * For EACH windowed observation (ONE per dwell — the windowing already collapsed
 * repeats, anti-P5b), in order:
 *
 *   1. Apply the Markov zone-transition PRIOR: an impossible single-step jump
 *      (rear→nose) carries only `transitionFloor` mass, so the posterior cannot
 *      teleport across the trailer in one step.
 *   2. Multiply in a CAPPED per-zone likelihood. The observation's reader maps
 *      (via `readerZoneEvidence`) to an evidence zone; that zone gets the
 *      density-weighted, `maxLikelihood`-capped likelihood, the others get the
 *      complementary spread. The cap means no single observation is ever certain.
 *   3. Normalize, then BLEND the entropy floor: every zone is pulled
 *      `entropyFloor` toward uniform, so no probability ever reaches 1.0.
 *
 * The combination of the per-read cap (≤ 0.85) and the entropy-floor blend bounds
 * the attainable confidence at `confidenceCeiling = (1 - floor) + floor/3 < 1.0`,
 * regardless of how many observations are fused — the anti-P5b guarantee.
 *
 * Empty observations ⇒ the prior-derived estimate, unchanged (a building block
 * for "absence changes nothing"; absence-as-non-exception is Plan 04's job).
 *
 * Pure: no clock, no RNG; time comes only from the observations' `lastObservedAt`.
 */
export function fuseZone(
  input: FusionInput,
  windowedObs: readonly WindowedObservation[],
  config: FusionConfig,
): ZoneEstimate {
  const lastReliableCheckpoint = input.lastReliableCheckpoint ?? null;

  if (windowedObs.length === 0) {
    // No new evidence: return the prior unchanged (deterministic).
    return finalize(
      input.packageId,
      input.trailerId ?? "",
      input.prior,
      lastReliableCheckpoint,
      input.lastObservedAt ?? "",
    );
  }

  let posterior = normalize(input.prior);
  let trailerId = input.trailerId ?? "";
  let lastObservedAt = input.lastObservedAt ?? "";

  for (const observation of windowedObs) {
    // 1. Markov transition prior.
    const predicted = applyTransition(posterior, config.zoneTransition);

    // 2. Capped per-zone likelihood from this single windowed observation.
    const likelihood = zoneLikelihood(observation, config);

    // 3. Bayesian update.
    const updated: Record<Zone, number> = {
      rear: predicted.rear * likelihood.rear,
      middle: predicted.middle * likelihood.middle,
      nose: predicted.nose * likelihood.nose,
    };

    // 4. Normalize, then blend the entropy floor (keeps every zone < 1.0).
    posterior = blendEntropyFloor(normalize(updated), config.entropyFloor);

    trailerId = observation.trailerId;
    if (observation.lastObservedAt > lastObservedAt) {
      lastObservedAt = observation.lastObservedAt;
    }
  }

  return finalize(
    input.packageId,
    trailerId,
    posterior,
    lastReliableCheckpoint,
    lastObservedAt,
  );
}

/**
 * The per-zone likelihood `P(observation | zone)` for ONE windowed observation.
 *
 * The observation's reader maps to an evidence zone. That zone gets the capped,
 * read-density-weighted likelihood `L` (from {@link rssiToLikelihood}); the other
 * zones share the complementary `1 - L` mass uniformly. An unmapped reader yields
 * a near-flat likelihood (diffuse evidence — it barely moves the posterior).
 *
 * Read-rate density factors in ONLY as a saturating pull of the likelihood toward
 * its cap (high RSSI w/ 1 read < moderate RSSI w/ 40 reads) — but the result is
 * ALWAYS clamped at `maxLikelihood`, so density can never be farmed to certainty.
 */
function zoneLikelihood(
  observation: WindowedObservation,
  config: FusionConfig,
): ZoneDistribution {
  const evidenceZone = config.readerZoneEvidence[observation.readerId];

  const base = rssiToLikelihood(
    observation.aggregatedRssi,
    observation.readerType,
    config,
  );
  // Saturating read-rate density in [densityFloor, 1], pulling the matched-zone
  // likelihood from `base` toward the cap — but `matched` is re-clamped at the
  // cap so it can never exceed it.
  const density = densityWeight(observation.readCount, config.readCountSaturation);
  const matched = clamp(
    base + (config.maxLikelihood - base) * density * 0.5,
    config.minLikelihood,
    config.maxLikelihood,
  );

  if (evidenceZone === undefined) {
    // Unmapped reader: diffuse evidence, near-uniform likelihood.
    return { rear: 0.5, middle: 0.5, nose: 0.5 };
  }

  const others = (1 - matched) / 2;
  const out: Record<Zone, number> = { rear: others, middle: others, nose: others };
  out[evidenceZone] = matched;
  return out;
}

/** A saturating density weight in `[0, 1]` — flat at 1 once `readCount >= sat`. */
function densityWeight(readCount: number, saturation: number): number {
  if (saturation <= 0) return 1;
  const w = readCount / saturation;
  return w >= 1 ? 1 : w < 0 ? 0 : w;
}

/** Apply the Markov transition matrix: `out[to] = Σ_from p[from] * M[from][to]`. */
function applyTransition(
  p: ZoneDistribution,
  matrix: ZoneTransitionMatrix,
): ZoneDistribution {
  const out: Record<Zone, number> = { rear: 0, middle: 0, nose: 0 };
  for (const from of ZONES) {
    const row = matrix[from];
    const mass = p[from];
    for (const to of ZONES) {
      out[to] += mass * row[to];
    }
  }
  return normalize(out);
}

/**
 * Blend `floor` uniform uncertainty into the distribution: every zone is pulled
 * `floor` of the way toward uniform `1/3`. Guarantees each probability is in
 * `(floor/3, (1 - floor) + floor/3) ⊂ (0, 1)` — no zone ever reaches 0 or 1.
 */
function blendEntropyFloor(p: ZoneDistribution, floor: number): ZoneDistribution {
  const uniform = 1 / ZONES.length;
  return {
    rear: (1 - floor) * p.rear + floor * uniform,
    middle: (1 - floor) * p.middle + floor * uniform,
    nose: (1 - floor) * p.nose + floor * uniform,
  };
}

/** Normalize a (non-negative) weight vector to a distribution; uniform if all-zero. */
function normalize(p: ZoneDistribution): ZoneDistribution {
  const total = p.rear + p.middle + p.nose;
  if (total <= 0) {
    const u = 1 / ZONES.length;
    return { rear: u, middle: u, nose: u };
  }
  return { rear: p.rear / total, middle: p.middle / total, nose: p.nose / total };
}

/** Pick the argmax zone (rear-biased tie-break, matching ZONES order). */
function argmaxZone(p: ZoneDistribution): Zone {
  let best: Zone = "rear";
  for (const z of ZONES) {
    if (p[z] > p[best]) best = z;
  }
  return best;
}

/** Assemble the final §8.4 ZoneEstimate from a finished posterior. */
function finalize(
  packageId: string,
  trailerId: string,
  posterior: ZoneDistribution,
  lastReliableCheckpoint: string | null,
  lastObservedAt: string,
): ZoneEstimate {
  const estimatedZone = argmaxZone(posterior);
  return {
    packageId,
    trailerId,
    estimatedZone,
    confidence: posterior[estimatedZone],
    posterior,
    lastReliableCheckpoint,
    lastObservedAt,
  };
}

/** Clamp `value` into the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
