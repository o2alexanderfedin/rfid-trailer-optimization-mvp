import { describe, expect, it } from "vitest";
import {
  FUEL_RNG_SALT,
  HOS_RNG_SALT,
  INDUCTION_RNG_SALT,
  OUTBOUND_RNG_SALT,
  OVER_CARRY_RNG_SALT,
  RFID_RNG_SALT,
  TIMING_RNG_SALT,
} from "../engine.js";
import { deriveAgentRng, OODA_RNG_SALT, stableAgentHash } from "./rng.js";

/**
 * Phase-24 OODA-04 / DET-03 — the per-agent seeded substream primitives (RED
 * first). The agent id is the ONLY entropy source for per-agent randomness, so
 * these tests pin: FNV-1a purity, the pairwise-distinct salt (no collision with
 * the eight engine salts — PITFALLS Pitfall 3), first-K decorrelation across
 * distinct agents, and stable-id-not-array-position derivation.
 */

describe("stableAgentHash (FNV-1a, OODA-04)", () => {
  it("is pure: identical input ⇒ identical 32-bit digest", () => {
    expect(stableAgentHash("T001")).toBe(stableAgentHash("T001"));
    // The digest is a uint32.
    const h = stableAgentHash("T001");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xff_ff_ff_ff);
    expect(h >>> 0).toBe(h);
  });

  it("mirrors the canonical FNV-1a constants (init 0x811c9dc5, mul 0x01000193)", () => {
    // Reference computation, char-by-char, to prove the EXACT algorithm.
    const reference = (s: string): number => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < s.length; i += 1) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    };
    for (const id of ["T001", "MEM", "hub-ORD", "", "A", "AB"]) {
      expect(stableAgentHash(id)).toBe(reference(id));
    }
  });

  it("different ids ⇒ (overwhelmingly) different digests", () => {
    const ids = Array.from({ length: 256 }, (_, i) => `T${String(i).padStart(4, "0")}`);
    const digests = new Set(ids.map(stableAgentHash));
    // No collisions across 256 sequential ids.
    expect(digests.size).toBe(ids.length);
  });
});

describe("OODA_RNG_SALT (salt-collision guard, OODA-04)", () => {
  it("is pairwise-distinct from all seven existing engine salts (Set size 8)", () => {
    const salts = [
      RFID_RNG_SALT,
      OVER_CARRY_RNG_SALT,
      TIMING_RNG_SALT,
      HOS_RNG_SALT,
      FUEL_RNG_SALT,
      INDUCTION_RNG_SALT,
      OUTBOUND_RNG_SALT,
      OODA_RNG_SALT,
    ].map((s) => s >>> 0);
    // Seven engine substream salts + OODA_RNG_SALT = eight pairwise-distinct values.
    expect(new Set(salts).size).toBe(8);
    expect(OODA_RNG_SALT >>> 0).not.toBe(RFID_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(OVER_CARRY_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(TIMING_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(HOS_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(FUEL_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(INDUCTION_RNG_SALT >>> 0);
    expect(OODA_RNG_SALT >>> 0).not.toBe(OUTBOUND_RNG_SALT >>> 0);
  });

  it("is a uint32", () => {
    expect(OODA_RNG_SALT >>> 0).toBe(OODA_RNG_SALT);
    expect(Number.isInteger(OODA_RNG_SALT)).toBe(true);
  });
});

describe("deriveAgentRng — decorrelated per-agent substreams (OODA-04, T-24-01)", () => {
  const SEED = 42;
  const K = 8;

  const firstK = (seed: number, agentId: string): number[] => {
    const rng = deriveAgentRng(seed, agentId);
    return Array.from({ length: K }, () => rng.next());
  };

  it("identical (seed, id) ⇒ byte-identical stream (pure + deterministic)", () => {
    expect(firstK(SEED, "T002")).toEqual(firstK(SEED, "T002"));
  });

  it("N=64 distinct ids have pairwise-distinct first-K draw sequences (no shared prefix)", () => {
    const ids = Array.from({ length: 64 }, (_, i) => `T${String(i).padStart(4, "0")}`);
    const sequences = ids.map((id) => firstK(SEED, id));
    // Serialize each first-K sequence; assert all 64 are unique.
    const serialized = new Set(sequences.map((s) => s.join(",")));
    expect(serialized.size).toBe(ids.length);
    // Stronger: no two agents share even their FIRST draw (decorrelated at draw 0).
    const firstDraws = new Set(sequences.map((s) => s[0]));
    expect(firstDraws.size).toBe(ids.length);
  });

  it("is derived from the STABLE id string, independent of any array position", () => {
    // Whatever position "T002" sits at in a roster, its stream is identical.
    const a = firstK(SEED, "T002");
    const b = firstK(SEED, "T002");
    expect(a).toEqual(b);
    // A different id yields a different stream from the same seed.
    expect(firstK(SEED, "T002")).not.toEqual(firstK(SEED, "T003"));
  });

  it("different SEEDs yield different streams for the same id", () => {
    expect(firstK(1, "T002")).not.toEqual(firstK(2, "T002"));
  });
});
