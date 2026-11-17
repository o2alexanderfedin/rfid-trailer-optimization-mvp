import { type Rng, makeRngFromState, mixSeed } from "../rng.js";

/**
 * OODA-04 / DET-03 — the per-agent seeded-substream primitives.
 *
 * Every OODA agent (truck, hub) draws its stochastic tie-breaks from its OWN
 * seeded substream, derived from the STABLE agent id (never a spawn index or
 * iteration position). This is "disciplined reuse" of the repo's existing
 * salt/`mixSeed`/FNV-1a discipline (see `network/centers.ts`'s
 * `partitionChecksum` and the eight engine salts), NOT new machinery:
 *
 *   - `stableAgentHash` is the SAME 32-bit FNV-1a digest the partition checksum
 *     uses, applied to the agent id string. Identical id ⇒ identical digest;
 *     distinct ids ⇒ (overwhelmingly) distinct digests (PITFALLS Pitfall 3 —
 *     decorrelate per-agent streams).
 *   - `OODA_RNG_SALT` is a fresh uint32, pairwise-distinct from the eight engine
 *     salts so enabling OODA never perturbs any other substream (the salt-
 *     collision test asserts the nine salts form a 9-element Set).
 *   - `deriveAgentRng` positions an `Rng` at the two-stage
 *     `mixSeed(mixSeed(seed) ^ OODA_RNG_SALT ^ stableAgentHash(id))` derivation
 *     (ARCHITECTURE §3): the outer `mixSeed` re-disperses the XOR-folded entropy
 *     so two ids whose digests differ in only a few bits still yield
 *     well-separated streams (no shared first-K draws).
 *
 * Purity (DET-03): no `Date.now()`, no `Math.random()` — the agent id string is
 * the only entropy source. Construction is LAZY by contract: callers (the engine
 * wiring in plan 24-02) only invoke `deriveAgentRng` when `oodaAgentsEnabled` is
 * true, so a flag-OFF run constructs ZERO agent streams and stays byte-identical
 * to the seed-42 golden.
 */

/**
 * The 32-bit FNV-1a digest of a STABLE agent id — the per-agent substream
 * entropy. Mirrors `network/centers.ts`'s `partitionChecksum` EXACTLY: init
 * `0x811c9dc5`, per-char `hash ^= c; hash = Math.imul(hash, 0x01000193)`,
 * finalize `(hash >>> 0)`. Pure: a function of the id string only.
 */
export function stableAgentHash(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i += 1) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The EIGHTH substream salt (after the seven engine salts RFID/OVER_CARRY/
 * TIMING/HOS/FUEL/INDUCTION/OUTBOUND), for OODA per-agent draws. A NEW, DISTINCT,
 * well-separated uint32 (hash-split, NOT `seed+1`) — the salt-collision test
 * asserts it differs from all seven engine salts so enabling OODA never perturbs
 * any prior stream. The value `0x7a9e3f1d` was picked to be far (in every byte)
 * from the existing salts; only the per-agent streams are constructed (lazily)
 * from it.
 */
export const OODA_RNG_SALT = 0x7a_9e_3f_1d;

/**
 * Derive the seeded `Rng` for one agent. The stream is positioned at
 * `makeRngFromState(mixSeed(mixSeed(seed) ^ OODA_RNG_SALT ^ stableAgentHash(id)))`
 * (ARCHITECTURE §3, PITFALLS Pitfall 3): the inner `mixSeed(seed)` decorrelates
 * adjacent base seeds, the XOR folds in the OODA salt + the id digest, and the
 * outer `mixSeed` re-disperses the result so near-identical id digests still
 * yield well-separated streams. Pure, synchronous, no wall-clock/random.
 *
 * LAZY by contract: only the engine's flag-ON path calls this, so a flag-OFF run
 * allocates nothing here.
 */
export function deriveAgentRng(seed: number, agentId: string): Rng {
  const folded = (mixSeed(seed) ^ OODA_RNG_SALT ^ stableAgentHash(agentId)) >>> 0;
  return makeRngFromState(mixSeed(folded));
}
