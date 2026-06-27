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
const acceptedOf = (stream: Stream) =>
  stream.filter((e) => e.event.type === "SuggestionAccepted");
const rejectedOf = (stream: Stream) =>
  stream.filter((e) => e.event.type === "SuggestionRejected");

const CLOSED_REASON_CODES = new Set(["hos", "fuel", "dock", "infeasible"]);

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

describe("stepAgents same-tick accept/reject handshake (COORD-02 consume / COORD-03)", () => {
  const stream = simulate(ALL_ON);
  const suggestions = suggestionsOf(stream);
  const accepted = acceptedOf(stream);
  const rejected = rejectedOf(stream);

  it("consumes EVERY ActionSuggested in the same tick: accepted + rejected === suggested", () => {
    // The handshake drains pendingSuggestionsByTarget every coordinator-on tick —
    // no suggestion is ever left unconsumed (the within-tick lifecycle).
    expect(suggestions.length).toBeGreaterThan(50);
    expect(accepted.length + rejected.length).toBe(suggestions.length);
  });

  it("emits a NON-TRIVIAL mix of SuggestionAccepted AND SuggestionRejected", () => {
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("every SuggestionRejected carries a CLOSED reasonCode (hos|fuel|dock|infeasible)", () => {
    for (const r of rejected) {
      if (r.event.type !== "SuggestionRejected") continue;
      expect(CLOSED_REASON_CODES.has(r.event.payload.reasonCode)).toBe(true);
    }
  });

  it("every accept/reject is validated by the domain boundary + streamed on the TARGET's own stream", () => {
    for (const e of [...accepted, ...rejected]) {
      expect(() => validateEvent(e.event)).not.toThrow();
      // The agent (trailer-<id> / hub-<id>) is the author of record — never the
      // coordinator (the un-overridable contract: the agent decides).
      expect(
        e.streamId.startsWith("trailer-") || e.streamId.startsWith("hub-"),
      ).toBe(true);
    }
  });

  it("correlates each accept/reject to a real ActionSuggested via suggestionId", () => {
    const suggestedIds = new Set(
      suggestions.flatMap((s) =>
        s.event.type === "ActionSuggested" ? [s.event.payload.suggestionId] : [],
      ),
    );
    for (const e of [...accepted, ...rejected]) {
      if (e.event.type === "SuggestionAccepted" || e.event.type === "SuggestionRejected") {
        expect(suggestedIds.has(e.event.payload.suggestionId)).toBe(true);
      }
    }
    // And every suggestionId is resolved exactly once (no double-consume).
    const resolved = [...accepted, ...rejected].flatMap((e) =>
      e.event.type === "SuggestionAccepted" || e.event.type === "SuggestionRejected"
        ? [e.event.payload.suggestionId]
        : [],
    );
    expect(new Set(resolved).size).toBe(resolved.length);
  });

  it("NEVER double-emits: at most ONE TrailerDiverted per (trailer, instant)", () => {
    // An accepted reroute's binding TrailerDiverted REPLACES the autonomous Act that
    // tick (deterministic precedence, T-25-12) — so a trailer never diverts twice in
    // the same virtual instant.
    const perInstant = new Map<string, number>();
    for (const e of stream) {
      if (e.event.type !== "TrailerDiverted") continue;
      const key = `${e.event.payload.trailerId}|${e.event.payload.occurredAt}`;
      perInstant.set(key, (perInstant.get(key) ?? 0) + 1);
    }
    for (const count of perInstant.values()) expect(count).toBeLessThanOrEqual(1);
  });

  it("same seed ⇒ byte-identical accept/reject stream (the handshake is reproducible)", () => {
    const a = JSON.stringify(simulate(ALL_ON));
    const b = JSON.stringify(simulate(ALL_ON));
    expect(b).toBe(a);
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
