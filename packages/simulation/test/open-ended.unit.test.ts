import { describe, expect, it } from "vitest";
import { simulate, type SimulatedEvent } from "../src/engine.js";

/**
 * Phase 19 CONT-01/02/DET-01 — open-ended engine tests.
 *
 * Covers the `runUntilStopped` + streaming `onEvent` + cooperative `stop`
 * surface (plan-02), plus two verifications of already-correct behaviour:
 *   - the flags-off finite path is byte-identical (DET-01 regression baseline),
 *   - the `EventQueue` same-tick tie-break is deterministic (VQ#2 verification).
 */

// A small horizon — long enough that several package batches and a couple of
// departures fire, short enough to keep the open-ended assertions cheap.
const SHORT_OPTS = { seed: 42, durationTicks: 500 } as const;

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
    const b = simulate({ ...SHORT_OPTS, runUntilStopped: false });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("runUntilStopped: true with an onEvent stop-after-N callback terminates the loop", () => {
    const collected: SimulatedEvent[] = [];
    const CAP = 200;
    let stopped = false;
    simulate({
      seed: 42,
      durationTicks: 100,
      runUntilStopped: true,
      onEvent: (ev) => {
        if (stopped) return;
        collected.push(ev);
        if (collected.length >= CAP) stopped = true;
      },
      stop: () => stopped,
    });
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
    // Drive a clock-bound stop: flip `stopped` once an event past 3× the
    // original horizon is observed (proves generation continued past the ceiling).
    simulate({
      seed: 42,
      durationTicks: original,
      runUntilStopped: true,
      onEvent: (ev) => {
        if (stopped) return;
        collected.push(ev);
        if (maxTick([ev]) > STOP_TICK) stopped = true;
      },
      stop: () => stopped,
    });
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
    simulate({
      seed: 42,
      durationTicks: original,
      runUntilStopped: true,
      onEvent: (ev) => {
        if (stopped) return;
        collected.push(ev);
        if (maxTick([ev]) > STOP_TICK) stopped = true;
      },
      stop: () => stopped,
    });
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

/**
 * CONT-05 (P2) — sort-wave burst-quiet-burst departure cadence.
 *
 * Flag-gated: absent ⇒ byte-identical to the steady-trickle stream (DET-01); when
 * present, freight is created ONLY inside the burst window (PackageCreated events
 * cluster), not during the quiet window.
 */
describe("sort-wave cadence (CONT-05, P2)", () => {
  const BASE = { seed: 42, durationTicks: 300 } as const;
  const WAVE = {
    burstWindowTicks: 10,
    quietWindowTicks: 30,
    burstPackagesPerBatch: 5,
  } as const;
  const PERIOD = WAVE.burstWindowTicks + WAVE.quietWindowTicks;

  it("sortWave absent is byte-identical to the steady-trickle stream (DET-01)", () => {
    const off = simulate(BASE);
    const offExplicit = simulate({ ...BASE });
    expect(JSON.stringify(offExplicit)).toBe(JSON.stringify(off));
  });

  it("sortWave ON produces a different, non-empty stream", () => {
    const off = simulate(BASE);
    const on = simulate({ ...BASE, sortWave: WAVE });
    expect(on.length).toBeGreaterThan(0);
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
  });

  it("PackageCreated events fall ONLY inside burst windows (cycle < burstWindowTicks)", () => {
    const on = simulate({ ...BASE, sortWave: WAVE });
    const createdTicks = on
      .filter((e) => e.event.type === "PackageCreated")
      .map((e) => maxTick([e]));
    expect(createdTicks.length).toBeGreaterThan(0);
    for (const tick of createdTicks) {
      // Package batches fire at multiples of the package interval; every one that
      // produced a PackageCreated must be inside the burst window of its cycle.
      expect(tick % PERIOD).toBeLessThan(WAVE.burstWindowTicks);
    }
    // And the run is deterministic with the flag on.
    const again = simulate({ ...BASE, sortWave: WAVE });
    expect(JSON.stringify(again)).toBe(JSON.stringify(on));
  });
});
