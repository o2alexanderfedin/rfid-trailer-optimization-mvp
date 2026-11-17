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
import { OODA_RNG_SALT } from "../ooda/rng.js";
import { makeRng } from "../rng.js";
import {
  COORDINATOR_RNG_SALT,
  COORDINATOR_THRESHOLDS,
  type CoordinatorObservation,
  type CoordinatorSuggestion,
  decideCoordinatorSuggestions,
  deriveCoordinatorRng,
  stableCenterHash,
} from "./index.js";

/**
 * Phase-25 COORD-01/COORD-02 — the coordinator RNG salt + frozen per-center
 * observation + pure rule-based suggestion generation (RED first).
 *
 * Pins: the NINTH salt is a uint32 pairwise-distinct from the eight prior salts;
 * `deriveCoordinatorRng` is keyed on the STABLE centerId (rename/reorder ⇒
 * unchanged stream) and decorrelated across centers; `decideCoordinatorSuggestions`
 * generates all 4 kinds rule-based, pure + deterministic over a frozen observation.
 */

// ===========================================================================
// 1. SALT-COLLISION — COORDINATOR_RNG_SALT pairwise-distinct (local Set size 10)
// ===========================================================================
describe("COORDINATOR_RNG_SALT salt-collision (COORD-01)", () => {
  it("is a uint32", () => {
    expect(COORDINATOR_RNG_SALT >>> 0).toBe(COORDINATOR_RNG_SALT);
    expect(Number.isInteger(COORDINATOR_RNG_SALT)).toBe(true);
  });

  it("is pairwise-distinct from the eight existing salts (local Set size 9)", () => {
    // The eight prior salts (seven engine + OODA) + COORDINATOR_RNG_SALT = nine
    // pairwise-distinct values. Plan 05 owns the canonical salt-collision test that
    // asserts the full exported salt set (Set size 10 incl. the engine's own).
    const salts = [
      RFID_RNG_SALT,
      OVER_CARRY_RNG_SALT,
      TIMING_RNG_SALT,
      HOS_RNG_SALT,
      FUEL_RNG_SALT,
      INDUCTION_RNG_SALT,
      OUTBOUND_RNG_SALT,
      OODA_RNG_SALT,
      COORDINATOR_RNG_SALT,
    ].map((s) => s >>> 0);
    expect(new Set(salts).size).toBe(salts.length);
    expect(salts.length).toBe(9);
    expect(COORDINATOR_RNG_SALT >>> 0).not.toBe(OODA_RNG_SALT >>> 0);
  });
});

// ===========================================================================
// 2. stableCenterHash — FNV-1a purity (mirror stableAgentHash)
// ===========================================================================
describe("stableCenterHash (FNV-1a, COORD-01)", () => {
  it("is pure: identical input ⇒ identical 32-bit digest", () => {
    expect(stableCenterHash("MEM")).toBe(stableCenterHash("MEM"));
    const h = stableCenterHash("MEM");
    expect(Number.isInteger(h)).toBe(true);
    expect(h >>> 0).toBe(h);
  });

  it("mirrors the canonical FNV-1a constants (init 0x811c9dc5, mul 0x01000193)", () => {
    const reference = (s: string): number => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < s.length; i += 1) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    };
    for (const id of ["MEM", "ORD", "DFW", "", "A"]) {
      expect(stableCenterHash(id)).toBe(reference(id));
    }
  });

  it("different ids ⇒ different digests", () => {
    const ids = Array.from({ length: 64 }, (_, i) => `C${String(i).padStart(3, "0")}`);
    expect(new Set(ids.map(stableCenterHash)).size).toBe(ids.length);
  });
});

// ===========================================================================
// 3. deriveCoordinatorRng — keyed on STABLE centerId + decorrelated
// ===========================================================================
describe("deriveCoordinatorRng (COORD-01, Pitfall 3)", () => {
  const SEED = 42;
  const K = 8;
  const firstK = (centerId: string): number[] => {
    const rng = deriveCoordinatorRng(SEED, centerId);
    return Array.from({ length: K }, () => rng.next());
  };

  it("identical (seed, centerId) ⇒ byte-identical stream (pure + deterministic)", () => {
    expect(firstK("MEM")).toEqual(firstK("MEM"));
  });

  it("is derived from the STABLE centerId, independent of array position", () => {
    const a = firstK("MEM");
    const ids = ["DFW", "ORD", "MEM", "ATL"];
    expect([...ids].reverse().includes("MEM")).toBe(true);
    expect(firstK("MEM")).toEqual(a);
    expect(firstK("ORD")).not.toEqual(a);
  });

  it("N centers have pairwise-distinct first-K draw sequences (decorrelation)", () => {
    const ids = Array.from({ length: 16 }, (_, i) => `C${String(i).padStart(3, "0")}`);
    const sequences = ids.map(firstK);
    expect(new Set(sequences.map((s) => s.join(","))).size).toBe(ids.length);
    // No two centers share even their FIRST draw.
    expect(new Set(sequences.map((s) => s[0])).size).toBe(ids.length);
  });

  it("different seeds yield different streams for the same centerId", () => {
    expect(firstK("MEM")).not.toEqual(
      Array.from({ length: K }, deriveCoordinatorRng(7, "MEM").next),
    );
  });
});

