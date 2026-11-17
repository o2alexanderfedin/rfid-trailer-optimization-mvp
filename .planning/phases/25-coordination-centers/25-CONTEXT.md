# Phase 25: Coordination Centers - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

The headline differentiator of v3.0. One ADVISORY coordination center per regional center — an
event-sourcing PROCESS MANAGER that runs IN-FOLD (a sorted-by-centerId `stepCoordinators` `SimTask`,
NOT an async subscriber) — observes truck/hub agent events and emits advisory `ActionSuggested`. The
target agent ACCEPTS (binding event) or REJECTS-with-reason against the binding local feasibility it
alone knows (established in Phase 24); a visible reject-with-reason surfaces in the alert feed + audit
timeline. The full set of anti-oscillation/anti-deadlock guards ship with the FIRST coordinator so the
network stays stable. Flag `coordinatorsEnabled` OFF ⇒ byte-identical to `3920accc…`.

In scope: COORD-01 (one per center, in-fold), COORD-02 (`ActionSuggested`→accept/reject handshake),
COORD-03 (visible reject-with-reason), COORD-04 (the 5 guards + scope-neutral suggestion events),
COORD-05 (feasible no-op default / no Zeno livelock).

Out of scope: COORD-06 coordinator-uses-optimizer (P26 — generation is RULE-BASED here); perf/viz
hardening (P27); consolidated determinism audit (P28). The `partitionScopeByCenter` (NET-05, built P23)
live wiring belongs to P26 — but the per-center coordinator SCOPE here should be bounded per center.
</domain>

<decisions>
## Implementation Decisions (accepted in discuss)

### Coordinator model
- **Suggestion types: all 4** — reroute / hold / consolidate / dispatch — generated **RULE-BASED** this
  phase (optimizer-backed generation is P26).
- **Suggestion event payload (rich — the guards need it):**
  `ActionSuggested { suggestionId, coordinatorId, targetAgentId, kind, params, issuedAtSimMs, ttlSimMs }`
  → `SuggestionAccepted { suggestionId }` + the binding domain event the agent then emits
  / `SuggestionRejected { suggestionId, reasonCode }`. All three are **scope-neutral** in `scope.ts`
  (mirror `PlanGenerated`/`PlanAccepted`/`PlanSuperseded`) so they never re-trigger the suggesting
  coordinator (no re-plan feedback storm).
- **In-fold handshake:** `stepCoordinators` (one per center, sorted by centerId) emits `ActionSuggested`
  into a `pendingSuggestionsByTarget` map consumed in the SAME tick by the agent's step (Phase 24),
  which accepts (→ binding event) or rejects (→ reason code) using its Phase-24 feasibility verdict.
- **Reject-with-reason surfacing (COORD-03):** REUSE the existing alert feed + audit timeline — emit an
  exception/alert carrying the reason code (e.g. "won't divert: HOS/fuel"). No new UI panel.

### The five anti-oscillation / anti-deadlock guards (COORD-04, ship with the FIRST coordinator)
Constants are NAMED + tunable (from the DESIGN-CONSULT envelope; baked into the coordinator golden),
all sim-time/seeded/pure (determinism-safe):
1. **Hysteresis dead-band** — a metric must cross a threshold AND persist ~15 sim-min before a new suggestion.
2. **Seeded-jitter exponential backoff** — on rejection, back off that option; jitter from the SEEDED
   coordinator substream (never `Math.random`).
3. **Sim-time TTL** — each suggestion expires ~6 sim-min (`ttlSimMs`); unaccepted ⇒ self-destructs.
4. **Single-owner lease per agent** — a coordinator holds a ~5 sim-min lease on a target before advising
   it (a lease field in projection/engine state), so two coordinators can't target the same agent.
5. **Reject-path pruning** — once an agent rejects a specific option, the coordinator stops re-offering
   it (cooldown K=3 rejections); cleared on shift/zone change.

