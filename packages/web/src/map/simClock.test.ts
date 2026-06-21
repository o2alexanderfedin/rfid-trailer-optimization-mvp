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

  // ---------------------------------------------------------------------------
  // FIX D: single-clock-basis invariant
  // ---------------------------------------------------------------------------

  it("produces a correct fraction when resync and fromFrameTime use the SAME clock basis", () => {
    // This pins the FIX D invariant: both resync(wallMs) and fromFrameTime(wallMs)
    // MUST receive values from the SAME wall-clock source.
    //
    // OL's frameState.time is Date.now()-based (confirmed: OL animationDelay_ calls
    // renderFrame_(Date.now())).  So resync() must also receive Date.now() — NOT
    // performance.now() — as its wallMs argument.
    //
    // This test simulates the correct same-basis pattern:
    //   t=1000 (Date.now()-epoch): resync anchor at simMs=5000
    //   t=1500 (Date.now()-epoch): fromFrameTime → should give 5500
    const clock = makeSimClock({ simSpeed: 1 });
    const basis = 1_700_000_000_000; // simulated Date.now() value (Jan 2024)
    clock.resync(basis, 5000);
    expect(clock.fromFrameTime(basis + 500)).toBe(5500);
    expect(clock.fromFrameTime(basis + 1000)).toBe(6000);
  });

  // ---------------------------------------------------------------------------
  // T1 — the latent clock bug: simSpeed=1 cannot track the 120× server cadence.
  //
  // The paced driver jumps the authoritative simMs by MS_PER_TICK (60_000) every
  // tickIntervalMs (~500 wall-ms) → a 120× time compression. A simSpeed=1 clock
  // only advances ~500 sim-ms per 500 wall-ms and the resync nudge is clamped to
  // maxNudgeMs (500), so it can recover at most ~1000 sim-ms/tick while the server
  // moves 60_000 — it falls progressively, unboundedly behind. simSpeed=120 makes
  // the local advance (500 × 120 = 60_000) match the server jump exactly, so it
  // tracks within a tiny nudge tolerance.
  // ---------------------------------------------------------------------------

  /**
   * Replay the real paced cadence against a clock: every 500 wall-ms the server
   * has advanced simMs by 60_000; we resync, then sample `fromFrameTime` at that
   * same wall instant. Returns the absolute lag (serverSim − clockSim) after N
   * ticks. A high lag means the clock cannot keep up with the cadence.
   */
  function replayCadenceLag(simSpeed: number, ticks: number): number {
    const clock = makeSimClock({ simSpeed });
    const TICK_WALL = 500; // wall-ms between server ticks
    const TICK_SIM = 60_000; // sim-ms the server jumps per tick (MS_PER_TICK)
    const wall0 = 1_700_000_000_000; // Date.now()-style basis

    let serverSim = 0;
    let wall = wall0;
    let clockSim = 0;
    for (let i = 0; i < ticks; i++) {
      // First sample at i=0 anchors; subsequent samples advance the clock.
      clockSim = clock.fromFrameTime(wall);
      clock.resync(wall, serverSim);
      wall += TICK_WALL;
      serverSim += TICK_SIM;
    }
    // Final reading at the last wall instant.
    clockSim = clock.fromFrameTime(wall);
    return Math.abs(serverSim - clockSim);
  }

  it("RED: simSpeed=1 lags the 120× server cadence by a huge margin after ~30 ticks", () => {
    const lag = replayCadenceLag(1, 30);
    // The server has advanced 31 × 60_000 = 1_860_000 sim-ms. A simSpeed=1 clock
    // recovers at most ~1000 sim-ms/tick → it is behind by well over a million ms.
    expect(lag).toBeGreaterThan(1_000_000);
  });

  it("GREEN: simSpeed=120 tracks the same cadence within a small tolerance", () => {
    const lag = replayCadenceLag(120, 30);
    // 500 wall-ms × 120 = 60_000 sim-ms per tick == the server jump → near-zero lag.
    // Allow one nudge-clamp's worth of slack for the initial anchor settling.
    expect(lag).toBeLessThanOrEqual(maxNudgeTolerance());
  });

  function maxNudgeTolerance(): number {
    // One maxNudgeMs (500) of residual is the worst-case single-step correction.
    return 1000;
  }

  it("setSpeed(120) HALTS the unbounded lag growth that simSpeed=1 suffers", () => {
    // Start mistuned at simSpeed=1, then correct to 120 — as MapView does on the
    // first envelope. The defining property: once retuned, the lag STOPS growing
    // (per-tick advance now matches the server jump), whereas at simSpeed=1 it
    // grows by ~59_000/tick forever.
    const TICK_WALL = 500;
    const TICK_SIM = 60_000;
    const wall0 = 1_700_000_000_000;

    function lagAfter(setSpeedTo120: boolean): number {
      const clock = makeSimClock({ simSpeed: 1 });
      let serverSim = 0;
      let wall = wall0;
      // 5 mistuned ticks accumulate a fixed lag.
      for (let i = 0; i < 5; i++) {
        clock.fromFrameTime(wall);
        clock.resync(wall, serverSim);
        wall += TICK_WALL;
        serverSim += TICK_SIM;
      }
      if (setSpeedTo120) clock.setSpeed(120);
      // 30 more ticks: at 120 the lag holds/shrinks; at 1 it keeps growing.
      for (let i = 0; i < 30; i++) {
        clock.fromFrameTime(wall);
        clock.resync(wall, serverSim);
        wall += TICK_WALL;
        serverSim += TICK_SIM;
      }
      return Math.abs(serverSim - clock.fromFrameTime(wall));
    }

    const lagRetuned = lagAfter(true);
    const lagStuck = lagAfter(false);
    // Retuning to 120 keeps the lag near the small residual from the 5 mistuned
    // ticks; leaving it at 1 lets the lag balloon by another ~30 × 59_000.
    expect(lagRetuned).toBeLessThan(lagStuck);
    expect(lagStuck - lagRetuned).toBeGreaterThan(1_000_000);
  });

  it("setSpeed(0) freezes the clock: fromFrameTime stays constant as wall time elapses", () => {
    const clock = makeSimClock({ simSpeed: 120 });
    const wall0 = 1_700_000_000_000;
    clock.resync(wall0, 600_000);
    const frozenAt = clock.fromFrameTime(wall0);

    clock.setSpeed(0); // pause

    // Wall time keeps elapsing, but the sim clock must not advance.
    expect(clock.fromFrameTime(wall0 + 500)).toBe(frozenAt);
    expect(clock.fromFrameTime(wall0 + 5_000)).toBe(frozenAt);
    expect(clock.fromFrameTime(wall0 + 60_000)).toBe(frozenAt);
  });

  it("produces a WRONG fraction when resync and fromFrameTime use DIFFERENT clock bases", () => {
    // This pins why performance.now() in resync() breaks the animation:
    // performance.now() is typically a small number (ms since page load, e.g. 50ms),
    // while Date.now() is a large epoch value (e.g. 1_700_000_000_000).
    // The elapsed = frameTime - anchorWallMs computation yields a huge negative or
    // positive number, making the tween fraction completely wrong.
    const clock = makeSimClock({ simSpeed: 1 });
    // Simulate: resync receives performance.now()-style value (small, e.g. 50ms since page load)
    const perfNowStyle = 50;
    clock.resync(perfNowStyle, 5000); // anchor: wall=50 → sim=5000
    // But fromFrameTime receives Date.now()-style value (epoch-based, very large).
    const dateNowStyle = 1_700_000_000_500; // 1_700_000_000_000 + 500ms
    // The computed simNow would be: 5000 + (dateNowStyle - 50) * 1 = astronomically large
    const wrongSimNow = clock.fromFrameTime(dateNowStyle);
    // It is definitely NOT 5500 (what we'd want for +500ms of wall elapsed).
    // It's orders of magnitude larger — proving the bug.
    expect(wrongSimNow).toBeGreaterThan(1_000_000_000); // astronomically wrong
    // Correct answer would be 5500 — completely different.
    expect(wrongSimNow).not.toBeCloseTo(5500, 0);
  });
});
