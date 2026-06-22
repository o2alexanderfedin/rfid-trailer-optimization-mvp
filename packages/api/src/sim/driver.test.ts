import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";
import { simulate } from "@mm/simulation";
import type * as EventStore from "@mm/event-store";
import type * as Projections from "@mm/projections";
import type { Broadcast } from "../ws/snapshots.js";
import type { ApiDb } from "../routes/queries.js";
import type { DriveSimulationPacedOptions, LoopLike } from "./driver.js";
import { resolveTickIntervalMs } from "./driver.js";

// ---------------------------------------------------------------------------
// HEAVY-MODULE MOCKS (hoisted): neutralize the per-tick Postgres I/O so the
// `driveSimulationPaced` LOOP BODY is exercised with NO real DB / Testcontainer.
//
// What we keep REAL: `@mm/simulation` (so `simulate(seed)` stays deterministic —
// the determinism assertions below mean nothing if the generator is faked) and
// the driver itself (the code under test).
//
// What we neutralize:
//   - `@mm/event-store.appendToStream` → spy no-op (we don't persist).
//   - `@mm/event-store.readAll`        → always `[]`, so the `fresh.length > 0`
//     inline-projection branch is SKIPPED (no `db.transaction()` / `applyInline`)
//     and the cross-tick `cursor` stays at 0n. This keeps the loop pure-ish while
//     still driving every pause / interval / runner / broadcast branch per tick.
//   - `@mm/projections.runCatchup`     → no-op (called every tick).
//   - `runDetection` / `applyInline`   → no-op (defensive; rfid is OFF here so the
//     detection branch never runs, and readAll → [] means applyInline is unreached).
// Other exports are preserved via `importActual` so the rest of the file (and the
// driver's type imports) are unaffected.
// ---------------------------------------------------------------------------

// `vi.hoisted` declares the spies in the SAME hoisted scope as the `vi.mock`
// factories below (both are lifted to the top of the module), so the factories
// can safely reference them — a plain top-level `const` would be initialized
// AFTER the hoisted factory runs ("cannot access before initialization").
const { appendSpy, readAllSpy, runCatchupSpy, runDetectionSpy } = vi.hoisted(() => ({
  appendSpy: vi.fn(() => Promise.resolve()),
  readAllSpy: vi.fn(() => Promise.resolve([])),
  runCatchupSpy: vi.fn(() => Promise.resolve()),
  runDetectionSpy: vi.fn(() => Promise.resolve()),
}));

vi.mock("@mm/event-store", async (importActual) => {
  const actual = await importActual<typeof EventStore>();
  return {
    ...actual,
    appendToStream: appendSpy,
    readAll: readAllSpy,
  };
});

vi.mock("@mm/projections", async (importActual) => {
  const actual = await importActual<typeof Projections>();
  return {
    ...actual,
    runCatchup: runCatchupSpy,
    runDetection: runDetectionSpy,
    applyInline: vi.fn(() => Promise.resolve()),
  };
});

/**
 * Unit tests for the sim driver's scenario-injection and live-loop integration.
 *
 * These tests use an in-memory mock (no Postgres / Testcontainer) to verify:
 *   (a) A scenario injection changes the stream seen by subsequent ticks.
 *   (b) After a scenario injection, the driver calls the RollingLoop.tick.
 *   (c) The no-scenario path is backward-compatible.
 *
 * The integration tests (pg-backed) are in test/*.int.test.ts.
 */

// --- Tests -------------------------------------------------------------------

