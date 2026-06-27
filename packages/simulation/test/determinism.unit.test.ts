import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent, type FuelConfig } from "@mm/domain";
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

  // Phase 21 (FLOW-03): consolidation is OPT-IN and DEFAULT OFF. The off path
  // must add ZERO new behavior — `consolidationEnabled: false` is byte-identical
  // to the flag being absent (the determinism keystone).
  it("explicit consolidationEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      consolidationEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // Phase 22 (OUT-01/OUT-02): outbound delivery is OPT-IN and DEFAULT OFF. The
  // off path must add ZERO new behavior — `outboundDeliveryEnabled: false` is
  // byte-identical to the flag being absent (the determinism keystone).
  it("explicit outboundDeliveryEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      outboundDeliveryEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // The NON-NEGOTIABLE acceptance gate: with outbound delivery absent, the
  // seed-42 10k-tick run still hashes to the committed golden — proving the
  // Phase-22 additions are fully inert when the flag is off.
  it("outboundDeliveryEnabled ABSENT is byte-identical to the seed-42 10k golden (DET-01)", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256")
      .update(JSON.stringify(stream))
      .digest("hex");
    expect(hash).toBe(
      "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861",
    );
  });

  // ...and the EXPLICIT false 10k-tick run is byte-identical to the absent run.
  it("outboundDeliveryEnabled: false is byte-identical to absent over the 10k golden run", () => {
    const absent = simulate({ seed: 42, durationTicks: 10000 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      outboundDeliveryEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // Phase 23 (NET-01/DET-01): the continental multi-center topology is OPT-IN and
  // DEFAULT OFF. The two-part flags-off gate (mirrors the outboundDelivery case):
  //   (a) `continentalTopology: false` is byte-identical to the flag being absent,
  //   (b) the flag ABSENT => the seed-42 10k golden is still 3920accc... .
  // This is the keystone witness that the whole Phase-23 generalization preserved
  // byte-identical legacy replay (the seed-42 stream never moved).

  // (a) explicit false === absent over a short run.
  it("explicit continentalTopology: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      continentalTopology: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // (b) flag ABSENT => the seed-42 10k golden is byte-identical to 3920accc... .
  it("continentalTopology ABSENT is byte-identical to the seed-42 10k golden (DET-01)", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(
      "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861",
    );
  });

  // ...and the EXPLICIT false 10k-tick continental run is byte-identical to absent.
  it("continentalTopology: false is byte-identical to absent over the 10k golden run", () => {
    const absent = simulate({ seed: 42, durationTicks: 10000 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      continentalTopology: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // Phase 24 (OODA-01/02/DET-01): the decentralized agent decision core is OPT-IN
  // and DEFAULT OFF. The two-part flags-off gate (mirrors the continental case):
  //   (a) `oodaAgentsEnabled: false` is byte-identical to the flag being absent,
  //   (b) the flag ABSENT => the seed-42 10k golden is still 3920accc… .
  // This is the keystone witness that wiring the `stepAgents` SimTask + the flag +
  // the centralized-decision bypass preserved byte-identical legacy replay (the
  // seed-42 stream never moved).

  // (a) explicit false === absent over a short run.
  it("explicit oodaAgentsEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      oodaAgentsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // (b) flag ABSENT => the seed-42 10k golden is byte-identical to 3920accc… .
  it("oodaAgentsEnabled ABSENT is byte-identical to the seed-42 10k golden (DET-01)", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(
      "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861",
    );
  });

  // ...and the EXPLICIT false 10k-tick OODA run is byte-identical to absent.
  it("oodaAgentsEnabled: false is byte-identical to absent over the 10k golden run", () => {
    const absent = simulate({ seed: 42, durationTicks: 10000 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      oodaAgentsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // Phase 25 (COORD-01/04/DET-01): the advisory coordination-center process manager
  // is OPT-IN and DEFAULT OFF. The two-part flags-off gate (mirrors the OODA case),
  // CONSOLIDATED here in the canonical DET-01 gate file (it is also asserted in
  // coordinator-engine.unit.test.ts; this is the keystone confirmation):
  //   (a) `coordinatorsEnabled: false` is byte-identical to the flag being absent,
  //   (b) the flag ABSENT => the seed-42 10k golden is still 3920accc… ,
  //   (c) the EXPLICIT false 10k run is byte-identical to absent.
  // This witnesses that wiring the `stepCoordinators` SimTask + the five guards + the
  // same-tick handshake + the serialized guard state (25-05) preserved byte-identical
  // legacy replay (the seed-42 stream never moved).

  // (a) explicit false === absent over a short run.
  it("explicit coordinatorsEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      coordinatorsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // (b) flag ABSENT => the seed-42 10k golden is byte-identical to 3920accc… .
  it("coordinatorsEnabled ABSENT is byte-identical to the seed-42 10k golden (DET-01)", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(
      "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861",
    );
  });

  // (c) ...and the EXPLICIT false 10k-tick coordinator run is byte-identical to absent.
  it("coordinatorsEnabled: false is byte-identical to absent over the 10k golden run", () => {
    const absent = simulate({ seed: 42, durationTicks: 10000 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      coordinatorsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // Phase 26 (COORD-06/DET-01): the optimizer-backed REROUTE source is OPT-IN behind
  // the SUB-flag `coordinatorUsesOptimizer` (a sub-flag of `coordinatorsEnabled`,
  // DEFAULT OFF). The two-part flags-off gate for a SUB-flag — the keystone witness
  // that the optimizer branch is byte-identically INERT when off:
  //   (a) `coordinatorUsesOptimizer: false` === absent over a short run,
  //   (b) the sub-flag ABSENT but `coordinatorsEnabled` ON (the all-on stack) ⇒ the
  //       seed-42 stream is byte-identical to the PHASE-25 COORDINATOR golden
  //       `edfa5a6d…` (absent ⇒ the rule-based reroute path is untouched),
  //   (c) ALL v3.0 flags absent + explicit-false (incl. `coordinatorUsesOptimizer:
  //       false`) ⇒ the seed-42 10k golden is still `3920accc…` AND the OODA-on golden
  //       `94689f99…` is intact (the master flags-off gate re-asserted),
  //   (d) `coordinatorUsesOptimizer: false` === absent over a 10k all-on run (the
  //       longer false===absent witness).
  // This witnesses that wiring the in-fold `runEpoch` reroute source + the scope-size
  // cap fallback + the global-RollingLoop disable preserved byte-identical replay of
  // BOTH the legacy flags-off stream (3920accc…) AND the Phase-25 coordinator stream
  // (edfa5a6d…) when the sub-flag is off — the sub-flag changes ONLY the reroute SOURCE.

  // The Phase-25 all-on coordinator stack (the EXACT config the coordinator-on golden
  // `edfa5a6d…` was captured over — see coordinator-determinism.unit.test.ts): seed 42,
  // 10k, `coordinatorsEnabled` layered onto the OODA-on flag set (hos + fuel + induction
  // + consolidation + oodaAgentsEnabled). With `coordinatorUsesOptimizer` ABSENT this is
  // the rule-based coordinator path, so it MUST still hash to `edfa5a6d…`.
  const FUEL_ON: FuelConfig = {
    enabled: true,
    refuelThresholdMiles: 1200,
    milesPerGallon: 6.5,
    tankCapacityGallons: 150,
    refuelTimeMinutes: 30,
  };
  const COORDINATOR_ON_OPTS = {
    seed: 42,
    durationTicks: 10000,
    coordinatorsEnabled: true,
    oodaAgentsEnabled: true,
    hosEnabled: true,
    fuel: FUEL_ON,
    inductionEnabled: true,
    consolidationEnabled: true,
  } as const;
  const COORDINATOR_ON_GOLDEN_SHA256 =
    "edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc";
  const OODA_ON_GOLDEN_SHA256 =
    "94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608";

  // (a) explicit false === absent over a short run.
  it("explicit coordinatorUsesOptimizer: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      coordinatorUsesOptimizer: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // (b) sub-flag ABSENT (coordinators ON, all-on stack) ⇒ the Phase-25 coordinator
  //     golden edfa5a6d… (the rule-based reroute path is byte-identically untouched).
  it("coordinatorUsesOptimizer ABSENT (coordinators on) is byte-identical to the Phase-25 edfa5a6d… golden", () => {
    const stream = simulate(COORDINATOR_ON_OPTS);
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  // ...and the EXPLICIT false all-on run is byte-identical to the sub-flag absent (so
  // an explicit-false re-asserts edfa5a6d… too — false === absent on the all-on stack).
  it("coordinatorUsesOptimizer: false (coordinators on) is byte-identical to absent over the edfa5a6d… golden run", () => {
    const absent = simulate(COORDINATOR_ON_OPTS);
    const explicitFalse = simulate({
      ...COORDINATOR_ON_OPTS,
      coordinatorUsesOptimizer: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
    const hash = createHash("sha256")
      .update(JSON.stringify(explicitFalse))
      .digest("hex");
    expect(hash).toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  // (c) ALL v3.0 flags absent + explicit-false (incl. coordinatorUsesOptimizer:false)
  //     ⇒ the seed-42 10k golden is still 3920accc… (the master flags-off re-assert).
  it("coordinatorUsesOptimizer: false (all flags off) is byte-identical to the seed-42 10k 3920accc… golden", () => {
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      coordinatorUsesOptimizer: false,
    });
    const hash = createHash("sha256")
      .update(JSON.stringify(explicitFalse))
      .digest("hex");
    expect(hash).toBe(
      "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861",
    );
  });

  // (c, OODA arm) the OODA-on golden 94689f99… stays intact alongside the new sub-flag
  //     (its absence perturbs nothing on the OODA-on stack either).
  it("the OODA-on golden 94689f99… is intact with coordinatorUsesOptimizer absent", () => {
    const stream = simulate({
      seed: 42,
      durationTicks: 10000,
      oodaAgentsEnabled: true,
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
    });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(OODA_ON_GOLDEN_SHA256);
  });

  // (d) explicit false === absent over a 10k all-on run (the longer false===absent
  //     witness — the sub-flag is byte-identically inert even over the full golden run).
  it("coordinatorUsesOptimizer: false === absent over a 10k all-on run (longer witness)", () => {
    const absent = simulate(COORDINATOR_ON_OPTS);
    const explicitFalse = simulate({
      ...COORDINATOR_ON_OPTS,
      coordinatorUsesOptimizer: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });
});
