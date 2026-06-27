import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * Phase-25 COORD-01/COORD-02 — the in-fold `stepCoordinators` pass (engine wiring).
 *
 * With `coordinatorsEnabled` ON, one coordinator per regional center runs in-fold
 * as a self-rescheduling task, sorted by centerId, over a BOUNDED per-center scope,
 * generating rule-based `ActionSuggested` for all four kinds. These integration
 * tests pin: a non-trivial count across all 4 kinds, same-seed byte-identity,
 * deterministic collision-free suggestionIds, the bounded per-center scope (no two
 * coordinators name the same spoke), and the two-part flags-off gate (false ===
 * absent AND absent ⇒ the seed-42 10k golden 3920accc…).
 *
 * The reroute rule reads a truck's NEXT hub, which is populated in
 * `activeTripByTrailer` only on the OODA-on path — so the "all four kinds" config
 * runs the natural all-on demo stack (coordinators + consolidation + induction +
 * OODA agents) over the legacy single-center star.
 */

const ALL_ON = {
  seed: 42,
  durationTicks: 6000,
  coordinatorsEnabled: true,
  consolidationEnabled: true,
  inductionEnabled: true,
  oodaAgentsEnabled: true,
} as const;

type Stream = ReturnType<typeof simulate>;

const suggestionsOf = (stream: Stream) =>
  stream.filter((e) => e.event.type === "ActionSuggested");

describe("stepCoordinators emits rule-based ActionSuggested (COORD-01/02)", () => {
  const stream = simulate(ALL_ON);
  const suggestions = suggestionsOf(stream);

  it("emits a non-trivial number of ActionSuggested events", () => {
    expect(suggestions.length).toBeGreaterThan(50);
  });

  it("generates ALL FOUR suggestion kinds (reroute / hold / consolidate / dispatch)", () => {
    const kinds = new Set(
      suggestions.map((s) =>
        s.event.type === "ActionSuggested" ? s.event.payload.kind : "",
      ),
    );
    expect(kinds.has("reroute")).toBe(true);
    expect(kinds.has("hold")).toBe(true);
    expect(kinds.has("consolidate")).toBe(true);
    expect(kinds.has("dispatch")).toBe(true);
  });

  it("every ActionSuggested passes the domain validateEvent boundary", () => {
    for (const s of suggestions) {
      expect(() => validateEvent(s.event)).not.toThrow();
    }
  });

  it("is streamed on coordinator-<coordinatorId> with a deterministic, collision-free suggestionId", () => {
    const ids: string[] = [];
    for (const s of suggestions) {
      if (s.event.type !== "ActionSuggested") continue;
      expect(s.streamId).toBe(`coordinator-${s.event.payload.coordinatorId}`);
      ids.push(s.event.payload.suggestionId);
    }
    // No duplicate suggestionId across the whole run (collision-free).
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stamps a positive sim-time TTL and a non-negative issuedAtSimMs (COORD-04 substrate)", () => {
    for (const s of suggestions) {
      if (s.event.type !== "ActionSuggested") continue;
      expect(s.event.payload.ttlSimMs).toBeGreaterThan(0);
      expect(s.event.payload.issuedAtSimMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.event.payload.issuedAtSimMs)).toBe(true);
    }
  });
});

describe("stepCoordinators is reproducible + bounded per center (COORD-01)", () => {
  it("same seed ⇒ byte-identical stream (reproducible)", () => {
    const a = JSON.stringify(simulate(ALL_ON));
    const b = JSON.stringify(simulate(ALL_ON));
    expect(b).toBe(a);
  });

  it("bounded per-center scope: no two coordinators ever name the same SPOKE target", () => {
    // The scaling/anti-conflict thesis: each coordinator advises ONLY its own
    // center's spokes, so a spoke (a hub-id target) is owned by exactly ONE
    // coordinator across the whole run. (Trailer targets are skipped — a truck can
    // legitimately be re-advised after it crosses into another region's scope.)
    const owner = new Map<string, string>();
    const stream = simulate({
      ...ALL_ON,
      continentalTopology: true,
      durationTicks: 8000,
    });
    for (const s of suggestionsOf(stream)) {
      if (s.event.type !== "ActionSuggested") continue;
      const target = s.event.payload.targetAgentId;
      const coordinator = s.event.payload.coordinatorId;
      if (target.startsWith("T")) continue; // trailer target — not a fixed-scope spoke
      const prev = owner.get(target);
      if (prev !== undefined) expect(prev).toBe(coordinator);
      else owner.set(target, coordinator);
    }
    // Sanity: at least one spoke target was actually advised.
    expect(owner.size).toBeGreaterThan(0);
  });

  it("a coordinator only names spokes that exist as hub ids in the run", () => {
    const stream = simulate(ALL_ON);
    const hubIds = new Set(
      stream
        .filter((e) => e.event.type === "HubRegistered")
        .map((e) =>
          e.event.type === "HubRegistered" ? e.event.payload.hubId : "",
        ),
    );
    for (const s of suggestionsOf(stream)) {
      if (s.event.type !== "ActionSuggested") continue;
      const target = s.event.payload.targetAgentId;
      if (target.startsWith("T")) continue; // trailer target
      expect(hubIds.has(target)).toBe(true);
    }
  });
});

describe("COORD-01 two-part flags-off gate (coordinatorsEnabled)", () => {
  const FLAGS_OFF_OPTS = { seed: 42, durationTicks: 500 } as const;
  const GOLDEN =
    "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861";

  // (a) explicit false === absent over a short run.
  it("explicit coordinatorsEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF_OPTS);
    const explicitFalse = simulate({
      ...FLAGS_OFF_OPTS,
      coordinatorsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  // (b) flag ABSENT ⇒ the seed-42 10k golden is byte-identical to 3920accc… .
  it("coordinatorsEnabled ABSENT is byte-identical to the seed-42 10k golden (DET-01)", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(GOLDEN);
  });

  // ...and the EXPLICIT false 10k-tick run is byte-identical to absent (no
  // coordinator task scheduled, no substream constructed, no ActionSuggested).
  it("coordinatorsEnabled: false is byte-identical to absent over the 10k golden run", () => {
    const absent = simulate({ seed: 42, durationTicks: 10000 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 10000,
      coordinatorsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
    // And no ActionSuggested ever appears when off.
    expect(suggestionsOf(explicitFalse).length).toBe(0);
  });
});
