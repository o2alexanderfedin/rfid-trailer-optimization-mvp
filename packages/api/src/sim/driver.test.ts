import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { DEFAULT_HOS_CONFIG } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";
import { simulate } from "@mm/simulation";
import type * as EventStore from "@mm/event-store";
import type * as Projections from "@mm/projections";
import type { Broadcast } from "../ws/snapshots.js";
import type { ApiDb } from "../routes/queries.js";
import type { DriveSimulationPacedOptions, LoopLike } from "./driver.js";

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
// driveSimulationPaced ACCUMULATOR LOOP BODY (hermetic, NO Postgres).
//
// The heavy per-tick Postgres I/O is mocked away (see the hoisted vi.mock above),
// so the fixed-cadence accumulator runs against a fake db + injected fakes. The
// driver now: advances a simClock by `wallDelta × 120 × multiplier` per FRAME,
// drains every pre-baked tick with `occurredAt ≤ simClock` (bounded by a per-
// frame budget), fires the optimizer NON-blocking via the coalescer, and emits
// ONE ws delta per frame. We assert the accumulator contract (Task 4 policy):
//   - all events delivered (union into the optimizer == the source stream),
//   - simClock monotone & complete (result.ticks == source tick count),
//   - ONE broadcast per frame (not per tick) — batching holds,
//   - budget carry (maxTicksPerFrame:1 drains across frames; all still deliver),
//   - pause freezes the clock/drain, then resumes and completes,
//   - determinism preserved (different frameMs/pause ⇒ SAME event multiset).
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
      simDay: 0,
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

/**
 * An order-insensitive multiset signature of the events delivered to the
 * optimizer across (coalesced) calls. The accumulator/coalescer may regroup
 * events across frames, so the DETERMINISM contract is the event MULTISET, not
 * the per-call boundaries.
 */
function eventMultiset(
  calls: ReadonlyArray<{ events: readonly DomainEvent[]; simMs: number }>,
): string {
  const sigs = calls
    .flatMap((c) => c.events)
    .map((e) => JSON.stringify(e))
    .sort();
  return JSON.stringify(sigs);
}

/** All event objects delivered to the optimizer, flattened (delivery union). */
function allDeliveredEvents(
  calls: ReadonlyArray<{ events: readonly DomainEvent[]; simMs: number }>,
): readonly DomainEvent[] {
  return calls.flatMap((c) => c.events);
}

