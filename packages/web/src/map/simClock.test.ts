/**
 * simClock tests (TDD RED→GREEN).
 *
 * The sim clock maps wall-clock time to sim time. It is driven by server
 * `simMs` anchors and a local playback rate (simSpeed), with a clamped
 * smoothing nudge so the clock never lurches on resync.
 *
 * All tests run in node environment (pure JS, no browser/OL dependency).
 */
import { describe, expect, it } from "vitest";
import { makeSimClock } from "./simClock.js";

describe("makeSimClock", () => {
  it("returns 0 before first resync", () => {
    const clock = makeSimClock();
    // fromFrameTime before any resync → 0 (no authoritative anchor yet).
    expect(clock.fromFrameTime(1000)).toBe(0);
  });

  it("maps frame time to sim time after resync", () => {
    const clock = makeSimClock();
    // Resync: at wall time 1000ms, sim time is 5000ms.
    clock.resync(1000, 5000);
    // At the same wall time → same sim time.
    expect(clock.fromFrameTime(1000)).toBe(5000);
  });

  it("advances sim time proportionally to wall time (simSpeed=1)", () => {
    const clock = makeSimClock();
    clock.resync(0, 0);
    // Default simSpeed is 1 (1ms sim per 1ms wall).
    expect(clock.fromFrameTime(500)).toBe(500);
    expect(clock.fromFrameTime(1000)).toBe(1000);
  });

  it("scales sim time by simSpeed", () => {
    const clock = makeSimClock({ simSpeed: 60 }); // 60× realtime (demo speed)
    clock.resync(0, 0);
    // 1000ms wall → 60_000ms sim.
    expect(clock.fromFrameTime(1000)).toBe(60_000);
  });

  it("resync nudges clock rather than lurching (clamped correction)", () => {
    const clock = makeSimClock({ simSpeed: 1 });
    clock.resync(0, 0);
    // After 1000ms wall, sim should be 1000. Nudge the server anchor by 100ms
    // (server says sim is at 1100 at wall=1000 → 100ms ahead).
    clock.resync(1000, 1100);
    // Clock must not instantly jump to 1100; it nudges toward it.
    // The key constraint: the new sim reading is between old (1000) and server (1100).
    const after = clock.fromFrameTime(1000);
    expect(after).toBeGreaterThanOrEqual(1000);
    expect(after).toBeLessThanOrEqual(1100);
  });

  it("resync on the same leg is idempotent (same anchor, no change)", () => {
    const clock = makeSimClock({ simSpeed: 1 });
    clock.resync(0, 0);
    clock.resync(0, 0); // no change
    expect(clock.fromFrameTime(500)).toBe(500);
  });

  it("monotonic: sim time never goes backward after a nudge", () => {
    const clock = makeSimClock({ simSpeed: 1 });
    clock.resync(0, 1000); // anchor: wall=0 → sim=1000
    const t1 = clock.fromFrameTime(500); // sim ~1500
    // Server sends a slightly stale anchor (server sim = 900) — clock must not go back.
    clock.resync(500, 900);
    const t2 = clock.fromFrameTime(500);
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