// ===========================================================================
// 4. decideCoordinatorSuggestions — all 4 kinds, rule-based, pure + deterministic
// ===========================================================================
describe("decideCoordinatorSuggestions (COORD-02)", () => {
  const rng = (): ReturnType<typeof makeRng> => makeRng(123);

  /** A center observation builder with sensible empty defaults. */
  const obs = (over: Partial<CoordinatorObservation>): CoordinatorObservation => ({
    centerId: "MEM",
    tick: 10,
    issuedAtSimMs: 600_000,
    spokes: [],
    trucks: [],
    ...over,
  });

  const kindsOf = (s: readonly CoordinatorSuggestion[]): string[] =>
    s.map((x) => x.kind);

  it("a center with nothing to suggest returns [] (the no-op default, COORD-05)", () => {
    expect(decideCoordinatorSuggestions(obs({}), rng())).toEqual([]);
  });

  it("REROUTE: an in-region truck whose next hub exceeds the congestion threshold", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        trucks: [
          {
            trailerId: "T001",
            nextHubId: "SPOKE-A",
            nextHubQueueDepth: COORDINATOR_THRESHOLDS.congestionQueueDepth + 1,
          },
        ],
      }),
      rng(),
    );
    expect(result).toEqual([
      { kind: "reroute", targetAgentId: "T001", toHubId: "MEM" },
    ]);
  });

  it("REROUTE does NOT fire at or below the congestion threshold", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        trucks: [
          {
            trailerId: "T001",
            nextHubId: "SPOKE-A",
            nextHubQueueDepth: COORDINATOR_THRESHOLDS.congestionQueueDepth,
          },
        ],
      }),
      rng(),
    );
    expect(result).toEqual([]);
  });

  it("HOLD: a target whose next hub (spoke) is dock-busy with inbound freight", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        spokes: [
          {
            hubId: "SPOKE-A",
            inboundQueueDepth: 4,
            pendingConsolidationCount: 0,
            dockAvailable: false,
          },
        ],
      }),
      rng(),
    );
    expect(result).toEqual([{ kind: "hold", targetAgentId: "SPOKE-A" }]);
  });

  it("CONSOLIDATE: a spoke's pending-consolidation manifest exceeds the fill threshold", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        spokes: [
          {
            hubId: "SPOKE-A",
            inboundQueueDepth: 0,
            pendingConsolidationCount: COORDINATOR_THRESHOLDS.consolidationFill + 1,
            dockAvailable: true,
          },
        ],
      }),
      rng(),
    );
    expect(result).toEqual([{ kind: "consolidate", targetAgentId: "SPOKE-A" }]);
  });

  it("DISPATCH: an outbound-ready spoke (free dock + ready manifest under the consolidate fill)", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        spokes: [
          {
            hubId: "SPOKE-A",
            inboundQueueDepth: 0,
            pendingConsolidationCount: COORDINATOR_THRESHOLDS.dispatchReadyFill + 1,
            dockAvailable: true,
          },
        ],
      }),
      rng(),
    );
    expect(result).toEqual([
      { kind: "dispatch", targetAgentId: "SPOKE-A", toHubId: "MEM" },
    ]);
  });

  it("generates ALL FOUR kinds over a mixed observation", () => {
    const result = decideCoordinatorSuggestions(
      obs({
        trucks: [
          {
            trailerId: "T001",
            nextHubId: "SPOKE-A",
            nextHubQueueDepth: COORDINATOR_THRESHOLDS.congestionQueueDepth + 5,
          },
        ],
        spokes: [
          // dock-busy + inbound ⇒ hold; also over consolidate fill ⇒ consolidate
          {
            hubId: "SPOKE-A",
            inboundQueueDepth: 3,
            pendingConsolidationCount: COORDINATOR_THRESHOLDS.consolidationFill + 2,
            dockAvailable: false,
          },
          // free dock + ready (under consolidate fill) ⇒ dispatch
          {
            hubId: "SPOKE-B",
            inboundQueueDepth: 0,
            pendingConsolidationCount: COORDINATOR_THRESHOLDS.dispatchReadyFill + 1,
            dockAvailable: true,
          },
        ],
      }),
      rng(),
    );
    expect(new Set(kindsOf(result))).toEqual(
      new Set(["reroute", "hold", "consolidate", "dispatch"]),
    );
  });

  it("is PURE + deterministic: same frozen obs + same rng ⇒ byte-identical list", () => {
    const input = obs({
      trucks: [
        {
          trailerId: "T001",
          nextHubId: "SPOKE-A",
          nextHubQueueDepth: 99,
        },
      ],
      spokes: [
        {
          hubId: "SPOKE-A",
          inboundQueueDepth: 2,
          pendingConsolidationCount: 10,
          dockAvailable: false,
        },
      ],
    });
    const a = decideCoordinatorSuggestions(input, rng());
    const b = decideCoordinatorSuggestions(input, rng());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
