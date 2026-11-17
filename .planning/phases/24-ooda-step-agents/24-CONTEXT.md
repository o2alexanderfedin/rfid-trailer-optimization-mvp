# Phase 24: OODA Step-Agents - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

The decentralized DECISION CORE of v3.0. Each truck and each hub gets a deterministic `step()` =
Observe→Orient→Decide→Act that emits domain events as a flag-gated `SimTask` INSIDE the one generation
core (`runToHorizon`) — never a parallel loop. Flag `oodaAgentsEnabled` OFF ⇒ the existing centralized
engine logic runs and the seed-42 golden stays byte-identical to `3920accc…`; flag ON ⇒ agents own the
decisions and the OODA model captures its own new golden. Builds on Phase 23's multi-center topology
(agents read "which center am I heading to?" from `centerOf`).

In scope: OODA-01 (truck step), OODA-02 (hub step), OODA-03 (agent-owned binding local feasibility),
OODA-04 (sorted-by-stable-id + seeded-substream + frozen observation), OODA-05 (agent-state
serialization / continuation-equivalence), DET-03 (no wall-clock/RNG/async-queue in the decision core).

Out of scope (later phases): coordinators / `ActionSuggested` (P25), coordinator↔optimizer (P26),
perf/plumbing/scale-viz (P27), consolidated determinism audit (P28). Agents establish the accept/reject
CONTRACT (binding local feasibility) that P25 coordinators will arbitrate against, but no coordinator exists yet.
</domain>

<decisions>
## Implementation Decisions

### OODA agent model (accepted in discuss)
- **Scope: BOTH truck + hub agents this phase** (P25 coordinators need both to arbitrate).
- **Events: REUSE existing domain events** — an agent emits the SAME dispatch/dwell/fuel/rest/consolidate
  events the centralized engine emits today, just DECIDED locally; add a NEW event type ONLY for a
  genuinely-new decision that has no current analog (e.g. a `divert`/re-route choice). This minimizes the
  golden-diff, keeps projections + map viz compatible, and reuses the existing HOS/fuel/consolidation logic.
- **Step cadence: event-driven self-rescheduling `SimTask`** (mirror the existing `inductPackage`/
  `createPackageBatch` self-rescheduling pattern) gated by an **"anything-to-decide?" guard** — an agent
  runs its Decide/Act only when it has a pending decision; never a blanket per-tick sweep of all agents
  (that re-creates the v2.0 stall — PITFALLS anti-feature).
- **OODA vs centralized logic (flag ON):** agents OWN the decision points (dispatch / hold / refuel /
  rest / consolidate); the engine's centralized decision code is bypassed under `oodaAgentsEnabled`.
  Flag OFF = the existing centralized path, unchanged. (Agents are NOT advisory here — advisory is the
  P25 coordinator model.)

### OODA loop content (from research FEATURES — concrete per agent type)
- **Truck agent** — Observe: own fuel, HOS/remaining legal drive, position, next-hub queue/dock, assigned
  center/route. Orient: assess feasibility. Decide (seeded, pure): proceed / divert / rest / refuel /
  hold. Act: emit the corresponding existing domain event(s).
- **Hub agent** — Observe: inbound/outbound queues, dock capacity, trailer fill, pending consolidations.
  Decide: dispatch / hold / consolidate. Act: emit existing events.
- **Agent-owned binding local feasibility (OODA-03):** fuel, HOS/rest, dock capacity are owned by the
  agent and reuse the EXISTING shared HOS engine + fuel/rest logic (do NOT rebuild). A coordinator
  (P25) cannot override these — the contract is established here.

### Determinism (keystone — DET-03 + PITFALLS guards)
- Flag `oodaAgentsEnabled` (OFF by default). Two-part flags-off gate: `false === absent` AND
  `absent ⇒ 3920accc…` byte-identical. New RNG substreams constructed LAZILY (only when ON).
- **Sorted-by-stable-id** agent iteration per tick (never Map/Set insertion order); `claimSeq()` for
  same-tick tie-breaks. **Per-agent seeded substream derived from the STABLE agent id** via the repo's
  `mixSeed`/FNV-1a finaliser (never spawn index); `OODA_RNG_SALT` pairwise-distinct from the existing
  ~8 salts (assert via the salt-collision test). **Frozen per-tick observation surface** — agents decide
  on frame-N state, emit for N+1; no mid-tick read-your-writes.
- DET-03 static guard: no `Date.now()` / `Math.random()` / `async-queue` import in the OODA decision
  packages (CI/ESLint `no-restricted-imports`); all hashed payloads through `canonicalize`.
- Agent state serializes into `SerializedWorldState` (OODA-05) → chunked/continued run byte-identical to
  uninterrupted (continuation-equivalence test). Capture a NEW OODA-on golden (reproducibility-first).
- Keep great-circle/transcendental outputs out of hashed payloads (round at boundary).

### Claude's Discretion
- Exact module layout (`packages/simulation/src/ooda/`), the new-event name/shape (if a divert event is
  needed), the precise "anything-to-decide?" predicate, and the per-agent state fields — at Claude's
  discretion following the existing `SimTask`/dispatch/substream patterns.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/simulation/src/engine.ts` — `runToHorizon`, the `SimTask` dispatch on the `(fireTick, seq)` EventQueue, the `inductPackage`/`createPackageBatch` self-rescheduling pattern to MIRROR; `centerOf` (from P23).
- `packages/simulation/src/rng.ts` (+ `mixSeed`/FNV-1a finaliser) — the seeded substream + salt discipline; the existing ~8 salts to stay pairwise-distinct from.
- The existing HOS engine (`@mm/domain` forward-labeling) + fuel/rest + consolidation logic — REUSE for OODA-03 binding feasibility, do NOT rebuild.
- `packages/domain/src/events/*` — the closed event union + zod + exhaustive switches (a new divert event, if added, must extend all of these).
- `packages/simulation/test/determinism.unit.test.ts` — the golden harness + DET two-part gate + the salt-collision test pattern.
- `SerializedWorldState` (continuation) — where agent state must serialize (OODA-05).

### Established Patterns
- Flag-gated feature + two-part flags-off golden gate; lazy substream construction; sorted-by-stable-id
  deterministic iteration; canonical hashed payloads.
- `SimTask` data-variant tasks (never closures) on the EventQueue; self-rescheduling.

### Integration Points
- New `simulation/src/ooda/` + `stepAgents` `SimTask` + dispatch case + bootstrap self-reschedule; engine
  decision-point bypass under the flag; `SerializedWorldState` extension; (if needed) a new divert event
  through the domain union + zod + every exhaustive switch + projections; map viz shows agent-driven motion (baseline).
</code_context>

<specifics>
## Specific Ideas

- Mirror `inductPackage`'s self-rescheduling + the existing salt/substream discipline exactly — this is
  "disciplined reuse," not novel machinery (research: Phase B is mostly well-specified reuse).
- The agent-order-shuffle test (shuffle the per-tick agent set → byte-identical batch) is the single
  strongest determinism witness — make it a first-class test.
</specifics>

<deferred>
## Deferred Ideas

- Coordinators / advisory `ActionSuggested` + the accept/reject arbitration — Phase 25 (this phase only
  establishes the agent-owned binding-feasibility contract they arbitrate against).
- Wiring `partitionScopeByCenter` (NET-05, built in P23) into a live epoch — Phase 26 (no per-center
  consumer until coordinators). Carry-over from Phase 23 verification.
</deferred>
