import { describe, expect, it } from "vitest";

import { isFrozen, scopeHash } from "./freeze-idempotency.js";
import type { Epoch, OptimizerScope, TwinSnapshot } from "./types.js";

/**
 * OPT-06 KEYSTONE (the anti-P7 thrash defenses):
 *  - `scopeHash(scope, twinSnapshot)` is a STABLE, canonical hash of the input —
 *    key-order-independent, so logically-identical inputs hash identically (the
 *    idempotency key the shell memoizes on).
 *  - `isFrozen(departureMin, epoch)` is true for a trailer departing within the
 *    freeze window `[now, now + freezeWindowMin]` — those trailers are left
 *    untouched across epochs.
 */

const SCOPE: OptimizerScope = {
  hubIds: ["H1", "H2"],
  trailerIds: ["T1"],
  horizonStartMin: 100,
  horizonEndMin: 340,
  timeStepMin: 15,
};

function snapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2"],
    routes: [{ routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 10 }],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 200,
        capacity: 10,
        route: [{ hubId: "H2", stopIndex: 0 }],
        blocks: [{ blockId: "B1", nextUnloadHubId: "H2", volume: 4 }],
      },
    ],
  };
}

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

describe("scopeHash (OPT-06 idempotency key)", () => {
  it("is identical for two structurally-identical inputs", () => {
    expect(scopeHash(SCOPE, snapshot())).toBe(scopeHash(SCOPE, snapshot()));
  });

  it("is INDEPENDENT of object key insertion order (canonical serialization)", () => {
    const reordered: OptimizerScope = {
      timeStepMin: 15,
      trailerIds: ["T1"],
      horizonEndMin: 340,
      hubIds: ["H1", "H2"],
      horizonStartMin: 100,
    };
    expect(scopeHash(reordered, snapshot())).toBe(scopeHash(SCOPE, snapshot()));
  });

  it("CHANGES when the input changes (a different trailer load ⇒ different hash)", () => {
    const a = scopeHash(SCOPE, snapshot());
    // Build a NEW, fully-typed snapshot with the first block's volume changed
    // (no unsound `as` cast over the readonly `blocks` array).
    const base = snapshot();
    const baseTrailer = base.trailers[0]!;
    const mutated: TwinSnapshot = {
      ...base,
      trailers: [
        {
          ...baseTrailer,
          blocks: baseTrailer.blocks.map((b, i) =>
            i === 0 ? { ...b, volume: 9 } : b,
          ),
        },
        ...base.trailers.slice(1),
      ],
    };
    expect(scopeHash(SCOPE, mutated)).not.toBe(a);
  });

  it("returns a non-empty hex string (stable digest)", () => {
    expect(scopeHash(SCOPE, snapshot())).toMatch(/^[0-9a-f]+$/);
  });
});

describe("isFrozen (OPT-06 freeze window)", () => {
  it("is TRUE for a trailer departing within the freeze window", () => {
    // now=100, freeze=15 ⇒ window [100,115]; depart@110 is frozen.
    expect(isFrozen(110, EPOCH)).toBe(true);
  });

  it("is TRUE at the exact window edge (now and now+freeze inclusive)", () => {
    expect(isFrozen(100, EPOCH)).toBe(true);
    expect(isFrozen(115, EPOCH)).toBe(true);
  });

  it("is FALSE for a trailer departing after the freeze window", () => {
    expect(isFrozen(116, EPOCH)).toBe(false);
    expect(isFrozen(500, EPOCH)).toBe(false);
  });

  it("is FALSE for a trailer that already departed (before now)", () => {
    expect(isFrozen(50, EPOCH)).toBe(false);
  });
});