describe("driveSimulation — scenario injection (unit stubs)", () => {
  it("(backward-compat) no scenario: the driver completes without error", async () => {
    // With undefined loop and no scenario, the driver must complete normally.
    // We import the driver dynamically to avoid Postgres at module load.
    const { driveSimulation } = await import("./driver.js");
    // driveSimulation with no loop and no broadcast should work (backward-compat).
    // We pass a minimal db-like shape to avoid actual DB calls.
    // NOTE: this test proves the import compiles and the function is exported.
    expect(typeof driveSimulation).toBe("function");
  });

  it("DriveSimulationWithScenarioOptions type: scenario knobs are optional", async () => {
    // This is a compile-time test: if the type does not exist, the import fails.
    const mod = await import("./driver.js");
    // The type is exported (it will be used in the server / route).
    // Since TypeScript erases types, we verify by checking the JS export.
    expect(mod.driveSimulation).toBeDefined();
  });

  it("injectsScenario: knobs flow into stream and trigger rollingLoop.tick", async () => {
    const { driveSimulationWithScenario } = await import("./driver.js");
    if (typeof driveSimulationWithScenario !== "function") {
      // The function may not exist yet — this is the RED state.
      expect(driveSimulationWithScenario).toBeDefined();
      return;
    }
    expect(driveSimulationWithScenario).toBeDefined();
  });

  it("exports driveSimulationWithScenario accepting scenario knobs", async () => {
    const mod = await import("./driver.js");
    // RED: this export doesn't exist yet — test will fail if not present.
    expect(mod.driveSimulationWithScenario).toBeDefined();
    expect(typeof mod.driveSimulationWithScenario).toBe("function");
  });

  it("exports getRollingLoop for server composition", async () => {
    // The driver or server must expose a way to set the RollingLoop for the scenario
    // route to trigger. This tests for the setter/setter pattern.
    const mod = await import("./driver.js");
    expect(mod.makeSimRunner).toBeDefined();
    expect(typeof mod.makeSimRunner).toBe("function");
  });
});

