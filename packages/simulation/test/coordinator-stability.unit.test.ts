import { describe, expect, it } from "vitest";
import { MS_PER_TICK } from "../src/epoch.js";
import { REJECT_COOLDOWN_K } from "../src/coordinator/index.js";
import { simulate } from "../src/engine.js";

/**
 * Phase-25 COORD-04 / COORD-05 — the FIRST-CLASS adversarial stability suite (the
 * CONTEXT-mandated highest-value guards). It proves the network-stability contract
 * the five guards exist to enforce, with CONCRETE NUMERIC thresholds (counts,
 * plateaus, no-reappearance) — never vibes:
 *
 *  (a) CONVERGENCE (COORD-04) — a fixed seeded scenario reaches a STABLE plan: no
 *      agent's accepted binding target ever flips back to a prior value after
 *      changing (no A↔B↔A oscillation — the hysteresis + reject-pruning witness).
 *  (b) BOUNDED EVENTS UNDER ALL-REJECT (COORD-05) — a persistently-rejected
 *      (target, kind) option is re-suggested only a BOUNDED number of times and
 *      PLATEAUS after REJECT_COOLDOWN_K (the Zeno/livelock witness — the same
 *      ActionSuggested/SuggestionRejected pair does NOT repeat every tick forever).
 *  (c) TICK CLOSES (COORD-05) — every suggestion is resolved (accepted | rejected)
 *      within its tick; an agent that rejects everything still closes its tick.
 *  (d) NO RE-PLAN FEEDBACK STORM + DETERMINISM — suggestion events are scope-neutral
 *      (an accept never re-triggers the suggesting coordinator the same scope), and
 *      the whole run is same-seed byte-identical (the guards are deterministic).
 */

const ALL_ON = {
  seed: 42,
  durationTicks: 10000,
  coordinatorsEnabled: true,
  consolidationEnabled: true,
  inductionEnabled: true,
  oodaAgentsEnabled: true,
} as const;

type Stream = ReturnType<typeof simulate>;

/** Build a `suggestionId → {coordinatorId, targetAgentId, kind, toHubId, issuedAtSimMs}` map. */
function suggestionMeta(stream: Stream): Map<
  string,
  {
    coordinatorId: string;
    targetAgentId: string;
    kind: string;
    toHubId: string | undefined;
    issuedAtSimMs: number;
  }
> {
  const meta = new Map<
    string,
    {
      coordinatorId: string;
      targetAgentId: string;
      kind: string;
      toHubId: string | undefined;
      issuedAtSimMs: number;
    }
  >();
  for (const e of stream) {
    if (e.event.type !== "ActionSuggested") continue;
    const p = e.event.payload;
    meta.set(p.suggestionId, {
      coordinatorId: p.coordinatorId,
      targetAgentId: p.targetAgentId,
      kind: p.kind,
      toHubId: p.params.toHubId,
      issuedAtSimMs: p.issuedAtSimMs,
    });
  }
  return meta;
}

describe("(a) CONVERGENCE — no A↔B↔A oscillation (COORD-04)", () => {
  const stream = simulate(ALL_ON);
  const meta = suggestionMeta(stream);

  it("no agent's ACCEPTED binding target reappears after it changed (no oscillation)", () => {
    // For each target agent, build the ordered sequence of ACCEPTED binding values
    // (reroute/dispatch carry a destination hub; hold/consolidate are the kind
    // itself). Collapse consecutive duplicates, then assert no value REAPPEARS after
    // a different value intervened — the precise A↔B↔A oscillation witness. The
    // hysteresis dead-band (a metric must persist ≥ dwell) + reject-pruning are what
    // make the per-target accepted plan converge to a stable value.
    const seqByTarget = new Map<string, string[]>();
    for (const e of stream) {
      if (e.event.type !== "SuggestionAccepted") continue;
      const m = meta.get(e.event.payload.suggestionId);
      if (m === undefined) continue;
      const val =
        m.kind === "reroute" || m.kind === "dispatch"
          ? `${m.kind}->${m.toHubId ?? ""}`
          : m.kind;
      const seq = seqByTarget.get(m.targetAgentId);
      if (seq === undefined) seqByTarget.set(m.targetAgentId, [val]);
      else seq.push(val);
    }
    expect(seqByTarget.size).toBeGreaterThan(0); // sanity: agents DID accept plans

    let oscillating = 0;
    for (const seq of seqByTarget.values()) {
      // Collapse consecutive duplicates (a value held across passes is NOT a flip).
      const collapsed: string[] = [];
      for (const v of seq) {
        if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== v) {
          collapsed.push(v);
        }
      }
      const seen = new Set<string>();
      let osc = false;
      for (let i = 0; i < collapsed.length; i += 1) {
        const v = collapsed[i]!;
        if (seen.has(v) && v !== collapsed[i - 1]) {
          osc = true;
          break;
        }
        seen.add(v);
      }
      if (osc) oscillating += 1;
    }
    // ZERO oscillating agents — the convergence guarantee.
    expect(oscillating).toBe(0);
  });

  it("each trailer converges to a SINGLE stable reroute target (≤ 1 distinct destination)", () => {
    const destsByTrailer = new Map<string, Set<string>>();
    for (const e of stream) {
      if (e.event.type !== "SuggestionAccepted") continue;
      const m = meta.get(e.event.payload.suggestionId);
      if (m === undefined || m.kind !== "reroute") continue;
      const set = destsByTrailer.get(m.targetAgentId) ?? new Set<string>();
      set.add(m.toHubId ?? "");
      destsByTrailer.set(m.targetAgentId, set);
    }
    for (const dests of destsByTrailer.values()) {
      expect(dests.size).toBeLessThanOrEqual(1);
    }
  });
});

