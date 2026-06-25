import { describe, expect, it } from "vitest";
import { makeRng, makeRngFromState } from "../src/rng.js";

/**
 * Plan 19-08 Task A — RNG raw-state (de)serialization.
 *
 * The resumable engine carries each seeded sub-stream's RAW state in the
 * serializable `SimContinuation`. Restoring an RNG from a captured state MUST
 * reproduce the EXACT remaining sequence — the byte-identity keystone for the
 * chunked-via-continuation path.
 */
describe("RNG state serialization (Task A)", () => {
  it("getState + makeRngFromState reproduces the exact remaining sequence", () => {
    const a = makeRng(1234);
    // Burn a few draws so the state is mid-stream (not the seed default).
    for (let i = 0; i < 7; i += 1) a.next();
    const captured = a.getState();

    const restored = makeRngFromState(captured);
    // The restored generator must produce the same next 100 values as `a`.
    for (let i = 0; i < 100; i += 1) {
      expect(restored.next()).toBe(a.next());
    }
  });

  it("a fresh makeRng(seed) and a state-restored RNG at the same point agree", () => {
    const seedRng = makeRng(42);
    const probe = makeRng(42);
    for (let i = 0; i < 13; i += 1) probe.next();
    const restored = makeRngFromState(probe.getState());

    // Advance the seedRng to the same point, then compare.
    for (let i = 0; i < 13; i += 1) seedRng.next();
    for (let i = 0; i < 50; i += 1) {
      expect(restored.next()).toBe(seedRng.next());
    }
  });

  it("state is a finite uint32 number (serializable into the continuation DTO)", () => {
    const r = makeRng(7);
    r.int(50);
    const s = r.getState();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(0x1_0000_0000);
  });

  it("int/pick are reproduced across a state restore", () => {
    const a = makeRng(99);
    a.next();
    a.int(50);
    const restored = makeRngFromState(a.getState());
    const items = ["x", "y", "z"] as const;
    for (let i = 0; i < 30; i += 1) {
      expect(restored.int(50)).toBe(a.int(50));
      expect(restored.pick(items)).toBe(a.pick(items));
    }
  });
});
