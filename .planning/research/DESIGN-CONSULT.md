# v3.0 Design Consult — Google AI Mode (architecture decisions)

**Source:** Google AI Mode (`udm=50`) browser consult, 2026-06-26, two threaded questions on
decentralized middle-mile coordination vs a global optimizer. Captured + annotated with this
project's determinism constraints. Feeds the research SUMMARY + roadmap. (AI output is advisory —
cross-checked against the parallel STACK/FEATURES/ARCHITECTURE/PITFALLS research.)

---

## Q1 — Decentralized coordination vs global optimizer (the "decide in research" item)

**Verdict: hierarchical HYBRID is the modern consensus — not either/or.** This directly resolves the
coordinator↔optimizer relationship the user left open ("coordinators may *use* the optimizer").

- **Macro-Layer (global / centralized optimizer):** strips structural waste from the steady state —
  static lane assignments, fleet sizing, milk-run alignment, trailer cubing, weekly schedules.
  Best at cost minimization on predictable lanes. Weakness: re-running the whole VRP/network-flow on
  every disruption is an NP-hard bottleneck; batch cycles go stale.
- **Micro-Layer (decentralized / control towers + OODA agents):** real-time dispatch, dynamic
  cross-dock sorting, automated re-routing at the local hub level. Event-driven, adapts instantly at
  the edge, **expects node non-compliance/rejection as the default state** (exactly our advisory model).
  Weakness: slightly higher total mileage (locally sub-optimal) — traded for resilience.

**→ Design decision (recommended):** KEEP the existing rolling optimizer as the **macro-layer**
(structural plan / suggestion generator). Add per-region **coordination centers as the micro-layer**
that consume events and emit **advisory** `ActionSuggested`; agents arbitrate with local feasibility.
A coordinator may *invoke the (scoped) optimizer* to generate a suggestion, then wrap its output as an
advisory event — it does **not** replace the optimizer. This matches the user's stated intent.

---

## Q2 — Anti-oscillation / livelock / conflict patterns (agents can reject)

The failure mode: control tower suggests A → agent rejects (e.g. HOS risk) → tower recomputes →
re-suggests A → flapping, wasted cycles. Five concrete, **determinism-compatible** guards:

| Pattern | What it does | Determinism mapping in OUR sim |
|---|---|---|
| **State hysteresis / deadbands** | Don't advise on raw real-time metrics; require a metric (dock congestion, delay) to cross a threshold AND persist for a sustained window (~15 min) before a new suggestion. | Pure: threshold + dwell-duration on projection state. Sim-time based. Fully deterministic. |
| **Exponential backoff + jitter** | On rejection, back off that specific option; jitter de-synchronizes many agents retrying the same bottleneck. | Backoff = pure (count→delay). **Jitter MUST come from the existing SEEDED RNG substream, never `Math.random()`** — else replay breaks. Salt a per-coordinator substream. |
| **Suggestion TTL** | Each advisory carries a short expiry (~5–8 min); if not accepted/rejected in window it self-destructs → no acting on stale snapshots. | TTL in **sim-time** (not wall-clock). Deterministic expiry during fold. |
| **Distributed lease tokens** | A tower must hold a lease on a truck/hub before advising it → two centers can't target the same capacity (prevents conflicting advice). | In a single-process deterministic sim this is just a **lease field in projection state** (resource → {coordinatorId, expiresAtSimMs}). Cheap + deterministic; the cross-region conflict guard. |
| **Reject-path pruning (DAG progression)** | Once an agent rejects a specific path/consolidation, prune it from the local option set until shift reset / zone change. | Deterministic `rejectedOptions` set on agent state, cleared on shift/zone boundary. Directly kills livelock + re-suggest loops. |

**→ These five become explicit requirements/guards in the COORD phase.** The advisory-reject-deadlock
the user implied (agent rejects everything → no progress) is handled by: TTL (suggestions expire,
agent proceeds on its own OODA decision) + reject-path pruning (the tower stops re-offering the same
infeasible option) + the agent ALWAYS having a default autonomous action when no suggestion is accepted.

---

## Q3 — Regional control-tower count, partitioning, backbone (refines the design-notes assumptions)

- **Count: 3–5 regional control towers** for ~100 US hubs is the industry standard (the design-notes
  guess of "a handful" → pin to **3–5**, lower than a naive per-timezone-x-region split).
- **Partitioning: by operational CORRIDORS + TIMEZONES, NOT raw nearest-distance.** "Freight gravity
  over distance" — don't split a natural freight lane (e.g. I-35 TX→Midwest) across two towers; that
  creates massive edge-coordination overhead. Timezone alignment matches HOS boundaries + shift
  changes. **This refines the design-notes "nearest-center" rule:** use corridor/timezone partition,
  with nearest-center only as an in-corridor tiebreaker.
- **Backbone: FULL MESH.** With only 3–5 nodes, full mesh = 1-hop state sync, no single point of
  failure, low overhead (4 nodes → 6 channels). Hub-of-hubs has a vulnerable center; ring is
  high-latency. (Design-notes listed mesh/ring/hub-of-hubs as open → **pick full mesh**.)

---

## Net effect on the milestone

- **Coordinator↔optimizer:** RESOLVED → hybrid; optimizer = macro suggestion engine, coordinators =
  micro advisory layer. (Was the riskiest open question.)
- **Regional centers:** **3–5**, corridor/timezone partition, **full-mesh** backbone. (Refines design notes.)
- **Anti-oscillation:** five named guards (hysteresis, seeded-jitter backoff, sim-time TTL, lease
  tokens, reject-path pruning) → concrete COORD-phase requirements + tests.
- **Determinism:** every guard maps to pure/sim-time/seeded-RNG state — none requires wall-clock or
  unseeded randomness. The lease/TTL/hysteresis all live in projection/agent state and fold deterministically.
