import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * SIM-02 — THE DETERMINISM KEYSTONE.
 *
 * The pure generator `simulate({ seed, durationTicks })` returns a
 * `SimulatedEvent[]` with NO database and NO wall-clock/RNG ambient state. Two
 * runs with the same seed MUST be byte-identical (order, payloads, occurredAt);
 * a different seed MUST differ. Every emitted event must pass the domain
 * `validateEvent` boundary, and timestamps must be non-decreasing.
 */

// TIME-01: transit medians are now per-leg, derived from real great-circle
// distance (≈400 min for the shortest spoke leg, ≈2250 min for the longest), so
// the horizon must be long enough for trailers to actually ARRIVE and re-dispatch
// — a 240-tick (4-hour) run no longer completes even the shortest leg.
const OPTS = { seed: 1234, durationTicks: 6000 } as const;

describe("deterministic event stream (SIM-02)", () => {
  it("same seed -> byte-identical stream (deep-equal incl. order + occurredAt)", () => {
    const a = simulate(OPTS);
    const b = simulate({ ...OPTS });
    expect(b).toEqual(a);
    // And byte-identical when JSON-serialized (the literal "byte" assertion).
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("different seed -> different stream", () => {
    const a = simulate({ seed: 1, durationTicks: 240 });
    const b = simulate({ seed: 2, durationTicks: 240 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits a non-trivial number of events", () => {
    const events = simulate(OPTS);
    expect(events.length).toBeGreaterThan(50);
  });

  it("every emitted event passes the domain validateEvent boundary", () => {
    for (const item of simulate(OPTS)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("opens with HubRegistered + RouteRegistered bootstrap, then operational events", () => {
    const events = simulate(OPTS);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("HubRegistered");
    expect(types).toContain("RouteRegistered");
    expect(types).toContain("PackageCreated");
    expect(types).toContain("PackageScanned");
    expect(types).toContain("PackageArrivedAtHub");
    expect(types).toContain("TrailerDeparted");
    expect(types).toContain("TrailerArrivedAtHub");
    expect(types).toContain("TrailerDocked");

    // All 10 hubs + all routes are registered before any operational event.
    const firstOperational = types.findIndex(
      (t) => t !== "HubRegistered" && t !== "RouteRegistered",
    );
    const bootstrap = types.slice(0, firstOperational);
    expect(bootstrap.filter((t) => t === "HubRegistered").length).toBe(10);
    expect(bootstrap.every((t) => t === "HubRegistered" || t === "RouteRegistered")).toBe(true);
  });

  it("emits events in non-decreasing occurredAt (virtual-clock ordering)", () => {
    const events = simulate(OPTS);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.occurredAt >= events[i - 1]!.occurredAt).toBe(true);
    }
  });

  it("every event has a stream id matching its entity", () => {
    for (const { streamId, event } of simulate(OPTS)) {
      expect(streamId.length).toBeGreaterThan(0);
      switch (event.type) {
        case "HubRegistered":
          expect(streamId).toBe(`hub-${event.payload.hubId}`);
          break;
        case "RouteRegistered":
          expect(streamId).toBe(`route-${event.payload.routeId}`);
          break;
        case "PackageCreated":
        case "PackageScanned":
        case "PackageArrivedAtHub":
          expect(streamId).toBe(`package-${event.payload.packageId}`);
          break;
        case "TrailerDeparted":
        case "TrailerArrivedAtHub":
        case "TrailerDocked":
          expect(streamId).toBe(`trailer-${event.payload.trailerId}`);
          break;
      }
    }
  });

  it("occurredAt comes from the virtual clock (valid ISO, never the wall clock)", () => {
    for (const { occurredAt } of simulate(OPTS)) {
      expect(occurredAt).toBe(new Date(occurredAt).toISOString());
    }
  });
});

/**
 * DET-02 — the LONG-RUN determinism golden.
 *
 * A 10,000-tick seeded run (seed 42) must hash to a committed SHA-256 constant —
 * a stronger guarantee than the same-run reproducibility above: it asserts the
 * stream is byte-stable across builds (and, where CI is multi-arch, across
 * architectures). The committed hash is the TRUE output of
 * `simulate({ seed: 42, durationTicks: 10000 })`.
 *
 * Cross-architecture note (RESEARCH VQ#9 / Pitfall 3): `sampleLogNormal` uses
 * `Math.exp`/`Math.log`, which are implementation-defined and could diverge by
 * 1 ULP after thousands of iterations. The hash below was captured on x86_64
 * (darwin). If a multi-arch CI run produces a different hash, the contingency is
 * to replace the log-normal sampler with an integer lookup table (do NOT do this
 * unless the hash actually fails on CI).
 */
// Captured from simulate({ seed: 42, durationTicks: 10000 }) on x86_64 (darwin),
// 6172 events. This is the TRUE hash of the long-run stream (plan-03 GREEN).
const LONG_RUN_GOLDEN_SHA256 =
  "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861";

describe("10k-tick determinism golden (DET-02)", () => {
  it("simulate({ seed: 42, durationTicks: 10000 }) produces a committed SHA-256 hash", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(LONG_RUN_GOLDEN_SHA256);
  });

  // Plan 19-08 Task D (folded from p19-r2): in-process reproducibility — two
  // back-to-back 10k runs in the SAME process MUST hash identically. This would
  // catch any phantom module-global / cache that leaks between runs (the engine
  // now routes through the resumable continuation core, so this guards that the
  // core holds NO process-level state).
  it("the 10k-tick run is reproducible within a process (same hash twice)", () => {
    const a = createHash("sha256")
      .update(JSON.stringify(simulate({ seed: 42, durationTicks: 10000 })))
      .digest("hex");
    const b = createHash("sha256")
      .update(JSON.stringify(simulate({ seed: 42, durationTicks: 10000 })))
      .digest("hex");
    expect(b).toBe(a);
    expect(a).toBe(LONG_RUN_GOLDEN_SHA256);
  });
});

/**
 * Plan 19-08 Task D — explicit same-tick TIE-BREAK TUPLE assertion (folded from
 * p19-r2). The consult requires a deterministic same-timestamp order via a stable
 * secondary key. The engine orders the EventQueue by `(fireTick, insertionSeq)`,
 * so events sharing an `occurredAt` are emitted in a stable, reproducible order.
 * We assert the FULL ordered `(occurredAt | type | streamId)` tuple sequence is
 * byte-identical across two runs — a direct witness that the tie-break is total
 * and stable (never Map/Set iteration or async order).
 */
describe("same-tick tie-break tuple is deterministic (Task D)", () => {
  const TIE_OPTS = { seed: 1234, durationTicks: 4000 } as const;

  function tupleSeq(stream: ReturnType<typeof simulate>): string[] {
    return stream.map((e) => `${e.occurredAt}|${e.event.type}|${e.streamId}`);
  }

  it("the ordered (occurredAt|type|streamId) tuple sequence is byte-identical across runs", () => {
    const a = tupleSeq(simulate(TIE_OPTS));
    const b = tupleSeq(simulate({ ...TIE_OPTS }));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("there genuinely ARE multiple events sharing a tick (the tie-break matters)", () => {
    const stream = simulate(TIE_OPTS);
    // Group by occurredAt; at least one instant carries > 1 event (the bootstrap
    // fires all HubRegistered + RouteRegistered at the epoch instant).
    const byInstant = new Map<string, number>();
    for (const e of stream) byInstant.set(e.occurredAt, (byInstant.get(e.occurredAt) ?? 0) + 1);
    const maxPerInstant = Math.max(...byInstant.values());
    expect(maxPerInstant).toBeGreaterThan(1);
  });
});

/**
 * DET-01 — the v2.0 flags-off regression gate.
 *
 * With NO v2.0 flags set, the same-seed/same-ticks run must stay byte-identical.
 * This is trivially true today and MUST remain true after plan-02 adds
 * `runUntilStopped`/`onEvent` — proving those opt-in flags never perturb the
 * finite path when absent or explicitly `false`.
 */
describe("DET-01 flags-off gate (v2.0 regression)", () => {
  const FLAGS_OFF_OPTS = { seed: 42, durationTicks: 500 } as const;

  it("no flags — same-seed run is byte-identical", () => {
    const a = simulate(FLAGS_OFF_OPTS);
    const b = simulate({ ...FLAGS_OFF_OPTS });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("explicit runUntilStopped: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({ ...FLAGS_OFF_OPTS, runUntilStopped: false });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });
});
