import { describe, expect, it } from "vitest";
import type { FuelConfig } from "@mm/domain";
import { runToHorizon, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";
import { SUGGESTION_TTL_SIM_MS } from "../src/coordinator/index.js";
import { MS_PER_TICK } from "../src/epoch.js";

/**
 * Phase-25 COORD-04 gap-closure — THE SIM-TIME TTL ENFORCEMENT WITNESS (GUARD 3).
 *
 * `isExpired` (the sim-time TTL predicate, Plan 04) was implemented + unit-tested in
 * `coordinator/guards.ts` but had NO call site in the engine: the `stepAgents` drain
 * of `pendingSuggestionsByTarget` consumed EVERY pending suggestion unconditionally,
 * never checking expiry. In the strictly-within-tick handshake (`stepCoordinators`
 * fires one queue-seq before `stepAgents` at a shared tick, so `issuedAtSimMs == now`)
 * a suggestion is never expired — so the gap was latent. But a CROSS-TICK pending
 * suggestion (one restored from a serialized `pendingSuggestionsByTarget` across a
 * chunk boundary, targeting an agent NOT in the issuing tick's roster) could grow
 * arbitrarily stale and STILL be acted on (T-25-17: stale suggestion acted on).
 *
 * This suite is the closing witness: when the drain consumes a pending suggestion
 * whose `issuedAtSimMs + ttlSimMs <= now` (sim-time), it is DROPPED — no
 * `SuggestionAccepted`, no `SuggestionRejected`, no binding event is emitted for it
 * (it self-destructs). A within-TTL pending suggestion is still consumed normally.
 *
 * Method: drive a real coordinator-on chunk to a horizon to obtain a genuine
 * `SimContinuation`, then inject TWO synthetic cross-tick pending suggestions into the
 * restored `pendingSuggestionsByTarget` — one STALE (issued far enough in the past to
 * exceed the TTL at the resume tick) and one FRESH (issued at the resume tick) —
 * targeting a real spoke-hub agent that the next `stepAgents` pass will drain. We then
 * resume and assert the stale one produced NO verdict event while the fresh one did.
 */

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/** The coordinator-on stack (mirrors the golden/continuation-equivalence config). */
const COORD_OPTS = {
  coordinatorsEnabled: true,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

const SEED = 42;
/** A real spoke-hub agent (legacy single-center star: MEM is the center; ORD a spoke). */
const TARGET_AGENT = "ORD";

/** Verdict events (Accepted/Rejected) carrying a given suggestionId, in order. */
function verdictsFor(
  stream: readonly SimulatedEvent[],
  suggestionId: string,
): { accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;
  for (const { event } of stream) {
    if (
      (event.type === "SuggestionAccepted" || event.type === "SuggestionRejected") &&
      event.payload.suggestionId === suggestionId
    ) {
      if (event.type === "SuggestionAccepted") accepted += 1;
      else rejected += 1;
    }
  }
  return { accepted, rejected };
}

/**
 * Resume `base` to `horizon`, injecting `pending` into the restored
 * `pendingSuggestionsByTarget` for {@link TARGET_AGENT}. Returns the resumed stream.
 */
function resumeWithPending(
  base: SimContinuation,
  horizon: number,
  pending: SimContinuation["world"]["pendingSuggestionsByTarget"][number][1],
): SimulatedEvent[] {
  const injected: SimContinuation = {
    ...base,
    world: {
      ...base.world,
      // Replace any (normally-empty) pending map with our synthetic cross-tick entry.
      pendingSuggestionsByTarget: [[TARGET_AGENT, pending]],
    },
  };
  return runToHorizon(injected, horizon, COORD_OPTS).events;
}

describe("sim-time TTL enforcement in the suggestion drain (COORD-04 GUARD 3)", () => {
  // A genuine continuation captured after the coordinator has live state; the resume
  // tick is `nextTick`, so `now = nextTick * MS_PER_TICK` at the next drain.
  const { continuation } = runToHorizon({ seed: SEED }, 800, COORD_OPTS);
  const nowSimMs = continuation.nextTick * MS_PER_TICK;

  // STALE: issued so far in the past that `issuedAtSimMs + ttl <= now` at the resume
  // tick — strictly expired. A `hold` (always-accepted) so the ONLY reason it would
  // produce no verdict is the TTL drop (not a feasibility reject).
  const STALE_ID = "stale-suggestion-xttl";
  const stale = {
    suggestionId: STALE_ID,
    coordinatorId: "MEM",
    targetAgentId: TARGET_AGENT,
    kind: "hold" as const,
    params: {},
    issuedAtSimMs: nowSimMs - SUGGESTION_TTL_SIM_MS - MS_PER_TICK,
    ttlSimMs: SUGGESTION_TTL_SIM_MS,
  };

  // FRESH: issued AT the resume tick — `issuedAtSimMs + ttl > now`, so not expired.
  const FRESH_ID = "fresh-suggestion-within-ttl";
  const fresh = {
    suggestionId: FRESH_ID,
    coordinatorId: "MEM",
    targetAgentId: TARGET_AGENT,
    kind: "hold" as const,
    params: {},
    issuedAtSimMs: nowSimMs,
    ttlSimMs: SUGGESTION_TTL_SIM_MS,
  };

  it("a cross-tick EXPIRED pending suggestion is DROPPED (no Accepted/Rejected verdict)", () => {
    // Resume one tick past `nextTick` so the next stepAgents pass drains the pending
    // map at a tick where the stale suggestion is strictly expired.
    const stream = resumeWithPending(continuation, continuation.nextTick + 10, [stale]);
    const v = verdictsFor(stream, STALE_ID);
    expect(v.accepted).toBe(0);
    expect(v.rejected).toBe(0);
  });

  it("a within-TTL pending suggestion is STILL consumed (a hold is accepted)", () => {
    const stream = resumeWithPending(continuation, continuation.nextTick + 10, [fresh]);
    const v = verdictsFor(stream, FRESH_ID);
    // A `hold` is always feasible (COORD-05), so a non-expired one is ACCEPTED.
    expect(v.accepted).toBe(1);
    expect(v.rejected).toBe(0);
  });

  it("mixed: the expired one drops, the fresh one is consumed in the SAME drain", () => {
    const stream = resumeWithPending(continuation, continuation.nextTick + 10, [stale, fresh]);
    const staleV = verdictsFor(stream, STALE_ID);
    const freshV = verdictsFor(stream, FRESH_ID);
    expect(staleV.accepted).toBe(0);
    expect(staleV.rejected).toBe(0);
    expect(freshV.accepted).toBe(1);
    expect(freshV.rejected).toBe(0);
  });
});
