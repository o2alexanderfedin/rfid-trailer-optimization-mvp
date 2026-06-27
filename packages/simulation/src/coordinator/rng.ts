import { type Rng, makeRngFromState, mixSeed } from "../rng.js";

/**
 * Phase-25 COORD-01 / DET-03 — the per-CENTER seeded-substream primitive for the
 * advisory coordinators (the structural mirror of `ooda/rng.ts`'s per-agent
 * deriver).
 *
 * Each regional-center coordinator draws its stochastic tie-breaks / seeded
 * jitter (the COORD-04 anti-oscillation backoff, wired in Plan 04) from its OWN
 * seeded substream, derived from the STABLE centerId (never a center index or
 * iteration position). This is "disciplined reuse" of the repo's existing
 * salt/`mixSeed`/FNV-1a discipline (the nine engine+OODA salts and
 * `stableAgentHash`), NOT new machinery:
 *
 *   - `stableCenterHash` is the SAME 32-bit FNV-1a digest the partition checksum
 *     and `stableAgentHash` use, applied to the centerId string. Identical id ⇒
 *     identical digest; distinct ids ⇒ (overwhelmingly) distinct digests (so two
 *     centers' substreams decorrelate — PITFALLS Pitfall 3).
 *   - `COORDINATOR_RNG_SALT` is a fresh uint32, pairwise-distinct from the eight
 *     engine salts AND `OODA_RNG_SALT` (the NINTH substream salt) so enabling
 *     coordinators never perturbs any other substream. The canonical salt-collision
 *     test is extended to Set size 10 in Plan 05; a local Set-size assertion lives
 *     in coordinator.unit.test.ts.
 *   - `deriveCoordinatorRng` positions an `Rng` at the two-stage
 *     `mixSeed(mixSeed(seed) ^ COORDINATOR_RNG_SALT ^ stableCenterHash(id))`
 *     derivation: the inner `mixSeed(seed)` decorrelates adjacent base seeds, the
 *     XOR folds in the coordinator salt + the centerId digest, and the outer
 *     `mixSeed` re-disperses the result so two centers whose digests differ in only
 *     a few bits still yield well-separated streams (no shared first-K draws).
 *
 * Purity (DET-03): no `Date.now()`, no `Math.random()` — the centerId string is
 * the only entropy source. Construction is LAZY by contract: the engine wiring
 * (Plan 02 Task 3) only invokes `deriveCoordinatorRng` when `coordinatorsEnabled`
 * is true AND only for a center that actually suggests, so a flag-OFF run
 * constructs ZERO coordinator streams and stays byte-identical to `3920accc…`.
 */

/**
 * The 32-bit FNV-1a digest of a STABLE centerId — the per-center substream
 * entropy. Mirrors `stableAgentHash` (and `network/centers.ts`'s
 * `partitionChecksum`) EXACTLY: init `0x811c9dc5`, per-char `hash ^= c;
 * hash = Math.imul(hash, 0x01000193)`, finalize `(hash >>> 0)`. Pure: a function
 * of the id string only.
 */
export function stableCenterHash(centerId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < centerId.length; i += 1) {
    hash ^= centerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The NINTH substream salt (after the seven engine salts RFID/OVER_CARRY/TIMING/
 * HOS/FUEL/INDUCTION/OUTBOUND and the OODA per-agent salt), for the per-center
 * coordinator draws. A NEW, DISTINCT, well-separated uint32 (hash-split, NOT
 * `seed+1`) — pairwise-distinct from all eight prior salts so enabling
 * coordinators never perturbs any prior stream. The value `0x1c_6e_a5_4b` was
 * picked to be far (in every byte) from the existing salts; only the per-center
 * streams are constructed (lazily) from it.
 */
export const COORDINATOR_RNG_SALT = 0x1c_6e_a5_4b;

/**
 * Derive the seeded `Rng` for one center coordinator. The stream is positioned at
 * `makeRngFromState(mixSeed(mixSeed(seed) ^ COORDINATOR_RNG_SALT ^ stableCenterHash(id)))`
 * (mirroring `deriveAgentRng`): the inner `mixSeed(seed)` decorrelates adjacent
 * base seeds, the XOR folds in the coordinator salt + the centerId digest, and
 * the outer `mixSeed` re-disperses the result so near-identical id digests still
 * yield well-separated streams. Pure, synchronous, no wall-clock/random.
 *
 * LAZY by contract: only the engine's flag-ON path calls this (and only for a
 * center that actually suggests), so a flag-OFF run allocates nothing here.
 */
export function deriveCoordinatorRng(seed: number, centerId: string): Rng {
  const folded = (mixSeed(seed) ^ COORDINATOR_RNG_SALT ^ stableCenterHash(centerId)) >>> 0;
  return makeRngFromState(mixSeed(folded));
}