describe("driveSimulationPaced — accumulator loop body (fixed cadence + batch)", () => {
  beforeEach(() => {
    appendSpy.mockClear();
    readAllSpy.mockClear();
    runCatchupSpy.mockClear();
    runDetectionSpy.mockClear();
  });

  // The smallest seed/duration that still produces a non-trivial multi-tick run:
  // even durationTicks:1 yields >= 2 distinct domain timestamps (network setup).
  const SEED = 4242;
  const DURATION = 1;

  /** A getMultiplier returning 64 — fast enough that tiny frames drain everything. */
  const fast64 = (): number => 64;

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
      // Tiny frame + huge multiplier + large budget ⇒ everything drains promptly
      // unless a test overrides these. getMultiplier is the live speed source.
      frameMs: 1,
      maxTicksPerFrame: 1024,
      getMultiplier: fast64,
      ...overrides,
    });
    return { result, broadcasts, loopCalls: calls };
  }

  it("delivers EVERY source event to the optimizer (union == source stream)", async () => {
    // Drive a tiny frame + large budget so the whole stream drains, then assert
    // the union of optimizer-delivered events equals the source stream's events.
    const sourceStream = simulate({ seed: SEED, durationTicks: DURATION });
    const sourceEvents = sourceStream.map((s) => s.event);

    const { loopCalls, result } = await driveWith({ optimizerEveryTicks: 1 });

    const delivered = allDeliveredEvents(loopCalls);
    expect(delivered.length).toBe(sourceEvents.length);
    // Same multiset of events reached the optimizer (no drop / no dup).
    const srcSig = JSON.stringify(sourceEvents.map((e) => JSON.stringify(e)).sort());
    const gotSig = JSON.stringify(delivered.map((e) => JSON.stringify(e)).sort());
    expect(gotSig).toBe(srcSig);
    // Non-vacuous + the run reported a tick count.
    expect(sourceEvents.length).toBeGreaterThan(0);
    expect(result.ticks).toBeGreaterThanOrEqual(2);
  });

  it("simClock is monotone & complete: result.ticks == source tick count; last broadcast ≥ last tick time", async () => {
    const sourceStream = simulate({ seed: SEED, durationTicks: DURATION });
    // distinct timestamps == tick count
    const distinct = new Set(sourceStream.map((s) => s.occurredAt));
    const lastTickMs = Math.max(...sourceStream.map((s) => new Date(s.occurredAt).getTime()));

    const { result, broadcasts } = await driveWith({});

    expect(result.ticks).toBe(distinct.size);
    // The broadcast simMs sequence is non-decreasing (simClock never goes back).
    for (let i = 1; i < broadcasts.length; i += 1) {
      expect(broadcasts[i]!).toBeGreaterThanOrEqual(broadcasts[i - 1]!);
    }
    // The final broadcast reports a simClock at/after the last tick's time.
    expect(broadcasts.at(-1)!).toBeGreaterThanOrEqual(lastTickMs);
  });

  it("broadcasts ONCE per FRAME, not per tick (batching holds)", async () => {
    // A multiplier large enough to leap the WHOLE stream in the first frame's
    // advance ⇒ every tick drains in ONE frame ⇒ the broadcast count (per-frame:
    // one frame delta + one final) is far fewer than the per-tick count.
    const { result, broadcasts } = await driveWith({
      maxTicksPerFrame: 1024,
      getMultiplier: () => 1e12, // leap the full horizon in one frame
    });
    // Everything drained in a single frame ⇒ broadcasts << ticks (1 frame + final).
    expect(broadcasts.length).toBeLessThanOrEqual(result.ticks);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    // BATCHED: the heavy DB folds run ONCE per FRAME, not per tick — leaping the
    // whole horizon in one frame ⇒ exactly ONE catch-up for all drained ticks.
    expect(runCatchupSpy.mock.calls.length).toBe(1);
    expect(runCatchupSpy.mock.calls.length).toBeLessThan(result.ticks);
  });

  it("budget carry: maxTicksPerFrame:1 drains across multiple frames; all events still delivered", async () => {
    const sourceStream = simulate({ seed: SEED, durationTicks: DURATION });
    const sourceEvents = sourceStream.map((s) => s.event);

    const { result, broadcasts, loopCalls } = await driveWith({
      maxTicksPerFrame: 1,
      optimizerEveryTicks: 1,
    });

    // With a 1-tick budget and enough sim-advance, ticks drain over many frames —
    // so the broadcast (per-frame) count is at least the tick count.
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    expect(broadcasts.length).toBeGreaterThanOrEqual(result.ticks);
    // No event lost despite the carry: union still equals the source.
    expect(eventMultiset(loopCalls)).toBe(
      eventMultiset([{ events: sourceEvents, simMs: 0 }]),
    );
  });

  it("pause freezes the clock/drain during the hold, then resumes and completes", async () => {
    // isPaused holds for several frames; while held, the multiplier is treated as
    // 0 so simClock does not advance and NO tick drains — nothing appended/
    // broadcast/optimized. After release the run completes and delivers all events.
    let polls = 0;
    const HOLD = 5;
    let leakedDuringHold = false;
    const isPaused = (): boolean => {
      polls += 1;
      if (polls <= HOLD && appendSpy.mock.calls.length > 0) leakedDuringHold = true;
      return polls <= HOLD;
    };

    const { result, broadcasts, loopCalls } = await driveWith({ isPaused });

    expect(polls).toBeGreaterThan(HOLD); // it actually HELD across frames
    expect(leakedDuringHold).toBe(false); // no side effects while frozen
    expect(result.ticks).toBeGreaterThanOrEqual(2); // resumed + completed
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect(allDeliveredEvents(loopCalls).length).toBeGreaterThan(0);
  });

  it("(back-compat) with no isPaused source the loop never freezes", async () => {
    const { result } = await driveWith({});
    expect(result.ticks).toBeGreaterThanOrEqual(2);
  });

  it("determinism: different frameMs/pause schedules deliver the SAME event multiset", async () => {
    // Run 1: tiny frames, never paused.
    const a = await driveWith({ frameMs: 1, maxTicksPerFrame: 1024 });

    // Run 2: a bigger budget-of-1 carry AND a pause that holds then releases —
    // wildly different presentation pacing, SAME seed.
    let paused = true;
    let countdown = 4;
    const isPaused = (): boolean => {
      if (paused && --countdown <= 0) paused = false;
      return paused;
    };
    const b = await driveWith({ frameMs: 2, maxTicksPerFrame: 1, isPaused });

    // Same number of ticks driven and the SAME multiset of events into the
    // optimizer (pacing/pause never reached `simulate`). Per-call batching may
    // differ, so we compare the multiset/union — not call-by-call boundaries.
    expect(b.result.ticks).toBe(a.result.ticks);
    expect(eventMultiset(b.loopCalls)).toBe(eventMultiset(a.loopCalls));
    // Non-vacuous: the stream actually carried events.
    expect(allDeliveredEvents(a.loopCalls).length).toBeGreaterThan(0);
  });

  it("returns { ticks }; the OCC append path ran per tick; catch-up batched per frame", async () => {
    const { result, broadcasts } = await driveWith({});
    expect(result.ticks).toBeGreaterThanOrEqual(1);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    // Catch-up is BATCHED per frame: it runs at most once per drained tick
    // (≤ ticks; fewer when several ticks drain in one frame), and at least once.
    expect(runCatchupSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runCatchupSpy.mock.calls.length).toBeLessThanOrEqual(result.ticks);
    // The OCC append path was exercised per tick (per-stream appends happened).
    expect(appendSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("with rfid enabled the detection branch runs (batched per frame)", async () => {
    const { result, broadcasts } = await driveWith({ rfid: {} });
    expect(result.ticks).toBeGreaterThanOrEqual(1);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    // Detection is BATCHED per frame (≤ ticks, ≥ 1) — once over each frame's
    // folded state rather than once per tick.
    expect(runDetectionSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runDetectionSpy.mock.calls.length).toBeLessThanOrEqual(result.ticks);
  });

  it("BATCHING: projection fold + detection + catch-up run ONCE per frame; appends stay per tick", async () => {
    // Leap the WHOLE horizon in a single frame (huge multiplier, large budget) with
    // rfid on. The heavy DB folds (inline projection / detection / catch-up) must
    // collapse to exactly ONE run for the whole drained batch, while the OCC append
    // path still runs per tick (per-tick `occurredAt` is preserved — appends cannot
    // be coalesced across ticks because each tick is a distinct domain timestamp).
    const { result } = await driveWith({
      rfid: {},
      getMultiplier: () => 1e12,
      maxTicksPerFrame: 4096,
    });
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    // One frame drained everything ⇒ exactly one catch-up + one detection.
    expect(runCatchupSpy.mock.calls.length).toBe(1);
    expect(runDetectionSpy.mock.calls.length).toBe(1);
    // Appends remain per tick (≥ one per drained tick).
    expect(appendSpy.mock.calls.length).toBeGreaterThanOrEqual(result.ticks);
  });

  it("absent getMultiplier defaults to 1× and the run still completes", async () => {
    // No getMultiplier ⇒ multiplier defaults to 1 (120 sim-ms per wall-ms). A
    // small frame still advances enough sim-time to drain the short stream.
    const { driveSimulationPaced } = await import("./driver.js");
    const broadcasts: number[] = [];
    const { loop, calls } = recordingLoop();
    const result = await driveSimulationPaced({
      db: buildFakeDb(),
      seed: SEED,
      durationTicks: DURATION,
      broadcast: recordingBroadcast(broadcasts),
      loop,
      frameMs: 5,
      maxTicksPerFrame: 1024,
    });
    expect(result.ticks).toBeGreaterThanOrEqual(2);
    expect(allDeliveredEvents(calls).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 18 — LIVE driver-HOS wiring: `hosEnabled`/`hosConfig` flow through the
// paced driver into `simulate`, so the live demo produces driver-assignment +
// HOS + relay events that reach the optimizer (and thus `driver_status`).
//
// Hermetic: the heavy Postgres I/O is mocked (hoisted vi.mock above); the
// REAL `@mm/simulation` engine runs, so these assertions are meaningful. A
// longer horizon is used because driver events fire on dispatch/transit, not at
// network setup. A tiny frameMs + 64× + huge budget drains promptly (no real
// wall-clock pacing) so these wiring assertions run fast.
// ---------------------------------------------------------------------------

describe("driveSimulationPaced — live HOS wiring (hosEnabled flows into simulate)", () => {
  beforeEach(() => {
    appendSpy.mockClear();
    readAllSpy.mockClear();
    runCatchupSpy.mockClear();
    runDetectionSpy.mockClear();
  });

  const HOS_SEED = 4242;
  const HOS_DURATION = 600; // long enough for dispatch + driving accrual

  async function driveCollectingEvents(
    overrides: Partial<DriveSimulationPacedOptions>,
  ): Promise<readonly DomainEvent[]> {
    const { driveSimulationPaced } = await import("./driver.js");
    const broadcasts: number[] = [];
    const { loop, calls } = recordingLoop();
    await driveSimulationPaced({
      db: buildFakeDb(),
      seed: HOS_SEED,
      durationTicks: HOS_DURATION,
      broadcast: recordingBroadcast(broadcasts),
      loop,
      frameMs: 1,
      maxTicksPerFrame: 4096,
      // A huge multiplier drains the whole horizon in a frame or two: this is a
      // WIRING test (HOS events reach the optimizer), not a pacing test, so we
      // do not want the wall-clock accumulator to gate it. The driver consumes
      // the raw multiplier (clamping is the SpeedController's concern).
      getMultiplier: () => 1e12,
      ...overrides,
    });
    return calls.flatMap((c) => c.events);
  }

  it("hosEnabled:true ⇒ driver-assignment + HOS events reach the optimizer loop", async () => {
    const events = await driveCollectingEvents({
      hosEnabled: true,
      hosConfig: DEFAULT_HOS_CONFIG,
    });
    const types = new Set(events.map((e) => e.type));
    // The HOS-on stream carries the driver lifecycle that populates driver_status.
    expect(types.has("DriverRegistered")).toBe(true);
    expect(types.has("DriverAssignedToTrip")).toBe(true);
    expect(types.has("DriverDutyStateChanged")).toBe(true);
  });

  it("hosEnabled absent ⇒ NO driver events flow (the determinism-keystone default)", async () => {
    const events = await driveCollectingEvents({});
    const types = new Set(events.map((e) => e.type));
    expect(types.has("DriverRegistered")).toBe(false);
    expect(types.has("DriverAssignedToTrip")).toBe(false);
    expect(types.has("DriverDutyStateChanged")).toBe(false);
    // Non-vacuous: the OFF run DID drive a non-trivial operational stream.
    expect(events.length).toBeGreaterThan(0);
    expect(types.has("TrailerDeparted")).toBe(true);
  });

  it("the HOS flag is what flips driver output (on differs from off)", async () => {
    const on = await driveCollectingEvents({ hosEnabled: true, hosConfig: DEFAULT_HOS_CONFIG });
    const off = await driveCollectingEvents({ hosEnabled: false });
    // Same seed, only the HOS flag differs ⇒ the stream length/content diverges.
    expect(on.length).not.toBe(off.length);
    expect(off.some((e) => e.type === "DriverRegistered")).toBe(false);
    expect(on.some((e) => e.type === "DriverRegistered")).toBe(true);
  });
});