### Anti-livelock (COORD-05)
Every agent ALWAYS has a feasible no-op default so each tick closes; an agent that rejects every
suggestion still closes its tick; the coordinator stops re-suggesting after K rejections; events-per-tick
stays bounded. A "converges within K epochs, no A↔B↔A oscillation" test on a fixed scenario.

### Determinism (keystone)
- Flag `coordinatorsEnabled` (OFF by default). Two-part flags-off gate (`false===absent` AND `absent⇒3920accc…`).
- New events through the closed union + zod + EVERY exhaustive switch (the Phase-22/24 trap: only
  `pnpm typecheck` catches a missed case) + scope-neutral classification. Canonicalize all new hashed payloads.
- New coordinator substream salt pairwise-distinct (salt-collision test); lazy construction (only when ON).
- Coordinators run in-fold sorted by centerId; agents sorted by stable id; frozen observation per tick.
- New coordinator-on golden captured reproducibility-first; continuation-equivalence green.

### Claude's Discretion
- Module layout (`simulation/src/coordinator/`), the exact rule-based suggestion heuristics per kind, the
  precise per-center scope boundary, and the lease/pruning state shape — at Claude's discretion following
  the Phase-24 OODA + existing optimizer-recommendation patterns.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/simulation/src/ooda/*` (Phase 24) — the agent `step()`, the feasibility verdict (the agent's
  accept/reject basis), `deriveAgentRng`, sorted-by-stable-id, frozen observation, `canonicalizeOodaPayload`.
- `packages/simulation/src/engine.ts` — the `stepAgents` SimTask + dispatch + self-rescheduling pattern to
  MIRROR for `stepCoordinators`; `centerOf` (P23) for one-coordinator-per-center.
- `packages/optimizer/src/rolling/scope.ts` — the scope-neutral classification pattern
  (`PlanGenerated`/`PlanAccepted`/`PlanSuperseded`) to mirror for the suggestion events.
- The existing alert/exception feed + audit timeline (VIZ) — reuse for COORD-03 reject-with-reason.
- `packages/domain/src/events/*` — closed union + zod + exhaustive switches (the 3 new events thread through all).
- `packages/simulation/test/determinism.unit.test.ts` — golden harness, two-part gate, salt-collision test.

### Established Patterns
- Flag-gated + two-part flags-off golden; lazy seeded substream (distinct salt); sorted deterministic
  iteration; canonical hashed payloads; the OPT-06 freeze-window/scopeHash anti-thrash primitives to reuse.
- SimTask data-variant tasks on the (fireTick,seq) queue; self-rescheduling.

### Integration Points
- New `simulation/src/coordinator/` + `stepCoordinators` SimTask + dispatch + bootstrap; the 3 new events
  through domain union + zod + every exhaustive switch + scope.ts (scope-neutral) + projections;
  `pendingSuggestionsByTarget` handshake wired into the Phase-24 agent step; alert-feed emission on reject;
  coordinator + lease state into `SerializedWorldState` (continuation); map viz (baseline — overlay is P27).
</code_context>

<specifics>
## Specific Ideas
- The "visible reject-with-reason" (a truck declining a coordinator re-route because HOS/fuel won't allow
  it) is THE demo moment — make it observable via the alert feed with a clear reason code.
- The "converges in K epochs, no oscillation" + "bounded events-per-tick under all-reject" tests are the
  highest-value guards — first-class tests. This phase gets an ADVERSARIAL verify (skeptic tries to break
  determinism + find oscillation/deadlock holes).
</specifics>

<deferred>
## Deferred Ideas
- Coordinator-uses-optimizer (suggestion generation via scoped pure `runEpoch`) — Phase 26.
- `partitionScopeByCenter` live epoch wiring — Phase 26.
- Suggestion-overlay map viz (accept-green/reject-red) + scale-viz — Phase 27.
</deferred>
