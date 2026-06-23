/**
 * Unit tests for the PURE accumulator pacing helpers (TDD RED → GREEN).
 *
 * `computeSimAdvanceMs` and `selectDrain` are the math of the fixed-cadence
 * accumulator (spec §4): how far sim-time moves per wall-clock frame, and which
 * pre-baked ticks drain under the per-frame budget. They are PURE (no I/O, no
 * `Date.now()`), so the driver's pacing is fully testable in isolation and the
 * determinism contract (pacing never reaches `simulate`) is structurally obvious.
 */

import { describe, expect, it } from "vitest";
import { computeSimAdvanceMs, selectDrain } from "./pacing.js";

// The speed-math identity (spec §4 / interfaces): rate = msPerTick/defaultIntervalMs
// = 60000/500 = 120 sim-ms per wall-ms at 1×.
const MS_PER_TICK = 60_000;
const DEFAULT_INTERVAL_MS = 500;

describe("computeSimAdvanceMs — fixed-cadence accumulator advance math", () => {
  it("1× over a 250ms frame advances 30_000 sim-ms (= 250 × 120 × 1)", () => {
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 250,
        multiplier: 1,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(30_000);
  });

  it("64× over a 250ms frame advances 1_920_000 sim-ms (= 250 × 120 × 64)", () => {
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 250,
        multiplier: 64,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(1_920_000);
  });

  it("multiplier 0 (paused) advances 0 sim-ms (clock frozen)", () => {
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 250,
        multiplier: 0,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(0);
  });

  it("clamps a huge wallDelta to the default max (1000ms) to avoid post-stall jumps", () => {
    // wallDeltaMs:100000 clamps to 1000 → 1000 × 120 × m.
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 100_000,
        multiplier: 1,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(1000 * 120 * 1);
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 100_000,
        multiplier: 8,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(1000 * 120 * 8);
  });

  it("honors an explicit maxWallDeltaMs override", () => {
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: 5000,
        multiplier: 1,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
        maxWallDeltaMs: 500,
      }),
    ).toBe(500 * 120 * 1);
  });

  it("a negative wallDelta yields 0 (never moves the clock backwards)", () => {
    expect(
      computeSimAdvanceMs({
        wallDeltaMs: -10,
        multiplier: 1,
        msPerTick: MS_PER_TICK,
        defaultIntervalMs: DEFAULT_INTERVAL_MS,
      }),
    ).toBe(0);
  });
});

describe("selectDrain — which pre-baked ticks drain this frame (budget-aware)", () => {
  const TICK_TIMES = [0, 60_000, 120_000, 180_000] as const;

  it("drains every tick with occurredAt ≤ simClock when within budget", () => {
    // simClock 130_000 ⇒ ticks at 0, 60k, 120k qualify (3); budget 32 not hit.
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 0,
        simClock: 130_000,
        maxTicks: 32,
      }),
    ).toEqual({ count: 3, clampSimClock: 130_000 });
  });

  it("caps at the budget and clamps simClock to the last drained tick time", () => {
    // budget 2 ⇒ drain only ticks 0 + 60k; clamp simClock to index1 time = 60_000.
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 0,
        simClock: 130_000,
        maxTicks: 2,
      }),
    ).toEqual({ count: 2, clampSimClock: 60_000 });
  });

  it("drains nothing when simClock precedes the next tick (clock unchanged)", () => {
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 0,
        simClock: -1,
        maxTicks: 32,
      }),
    ).toEqual({ count: 0, clampSimClock: -1 });
  });

  it("drains nothing when nextIndex is past the end of the stream", () => {
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 4,
        simClock: 999_999,
        maxTicks: 32,
      }),
    ).toEqual({ count: 0, clampSimClock: 999_999 });
  });

  it("respects nextIndex as the first undrained tick (carry across frames)", () => {
    // Already drained 0 + 60k (nextIndex 2). simClock 200k ⇒ drain 120k + 180k.
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 2,
        simClock: 200_000,
        maxTicks: 32,
      }),
    ).toEqual({ count: 2, clampSimClock: 200_000 });
  });

  it("does not clamp when exactly the budget worth of due ticks drain (no over-cap)", () => {
    // 2 ticks due (0 + 60k) and budget 2 ⇒ count 2, but NOT budget-capped against
    // more-due ticks, so the input simClock is preserved.
    expect(
      selectDrain({
        tickTimesMs: TICK_TIMES,
        nextIndex: 0,
        simClock: 60_000,
        maxTicks: 2,
      }),
    ).toEqual({ count: 2, clampSimClock: 60_000 });
  });
});