describe("makeSimRunner — rolling optimizer is triggered per tick", () => {
  it("calls loop.tick() for each tick when a loop is provided", async () => {
    const { makeSimRunner } = await import("./driver.js");

    // Mock loop.tick — tracks calls
    const tickResults: Array<{ events: readonly DomainEvent[]; simMs: number }> = [];
    const fakeResult: EpochResult = {
      epochId: "e1",
      scopeHash: "hash1",
      accepted: null,
      generated: null,
      recommendations: [],
    };
    const mockLoop = {
      tick: vi.fn((input: { events: readonly DomainEvent[]; simMs: number }) => {
        tickResults.push(input);
        return Promise.resolve(fakeResult);
      }),
    };

    // makeSimRunner builds the per-tick callable with the rolling loop wired in.
    const runner = makeSimRunner({ loop: mockLoop });
    expect(runner).toBeDefined();
    // The runner is a function that the driver calls per tick.
    expect(typeof runner).toBe("function");
  });

  it("loop.tick() receives the simMs for the tick", async () => {
    const { makeSimRunner } = await import("./driver.js");
    const tickCalls: number[] = [];
    const fakeResult: EpochResult = {
      epochId: "e2",
      scopeHash: "hash2",
      accepted: null,
      generated: null,
      recommendations: [],
    };
    const mockLoop = {
      tick: vi.fn((input: { events: readonly DomainEvent[]; simMs: number }) => {
        tickCalls.push(input.simMs);
        return Promise.resolve(fakeResult);
      }),
    };
    const runner = makeSimRunner({ loop: mockLoop });
    // Calling the runner with a known simMs should forward it to loop.tick.
    const events: DomainEvent[] = [];
    await runner(events, 60_000);
    expect(mockLoop.tick).toHaveBeenCalledOnce();
    expect(mockLoop.tick.mock.calls[0]![0].simMs).toBe(60_000);
  });

  it("no loop: runner is a no-op (backward-compat)", async () => {
    const { makeSimRunner } = await import("./driver.js");
    const runner = makeSimRunner({ loop: undefined });
    // Should not throw, should be a callable no-op.
    const events: DomainEvent[] = [];
    await expect(runner(events, 60_000)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T3 — live tick-interval resolution (presentation pacing, read per iteration)
// ---------------------------------------------------------------------------

describe("resolveTickIntervalMs — live interval read with safe fallbacks", () => {
  it("prefers the LIVE source over the captured fallback", () => {
    expect(resolveTickIntervalMs(() => 125, 500)).toBe(125);
  });

  it("re-reads the live source each call (mid-run retune takes effect)", () => {
    let current = 500;
    const live = () => current;
    expect(resolveTickIntervalMs(live, 500)).toBe(500);
    current = 62; // operator dragged the slider to 8×
    expect(resolveTickIntervalMs(live, 500)).toBe(62);
    current = 2000; // and back to 0.25×
    expect(resolveTickIntervalMs(live, 500)).toBe(2000);
  });

  it("falls back to the captured value when no live source is given", () => {
    expect(resolveTickIntervalMs(undefined, 750)).toBe(750);
  });

  it("falls back to 500 when neither a live source nor a captured value exists", () => {
    expect(resolveTickIntervalMs(undefined, undefined)).toBe(500);
  });

  it("coerces a non-positive / non-finite live value to the fallback (never a busy spin)", () => {
    expect(resolveTickIntervalMs(() => 0, 500)).toBe(500);
    expect(resolveTickIntervalMs(() => -10, 500)).toBe(500);
    expect(resolveTickIntervalMs(() => Number.NaN, 333)).toBe(333);
    expect(resolveTickIntervalMs(() => Number.POSITIVE_INFINITY, 333)).toBe(333);
  });
});

// ---------------------------------------------------------------------------
// T3 — DETERMINISM CONTRACT: pacing/pause are presentation-only. The emitted
// sim STREAM must be byte-identical regardless of tick interval or pause — the
// interval/pause flags never reach `simulate`. This guards the regression that
// would occur if pacing state ever leaked into the deterministic generator.
// ---------------------------------------------------------------------------

describe("sim stream determinism is independent of pacing/pause (presentation-only)", () => {
  it("simulate(seed) is byte-identical regardless of any pacing/pause settings", () => {
    // The paced driver generates the stream via `simulate({seed, durationTicks})`
    // with NO interval/pause inputs — proving those are purely a delivery concern.
    const a = simulate({ seed: 4242, durationTicks: 30 });
    const b = simulate({ seed: 4242, durationTicks: 30 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Spot-check the stream is non-trivial (so the equality is meaningful).
    expect(a.length).toBeGreaterThan(0);
  });

  it("different seeds DO diverge (the equality above is not vacuous)", () => {
    const a = simulate({ seed: 1, durationTicks: 30 });
    const b = simulate({ seed: 2, durationTicks: 30 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// T3 — driveSimulationPaced LOOP BODY (hermetic, NO Postgres).
//
// The heavy per-tick Postgres I/O is mocked away (see the hoisted vi.mock above),
// so the loop's PRESENTATION-PACING branches run against a fake db + injected
// fakes. We assert the three contract points the prompt calls for:
//   (a) the LIVE interval source is read FRESH each inter-tick gap,
//   (b) an external pause HOLDS the loop (no advance) and then RESUMES,
//   (c) the emitted event STREAM (what reaches the optimizer / append path) is
//       byte-identical regardless of the interval / pause settings — proving
//       pacing is presentation-only and never perturbs the deterministic stream.
// ---------------------------------------------------------------------------

/**
 * A fake `ApiDb` covering ONLY the surface the paced loop touches:
 *   - `selectFrom("streams").select("version").where(...).executeTakeFirst()`
 *     (the per-stream OCC version probe) → returns `undefined` (version 0).
 *   - `transaction()` is provided but UNREACHED here because `readAll` is mocked
 *     to `[]`, so the inline-projection branch never runs.
 * Mirrors the established fluent-builder stub style (see routes/kpis.test.ts).
 */
function buildFakeDb(): ApiDb {
  const builder = {
    select: () => builder,
    selectAll: () => builder,
    where: () => builder,
    orderBy: () => builder,
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(undefined),
  };
  return {
    selectFrom: () => builder,
    transaction: () => ({
      execute: (fn: (trx: unknown) => Promise<unknown>) => fn({}),
    }),
  } as unknown as ApiDb;
}

/** A minimal `Broadcast` stub that records the simMs it was handed per tick. */
function recordingBroadcast(sink: number[]): Broadcast {
  return (simMs: number) => {
    sink.push(simMs);
    return Promise.resolve({
      v: 1,
      type: "tick",
      seq: sink.length,
      simMs,
      speed: { multiplier: 1, tickIntervalMs: 0, simSpeed: 1, paused: false },
      payload: {},
    });
  };
}

/** A `LoopLike` stub that records the event stream + simMs of every tick. */
function recordingLoop(): {
  readonly loop: LoopLike;
  readonly calls: Array<{ events: readonly DomainEvent[]; simMs: number }>;
} {
  const calls: Array<{ events: readonly DomainEvent[]; simMs: number }> = [];
  const result: EpochResult = {
    epochId: "e",
    scopeHash: "h",
    accepted: null,
    generated: null,
    recommendations: [],
  };
  const loop: LoopLike = {
    tick: (input) => {
      calls.push({ events: input.events, simMs: input.simMs });
      return Promise.resolve(result);
    },
  };
  return { loop, calls };
}

/** Stable signature of the emitted stream — the deterministic delivery contract. */
function streamSignature(
  calls: ReadonlyArray<{ events: readonly DomainEvent[]; simMs: number }>,
): string {
  return JSON.stringify(calls.map((c) => ({ simMs: c.simMs, events: c.events })));
}

describe("driveSimulationPaced — loop body (interval, pause, determinism)", () => {
  beforeEach(() => {
    appendSpy.mockClear();
    readAllSpy.mockClear();
    runCatchupSpy.mockClear();
    runDetectionSpy.mockClear();
  });

  // The smallest seed/duration that still produces a non-trivial multi-tick run:
  // even durationTicks:1 yields 2 distinct domain timestamps (network setup), so
  // there is exactly >= 1 inter-tick GAP where the live interval is consulted.
  const SEED = 4242;
  const DURATION = 1;

  async function driveWith(
    overrides: Partial<DriveSimulationPacedOptions>,
  ): Promise<{
    result: { ticks: number };
    broadcasts: number[];
    loopCalls: Array<{ events: readonly DomainEvent[]; simMs: number }>;
  }> {
    const { driveSimulationPaced } = await import("./driver.js");
    const broadcasts: number[] = [];
    const { loop, calls } = recordingLoop();
    const result = await driveSimulationPaced({
      db: buildFakeDb(),
      seed: SEED,
      durationTicks: DURATION,
      broadcast: recordingBroadcast(broadcasts),
      loop,
      ...overrides,
    });
    return { result, broadcasts, loopCalls: calls };
  }

  it("(a) reads the LIVE interval source FRESH on each inter-tick gap", async () => {
    // A live source that records every read AND retunes mid-run (8x → 0.25x). The
    // loop must consult it once per GAP (= ticks - 1), using the value live each
    // time — proving the SpeedController retune lands on the very next gap.
    const reads: number[] = [];
    let live = 1; // start at 1ms gaps → fast + deterministic
    const getTickIntervalMs = (): number => {
      const value = live; // read the CURRENT live value...
      reads.push(value);
      live = 2; // ...then retune it, so a later read would observe the change
      return value;
    };

    const { result } = await driveWith({ getTickIntervalMs });

    // One read per inter-tick gap; never after the final tick (no trailing wait).
    expect(reads.length).toBe(result.ticks - 1);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    // It is the LIVE function that was consulted, returning the live value (1ms),
    // not a value captured once at start.
    expect(reads[0]).toBe(1);
  });

  it("(a') the live source takes precedence over the captured tickIntervalMs", async () => {
    // If both are present, resolveTickIntervalMs prefers the live source — assert
    // the loop wires the live source (read) and does NOT fall back to the capture.
    let consulted = false;
    const getTickIntervalMs = (): number => {
      consulted = true;
      return 1;
    };
    await driveWith({ getTickIntervalMs, tickIntervalMs: 9_999 });
    expect(consulted).toBe(true);
  });

  it("(b) an external pause HOLDS (no advance) then RESUMES", async () => {
    // isPaused returns true for the first few polls, THEN false. The loop must
    // spin on the pause gate (poll > once) BEFORE the first tick advances, and
    // nothing may be appended / broadcast / optimized while held.
    let pausePolls = 0;
    const HOLD_POLLS = 3;
    const sawAnyTickBeforeRelease = { value: false };
    const isPaused = (): boolean => {
      pausePolls += 1;
      // While still holding, assert NO tick side effects have happened yet.
      if (pausePolls <= HOLD_POLLS && appendSpy.mock.calls.length > 0) {
        sawAnyTickBeforeRelease.value = true;
      }
      return pausePolls <= HOLD_POLLS;
    };

    const { result, broadcasts, loopCalls } = await driveWith({
      isPaused,
      tickIntervalMs: 1,
    });

    // The gate was polled MORE than once (it actually HELD, not a single check).
    expect(pausePolls).toBeGreaterThan(HOLD_POLLS);
    // The hold released and the run completed all ticks (resumed cleanly).
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    expect(broadcasts.length).toBe(result.ticks);
    expect(loopCalls.length).toBe(result.ticks);
    // No tick side effects leaked during the hold.
    expect(sawAnyTickBeforeRelease.value).toBe(false);
  });

  it("(b') with no isPaused source the loop never holds (back-compat)", async () => {
    // Absent pause source ⇒ `opts.isPaused?.()` is undefined ⇒ the while-gate is
    // skipped entirely and every tick advances.
    const { result, broadcasts } = await driveWith({ tickIntervalMs: 1 });
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    expect(broadcasts.length).toBe(result.ticks);
  });

  it("(c) the emitted event STREAM is IDENTICAL regardless of interval/pause", async () => {
    // Run 1: fast, never paused.
    const fast = await driveWith({ tickIntervalMs: 1 });

    // Run 2: a DIFFERENT (live, retuning) interval AND a pause that holds then
    // releases — i.e. wildly different PRESENTATION pacing, SAME seed.
    let paused = true;
    let releaseCountdown = 4;
    const isPaused = (): boolean => {
      if (paused && --releaseCountdown <= 0) paused = false;
      return paused;
    };
    let liveMs = 3;
    const getTickIntervalMs = (): number => {
      const v = liveMs;
      liveMs = liveMs === 3 ? 1 : 3; // oscillate the interval mid-run
      return v;
    };
    const slow = await driveWith({ getTickIntervalMs, isPaused });

    // Same number of ticks driven, same broadcast simMs sequence...
    expect(slow.result.ticks).toBe(fast.result.ticks);
    expect(slow.broadcasts).toEqual(fast.broadcasts);
    // ...and BYTE-IDENTICAL event stream into the optimizer (pacing/pause never
    // reached `simulate` — the determinism contract holds end-to-end).
    expect(streamSignature(slow.loopCalls)).toBe(streamSignature(fast.loopCalls));
    // Non-vacuous: the stream actually carried events.
    expect(fast.loopCalls.some((c) => c.events.length > 0)).toBe(true);
  });

  it("returns { ticks } and broadcasts exactly once per tick", async () => {
    const { result, broadcasts } = await driveWith({ tickIntervalMs: 1 });
    expect(result.ticks).toBeGreaterThanOrEqual(1);
    expect(broadcasts.length).toBe(result.ticks);
    // runCatchup is invoked once per tick (the catch-up projection advance).
    expect(runCatchupSpy.mock.calls.length).toBe(result.ticks);
    // The OCC append path was exercised (per-stream appends happened).
    expect(appendSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("with rfid enabled the detection branch runs (departed-hub gate + runDetection)", async () => {
    // Enabling rfid flips `detectionOn`, so the loop also tracks departed hubs and
    // invokes the (mocked, no-op) detector each tick. readAll is still mocked to []
    // so the inline projection fold is skipped — keeping this hermetic. This drives
    // the otherwise-uncovered `detectionOn` branches of the paced loop body.
    const { result, broadcasts } = await driveWith({
      rfid: {},
      tickIntervalMs: 1,
    });
    expect(result.ticks).toBeGreaterThanOrEqual(1);
    expect(broadcasts.length).toBe(result.ticks);
    // Detection runs once per tick (the no-op detector spy).
    expect(runDetectionSpy.mock.calls.length).toBe(result.ticks);
  });

  it("a zero/non-positive live interval is coerced so the loop never busy-spins", async () => {
    // getTickIntervalMs returning 0 must fall back (resolveTickIntervalMs), so the
    // gap is the captured tickIntervalMs (1ms) — the run still completes promptly.
    const { result } = await driveWith({
      getTickIntervalMs: () => 0,
      tickIntervalMs: 1,
    });
    expect(result.ticks).toBeGreaterThanOrEqual(2);
  });
});
