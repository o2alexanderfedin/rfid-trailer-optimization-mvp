import { describe, expect, it } from "vitest";
import { simulate, type SimulateOptions, type SimulatedEvent } from "../src/engine.js";

/**
 * Phase 19 CONT-01/02/DET-01 — open-ended engine tests.
 *
 * Wave 0 stubs: some of these are RED until plan-02 implements `runUntilStopped`
 * + the streaming `onEvent` callback on `SimulateOptions`. Three of them verify
 * already-correct behaviour and PASS immediately:
 *   - the flags-off finite path is byte-identical (DET-01 regression baseline),
 *   - the `EventQueue` same-tick tie-break is deterministic (VQ#2 verification).
 *
 * The `runUntilStopped`-flag tests are cast through a widened option type so the
 * file COMPILES before plan-02 lands; they fail at RUNTIME (the flag has no
 * effect yet) rather than at the TypeScript boundary — the intended RED signal.
 */

// A small horizon — long enough that several package batches and a couple of
// departures fire, short enough to keep the open-ended assertions cheap.
const SHORT_OPTS = { seed: 42, durationTicks: 500 } as const;

/**
 * Widen `SimulateOptions` with the Phase-19 fields plan-02 adds so the stub file
 * type-checks today. Once plan-02 lands these become real fields and the cast is
 * a no-op (still type-safe).
 */
type OpenEndedOptions = SimulateOptions & {
  readonly runUntilStopped?: boolean;
  readonly onEvent?: (event: SimulatedEvent) => void;
};

/** Highest tick (occurredAt minutes since epoch) present in a stream. */
function maxTick(stream: readonly SimulatedEvent[]): number {
  const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z");
  const MS_PER_TICK = 60_000;
  let max = 0;
  for (const item of stream) {
    const tick = Math.round((Date.parse(item.occurredAt) - EPOCH_MS) / MS_PER_TICK);
    if (tick > max) max = tick;
  }
  return max;
}

describe("open-ended loop (CONT-01)", () => {
  it("runUntilStopped: false with finite durationTicks produces same stream as simulate() (DET-01 regression)", () => {
    const a = simulate(SHORT_OPTS);
    const b = simulate({ ...SHORT_OPTS, runUntilStopped: false } as OpenEndedOptions);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("runUntilStopped: true with an onEvent stop-after-N callback terminates the loop", () => {
    // RED until plan-02: with the flag unimplemented, the engine ignores
    // runUntilStopped + onEvent and accumulates into out[] (finite path), so the
    // collected count will be the finite-stream length, not the capped N.
    const collected: SimulatedEvent[] = [];
    const CAP = 200;
    let stopped = false;
    const opts: OpenEndedOptions = {
      seed: 42,
      durationTicks: 100,
      runUntilStopped: true,
      onEvent: (ev) => {
        if (stopped) return;
        collected.push(ev);
        if (collected.length >= CAP) stopped = true;
      },
      stop: () => stopped,
    } as OpenEndedOptions & { stop?: () => boolean };
    simulate(opts);
    // The onEvent path must have received events (streaming) and the loop must
    // have honoured the stop signal — terminating at/near the cap, NOT running
    // the (much larger) finite stream into out[].
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.length).toBeLessThanOrEqual(CAP + 50);
  });
});

describe("self-rescheduling past durationTicks (CONT-02)", () => {
  it("createPackageBatch re-schedules beyond original durationTicks in open-ended mode", () => {
    const original = 200;
    const collected: SimulatedEvent[] = [];
    let stopped = false;
    const STOP_TICK = original * 3;
    const opts = {
      seed: 42,
      durationTicks: original,
      runUntilStopped: true,
      onEvent: (ev: SimulatedEvent) => {
        if (stopped) return;
        collected.push(ev);
      },
      stop: () => stopped,
    } as OpenEndedOptions & { stop?: () => boolean };
    // Drive a clock-bound stop via a wrapper that flips `stopped` once we observe
    // an event past 3× the original horizon.
    const wrapped = {
      ...opts,
      onEvent: (ev: SimulatedEvent) => {
        if (stopped) return;
        collected.push(ev);
        if (maxTick([ev]) > STOP_TICK) stopped = true;
      },
    } as OpenEndedOptions & { stop?: () => boolean };
    simulate(wrapped);
    // PackageCreated events must exist PAST the original durationTicks ceiling.
    const created = collected.filter((e) => e.event.type === "PackageCreated");
    expect(created.length).toBeGreaterThan(0);
    expect(maxTick(created)).toBeGreaterThan(original);
  });

  it("arriveTrailer schedules next departure past durationTicks in open-ended mode", () => {
    const original = 200;
    const collected: SimulatedEvent[] = [];
    let stopped = false;
    const STOP_TICK = original * 6;
    const opts = {
      seed: 42,
      durationTicks: original,
      runUntilStopped: true,
      onEvent: (ev: SimulatedEvent) => {
        if (stopped) return;
        collected.push(ev);
        if (maxTick([ev]) > STOP_TICK) stopped = true;
      },
      stop: () => stopped,
    } as OpenEndedOptions & { stop?: () => boolean };
    simulate(opts);
    const departed = collected.filter((e) => e.event.type === "TrailerDeparted");
    // At least one departure must occur PAST the original durationTicks ceiling —
    // proving arriveTrailer keeps self-scheduling in open-ended mode.
    expect(departed.length).toBeGreaterThan(0);
    expect(maxTick(departed)).toBeGreaterThan(original);
  });
});

describe("EventQueue same-tick tie-break determinism (VQ#2 verification)", () => {
  it("two runs with the same seed are byte-identical (same-tick events keep insertion order)", () => {
    const a = simulate({ seed: 42, durationTicks: 1000 });
    const b = simulate({ seed: 42, durationTicks: 1000 });
    // Byte-identity proves that same-fireTick events are ordered by the stable
    // insertion seq (never Map/Set iteration or async order).
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // And there genuinely ARE multiple events sharing a tick (the bootstrap fires
    // all HubRegistered + RouteRegistered at tick 0) — so the tie-break matters.
    const tick0 = a.filter((e) => maxTick([e]) === 0);
    expect(tick0.length).toBeGreaterThan(1);
  });
});