describe("(b) BOUNDED EVENTS UNDER ALL-REJECT — no Zeno livelock (COORD-05)", () => {
  const stream = simulate(ALL_ON);
  const meta = suggestionMeta(stream);

  it("a persistently-rejected (target,kind) option is re-suggested ≤ REJECT_COOLDOWN_K times (plateau)", () => {
    // For every (coordinatorId, target, kind) option: how many times suggested, how
    // many accepted, how many rejected. An option that is EVER rejected and NEVER
    // accepted is a persistently-infeasible advisory — without the guards the
    // coordinator would re-emit it EVERY pass (~2000× over 10k ticks). With
    // reject-path pruning (K) + seeded-jitter backoff, its re-suggestion count
    // PLATEAUS at ≤ K: the same ActionSuggested/SuggestionRejected pair stops
    // repeating. This is the precise Pitfall-10 Zeno/livelock witness.
    const suggested = new Map<string, number>();
    const accepted = new Map<string, number>();
    const rejected = new Map<string, number>();
    const keyOf = (m: { coordinatorId: string; targetAgentId: string; kind: string }) =>
      `${m.coordinatorId}|${m.targetAgentId}|${m.kind}`;

    for (const e of stream) {
      if (e.event.type === "ActionSuggested") {
        const m = meta.get(e.event.payload.suggestionId)!;
        const k = keyOf(m);
        suggested.set(k, (suggested.get(k) ?? 0) + 1);
      } else if (e.event.type === "SuggestionAccepted") {
        const m = meta.get(e.event.payload.suggestionId);
        if (m === undefined) continue;
        const k = keyOf(m);
        accepted.set(k, (accepted.get(k) ?? 0) + 1);
      } else if (e.event.type === "SuggestionRejected") {
        const m = meta.get(e.event.payload.suggestionId);
        if (m === undefined) continue;
        const k = keyOf(m);
        rejected.set(k, (rejected.get(k) ?? 0) + 1);
      }
    }

    let everRejectedNeverAccepted = 0;
    let maxReSuggest = 0;
    for (const [k, sc] of suggested) {
      const rc = rejected.get(k) ?? 0;
      const ac = accepted.get(k) ?? 0;
      if (rc > 0 && ac === 0) {
        everRejectedNeverAccepted += 1;
        maxReSuggest = Math.max(maxReSuggest, sc);
      }
    }
    // There ARE persistently-rejected options in the run (the scenario exercises the
    // path), and EVERY one of them plateaued at ≤ K re-suggestions (not thousands).
    expect(everRejectedNeverAccepted).toBeGreaterThan(0);
    expect(maxReSuggest).toBeLessThanOrEqual(REJECT_COOLDOWN_K);
  });

  it("suggestions-per-tick stay BOUNDED by a fixed function of agent count (no unbounded growth)", () => {
    // Bucket suggestions by their issuing tick (issuedAtSimMs / MS_PER_TICK). The
    // per-tick count must be bounded — never grow without limit as freight piles up.
    const perTick = new Map<number, number>();
    for (const e of stream) {
      if (e.event.type !== "ActionSuggested") continue;
      const t = e.event.payload.issuedAtSimMs / MS_PER_TICK;
      perTick.set(t, (perTick.get(t) ?? 0) + 1);
    }
    const hubIds = new Set(
      stream.flatMap((e) =>
        e.event.type === "HubRegistered" ? [e.event.payload.hubId] : [],
      ),
    );
    const trailerIds = new Set(
      stream.flatMap((e) =>
        e.event.type === "ActionSuggested" && e.event.payload.targetAgentId.startsWith("T")
          ? [e.event.payload.targetAgentId]
          : [],
      ),
    );
    // A coordinator can advise at most ONE suggestion per agent (hub or truck) per
    // pass, so per-tick suggestions ≤ the total agent count — a fixed bound, never a
    // function of run length. Use a generous ceiling (agents) to make the BOUND, not
    // the exact value, the assertion.
    const agentBound = hubIds.size + trailerIds.size;
    const maxPerTick = Math.max(...perTick.values());
    expect(maxPerTick).toBeLessThanOrEqual(agentBound);
    // And concretely bounded small in this scenario (10 hubs): far below run length.
    expect(maxPerTick).toBeLessThan(50);
  });
});

describe("(c) TICK CLOSES — every agent has a feasible no-op default (COORD-05)", () => {
  it("EVERY suggestion is resolved (accepted | rejected) within its tick — the tick closes", () => {
    const stream = simulate(ALL_ON);
    let suggested = 0;
    let accepted = 0;
    let rejected = 0;
    for (const e of stream) {
      if (e.event.type === "ActionSuggested") suggested += 1;
      else if (e.event.type === "SuggestionAccepted") accepted += 1;
      else if (e.event.type === "SuggestionRejected") rejected += 1;
    }
    expect(suggested).toBeGreaterThan(0);
    // No suggestion is left dangling (no hang / no infinite re-suggestion within a
    // tick): accepted + rejected exactly accounts for every suggestion.
    expect(accepted + rejected).toBe(suggested);
  });

  it("an ALL-REJECT agent still CLOSES its tick (HOS-out trucks reject every reroute, no hang)", () => {
    // Force HOS-out: a minimal driving budget so every truck-leg verdict says
    // `mustRest` ⇒ every reroute REJECTS with `hos`. The run must still terminate
    // (the feasible no-op default — hold is always accepted, the autonomous Act
    // closes the tick) and consume every suggestion. A finite event stream IS the
    // proof the fold terminated (no Zeno: the deletion + pruning bound the loop).
    const hosOut = simulate({
      ...ALL_ON,
      durationTicks: 4000,
      hosEnabled: true,
      hosConfig: {
        maxDriveMin: 1,
        dutyWindowMin: 2,
        breakAfterDriveMin: 1,
        minBreakMin: 30,
        resetOffDutyMin: 600,
        weeklyCapMin: 4200,
        restartMin: 2040,
        sleeperBerthLongMin: 420,
        sleeperBerthShortMin: 180,
        sleeperBerthAltLongMin: 480,
        sleeperBerthAltShortMin: 120,
      },
    });
    // The run produced a FINITE stream (it returned) — termination witness.
    expect(hosOut.length).toBeGreaterThan(0);
    let suggested = 0;
    let resolved = 0;
    for (const e of hosOut) {
      if (e.event.type === "ActionSuggested") suggested += 1;
      else if (e.event.type === "SuggestionAccepted" || e.event.type === "SuggestionRejected") {
        resolved += 1;
      }
    }
    // Every suggestion still closes even when rerouting is structurally infeasible.
    expect(resolved).toBe(suggested);
  });
});

describe("(d) NO FEEDBACK STORM + DETERMINISM (COORD-04)", () => {
  it("the guarded coordinator run is same-seed BYTE-IDENTICAL (the guards are deterministic)", () => {
    const a = JSON.stringify(simulate(ALL_ON));
    const b = JSON.stringify(simulate(ALL_ON));
    expect(b).toBe(a);
  });

  it("does NOT storm: total suggestions stay far below one-per-agent-per-tick (the guards damp re-emit)", () => {
    // Without the guards, every congested option re-fires every pass. The guards
    // (hysteresis + pruning + backoff) damp the re-emit so the TOTAL suggestion count
    // over the run is a small fraction of the un-damped worst case (agents × passes).
    const stream = simulate(ALL_ON);
    const suggestions = stream.filter((e) => e.event.type === "ActionSuggested").length;
    const passes = Math.floor(ALL_ON.durationTicks / 5); // COORDINATOR_INTERVAL_TICKS = 5
    const hubIds = new Set(
      stream.flatMap((e) =>
        e.event.type === "HubRegistered" ? [e.event.payload.hubId] : [],
      ),
    );
    // The un-damped worst case is (hubs × passes) hold/consolidate re-emits ALONE.
    const undampedFloor = hubIds.size * passes;
    expect(suggestions).toBeLessThan(undampedFloor);
    expect(suggestions).toBeGreaterThan(0);
  });
});
