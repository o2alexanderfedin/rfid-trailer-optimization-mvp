# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Milestones

- ✅ **v1.0 MVP** — Phases 1–5 (shipped 2026-06-20) — full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Realistic Time Model + Hardening** — Phases 6–8 (shipped 2026-06-22) — full details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Driver HOS & Hub Detail** — Phases 9–18 (shipped 2026-06-22) — full details: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md)
- ✅ **v2.0 Complete Simulation Model** — Phases 19–22 (shipped 2026-06-25) — continuous · external induction · bidirectional freight · outbound delivery — full details: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v2.1** — sim-perf hardening (O(n²)→O(affected-keys) projection fold + snapshot clock-anchor; shipped to main as `v2.1.0` 2026-06-26)
- 🚧 **v3.0 Continental OODA Network** — Phases 23–28 (planning) — big-city hubs (1–3/state) · multi–regional-center topology · OODA step-agents · advisory coordination centers · scale viz/perf — research: [research/SUMMARY.md](research/SUMMARY.md) · design seed: [v3.0-DESIGN-NOTES.md](v3.0-DESIGN-NOTES.md)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–5) — SHIPPED 2026-06-20</summary>

- [x] Phase 1: Operational Data Foundation + Live Map Spike (7/7 plans) — completed 2026-06-19
- [x] Phase 2: Load Planning (6/6 plans) — completed 2026-06-19
- [x] Phase 3: RFID-Assisted Validation (7/7 plans) — completed 2026-06-19
- [x] Phase 4: Rolling Optimizer (6/6 plans) — completed 2026-06-19
- [x] Phase 5: Simulation + Visualization Wrapper (8/8 plans) — completed 2026-06-19

</details>

<details>
<summary>✅ v1.1 Realistic Time Model + Hardening (Phases 6–8) — SHIPPED 2026-06-22</summary>

- [x] Phase 6: Realistic Geography & Time Model — completed 2026-06-21 (VIZ-06, TIME-01, TIME-02)
- [x] Phase 7: Time-Aware Optimizer — completed 2026-06-21 (OPT-09, OPT-10)
- [x] Phase 8: Client Hardening & Coverage — completed 2026-06-22 (HRD-01, QA-01)

</details>

<details>
<summary>✅ v1.2 Driver HOS & Hub Detail (Phases 9–18) — SHIPPED 2026-06-22</summary>

> **Keystone constraint:** determinism. HOS-*off* stays byte-identical to the pre-v1.2 golden replay; HOS-*on* adds a new golden. All HOS RNG flows through one new isolated seeded substream.

- [x] Phase 9: Driver model + HOS config + duty/phase events ✅ 2026-06-22
- [x] Phase 10: Pure forward-labeling HOS engine (shared sim + optimizer) ✅ 2026-06-22
- [x] Phase 11: Sim HOS enforcement + load/unload events + determinism golden ✅ 2026-06-22
- [x] Phase 12: Driver relay / swap at hubs ✅ 2026-06-22
- [x] Phase 13: Driver-status projection + tables ✅ 2026-06-22
- [x] Phase 14: Hub-detail endpoint + ws driver buckets ✅ 2026-06-22
- [x] Phase 15: Optimizer HOS-aware ✅ 2026-06-22
- [x] Phase 16: Optimizer HOS-enforced ✅ 2026-06-22
- [x] Phase 17: Hub Detail panel UI + map duty styling ✅ 2026-06-22
- [x] Phase 18: README features + screenshots ✅ 2026-06-22

</details>

<details>
<summary>✅ v2.0 Complete Simulation Model (Phases 19–22) — SHIPPED 2026-06-25</summary>

> **Keystone constraint — determinism:** Every v2.0 feature is opt-in (flag off by default). With all v2.0 flags off, the seed-42 10k-tick golden `3920accc…` is byte-identical to pre-v2.0.

- [x] **Phase 19: Continuous Operation Foundation** — open-ended run loop, multi-cycle generation, sim-day counter, bounded-memory infrastructure, long-run determinism golden, bidirectional route registration — completed 2026-06-24
- [x] **Phase 20: External Induction** — `PackageInducted` event, spoke-hub induction on a dedicated seeded substream, SLA deadline to optimizer, pulsing map marker — completed 2026-06-24
- [x] **Phase 21: Bidirectional Freight / Consolidation** — spoke→center consolidation, center re-sort, `PlanSuperseded`, durable optimizer idempotency, consolidation map styling — completed 2026-06-24
- [x] **Phase 22: Outbound Delivery** — `PackageDelivered` terminal event, `onTime` SLA flag, projection purge, delivery hub-highlight — completed 2026-06-25

</details>

---

### 🚧 v3.0 Continental OODA Network — Phases 23–28 (PLANNING)

> **Milestone Goal:** Scale from 10 fixed hubs to a continental network (~80–130 big-city hubs, 1–3 per state, on a small set of regional sort centers) and replace the single global rolling optimizer with a decentralized **OODA agent** layer (trucks + hubs that emit domain events) plus **advisory coordination-center** process-managers that observe agent events and *suggest* actions — agents arbitrate with binding local feasibility (fuel, HOS, road-closure) they alone know.
>
> **Keystone constraint — determinism (every phase):** OODA decision logic *changes the event stream*, so v3.0 is a **NEW model with NEW goldens**. Every feature is flag-gated. For **each** flag, the **two-part flags-off gate** holds: `flag:false === absent` AND `absent ⇒ seed-42 10k-tick golden 3920accc…` (byte-identical to v2.0). Model-changing phases capture their **own new golden** (continental → ooda → coordinator). New RNG substreams are constructed **lazily** (only when the flag is on), use salts pairwise-distinct from the existing 8 (asserted by the salt-collision test), and derive per-agent streams from the **stable agent id** (never spawn index). The decision core stays sync + pure: no `Date.now()` / `Math.random()` / `async-queue`; all hashed payloads go through `canonicalize`.

- [ ] **Phase 23: Multi-Center Topology** — big-city hub generation (1–3/state, ~80–130) + parameterized regional centers + near-full-mesh backbone + per-center scope partition + **`applyHubInventory` key-scoping (P1-BLOCKING)**; FOUNDATION for everything (HUB-01..04, NET-01..05, PERF-01, DET-01)
- [ ] **Phase 24: OODA Step-Agents** — deterministic per-truck + per-hub `step()` (Observe→Orient→Decide→Act) emitting domain events, sorted-by-stable-id passes, per-agent seeded substreams, frozen observation surface, continuation-equivalent agent state; the decentralized decision core (OODA-01..05, DET-03)
- [ ] **Phase 25: Coordination Centers** — one advisory process-manager per regional center emitting `ActionSuggested`; agents accept/reject-with-reason on local feasibility; the five anti-oscillation/anti-deadlock guards + scope-neutral suggestion events; the headline "smart and honest" differentiator (COORD-01..05)
- [ ] **Phase 26: Coordinator ↔ Optimizer** — coordinators invoke the proven optimizer as a scoped, pure `runEpoch` suggestion engine called synchronously in-fold; global `RollingLoop` disabled under the flag so the two never double-plan (COORD-06)
- [ ] **Phase 27: Perf + Plumbing + Scale Viz** — incremental cursor-fold twin-snapshot projections + `async-queue` runtime-plumbing wiring (ESLint-banned from the core) + 100+-hub clustered/decluttered scale viz + sustained continental-run perf (PERF-02..04, VIZ-15..17)
- [ ] **Phase 28: Continental Hardening** — consolidated determinism/golden audit: per-model new goldens, agent-order-shuffle, N-agent-RNG-decorrelation, and continuation-equivalence all green together, plus the cross-arch capture note (DET-02)

## Phase Details

### Phase 23: Multi-Center Topology
**Goal**: The engine runs on a continental network of ~80–130 deterministically-generated big-city hubs spoked to multiple regional sort centers over a near-full-mesh backbone, with the projection fold and optimizer scope key-scoped so the 100-hub jump does not re-create the v2.1 freeze — the foundation every later phase reads.
**Depends on**: Phase 22 (v2.0 complete) + v2.1 perf fold
**Requirements**: HUB-01, HUB-02, HUB-03, HUB-04, NET-01, NET-02, NET-03, NET-04, NET-05, PERF-01, DET-01
**Success Criteria** (what must be TRUE):
  1. With the `continentalTopology` flag on, the live map renders ~80–130 hubs (1–3 per state by metro-population rank, cross-state metros de-duped to a single hub, all inside the continental envelope) sourced only from a committed, content-checksummed `us-big-cities.generated.json` (no runtime city-data dependency) — and the dataset attribution credit (SimpleMaps backlink or GeoNames CC BY 4.0) is visible in the README/UI footer
  2. Freight flows **spoke → nearest regional center → backbone → destination center → destination spoke**: each spoke is assigned to a center by the corridor/timezone partition with great-circle nearest tie-break by stable id under a leg-length cap, centers are linked by a near-full-mesh backbone giving ≤2-hop coast-to-coast routing, and an anti-SPOF check confirms connectivity survives removing any one center
  3. The **center count is parameterized, not hard-coded** — and the concrete value (research envelope ~4–8, default ~5–6) is **chosen empirically in this phase from a real continental run** that validates trailer-fill/consolidation; the committed center-partition snapshot records the decision, and the network never collapses to a single primary center
  4. `applyHubInventory` is **key-scoped to the touched hub id(s)** (PERF-01, P1-BLOCKING): a per-event projection-cost test proves row reads are independent of hub count (10-hub vs 100-hub fold cost equal per event) — the freeze does not recur at 100 hubs; `detectAffectedScope` gains a per-center scope partition so one center's epoch never pulls another's trailers
  5. **Determinism gate:** the generalized multi-center `buildRoutes` produces the **identical `Route[]`** for the legacy 10-hub single-center input; with `continentalTopology` absent (and `:false`) the seed-42 10k-tick golden is byte-identical to `3920accc…` (DET-01 two-part gate); the new continental model captures its own new golden on a small (12–20-hub) fixture for a fast hash
**Plans**: TBD
**UI hint**: yes

### Phase 24: OODA Step-Agents
**Goal**: Every truck and hub runs a deterministic `step()` (Observe→Orient→Decide→Act) that emits domain events as a flag-gated `SimTask` inside the one generation core — the decentralized decision layer — while keeping byte-identical replay for a given model + seed.
**Depends on**: Phase 23 (agents read "which center am I heading to?" from the topology)
**Requirements**: OODA-01, OODA-02, OODA-03, OODA-04, OODA-05, DET-03
**Success Criteria** (what must be TRUE):
  1. With `oodaAgentsEnabled` on, each truck and each hub makes its own dispatch/hold/consolidate/refuel decisions via a per-N-tick `step()` with an "anything-to-decide?" guard (never per-tick-decide-for-all), emitting existing/new domain events into the same log — observable as agent-driven freight movement on the live map rather than a single global plan
  2. Agents own **binding local feasibility** (fuel, HOS/rest, dock capacity) by reusing the existing HOS/fuel/consolidation logic (not rebuilt); a coordinator cannot override it (verified in Phase 25's accept/reject, the contract is established here)
  3. **Agent-order independence:** each per-tick agent pass iterates a sorted-by-stable-id array drawing from a stable-id-derived seeded substream over a frozen per-tick observation surface (no mid-tick read-your-writes) — shuffling the per-tick agent set produces a byte-identical event batch, and N agents yield N decorrelated streams (no two share their first K draws; renaming/reordering agents does not change the golden)
  4. **Continuation-equivalence:** agent state serializes into `SerializedWorldState` so a chunked/continued run is byte-identical to an uninterrupted run
  5. **Determinism gate (DET-03):** no `Date.now()` / `Math.random()` / `async-queue` appears in the OODA decision core (a CI/ESLint static guard fails on a violation); all hashed payloads go through `canonicalize`; with `oodaAgentsEnabled` absent (and `:false`) the seed-42 10k golden stays byte-identical to `3920accc…`, and the OODA-on model captures its own new golden
**Plans**: TBD
**UI hint**: yes

### Phase 25: Coordination Centers
**Goal**: One advisory coordination center per regional center (an in-fold event-sourcing process-manager) observes agent events and emits `ActionSuggested`; the target agent accepts (binding event) or rejects-with-reason on its local feasibility — surfaced as a visible "won't divert: HOS/fuel" alert — with the full set of anti-oscillation/anti-deadlock guards so the network stays stable.
**Depends on**: Phase 24 (agents must exist to accept/reject)
**Requirements**: COORD-01, COORD-02, COORD-03, COORD-04, COORD-05
**Success Criteria** (what must be TRUE):
  1. With `coordinatorsEnabled` on, one coordinator per center runs **in-fold** (a sorted-by-centerId `stepCoordinators` `SimTask`, not an async subscriber) with bounded per-center scope, emitting advisory `ActionSuggested` events (reroute / hold / consolidate / dispatch) consumed in the same tick via an in-engine `pendingSuggestionsByTarget` handshake
  2. The target agent **accepts** (`SuggestionAccepted` + the binding event) or **rejects** (`SuggestionRejected` + reason code) based on the local feasibility it alone knows; a **visible reject-with-reason** (e.g. "won't divert: HOS/fuel") surfaces in the alert feed + audit timeline — the headline "smart and honest" demo moment
  3. The network stays stable: the five guards ship with the first coordinator — **hysteresis dead-band, seeded-jitter exponential backoff, sim-time TTL, single-owner lease per agent, reject-path pruning** — and a fixed scenario converges to a stable plan within K epochs with no A↔B↔A oscillation
  4. No livelock/deadlock: every agent has a **feasible no-op default** so each tick always closes; an agent that rejects every suggestion still closes its tick and the coordinator stops re-suggesting after K rejections — events-per-tick stays bounded (no advisory-reject Zeno livelock)
  5. **Determinism gate:** `ActionSuggested`/`SuggestionAccepted`/`SuggestionRejected` are added to the closed union + zod + every exhaustive switch and classified **scope-neutral** (no re-plan feedback storm); all new hashed payloads go through `canonicalize`; with `coordinatorsEnabled` absent (and `:false`) the seed-42 10k golden stays byte-identical to `3920accc…`, and the coordinator-on model captures its own new golden (+ continuation-equivalence green)
**Plans**: TBD
**UI hint**: yes

### Phase 26: Coordinator ↔ Optimizer
**Goal**: A coordinator may invoke the proven v1 optimizer as a per-center scoped, pure suggestion engine — building a small per-center twin from its in-engine fold state and calling `runEpoch` synchronously in-fold — preserving the hardest-won optimization IP without breaking byte-identical replay.
**Depends on**: Phase 25 (refines an already-working rule-based coordinator)
**Requirements**: COORD-06
**Success Criteria** (what must be TRUE):
  1. With `coordinatorUsesOptimizer` on (a sub-flag of coordinators), a coordinator builds a per-center twin from in-engine fold state and calls the **pure `@mm/optimizer` `runEpoch` synchronously in-fold** (never the async worker path), translating the result into `ActionSuggested` events — and the resulting suggestions are observably plan-quality (route-aware) rather than purely rule-based
  2. The scope stays bounded: each coordinator reuses `detectAffectedScope` over a short horizon (a single event triggers an epoch whose scope ⊆ that center's affected hubs, size independent of total network size) — no per-center full-region re-solve
  3. The global `RollingLoop` is **disabled under the coordinator flag** so the two never double-plan; a heuristic-Decide fallback remains behind the sub-flag if profiling shows the in-fold call is too heavy
  4. **Determinism gate:** the in-fold `runEpoch` call runs at a deterministic tick in sorted order over pure inputs; with `coordinatorUsesOptimizer` absent (and `:false`) replay is byte-identical to the Phase-25 coordinator model, and the optimizer-backed model captures its own golden
**Plans**: TBD

### Phase 27: Perf + Plumbing + Scale Viz
**Goal**: A continental run renders cleanly at 100+ hubs and sustains a live demo without the freeze/stall failure mode — read-side projections fold incrementally, runtime plumbing is backpressured via the vendored async-queue (kept out of the deterministic core), and the map declutters the dense static network.
**Depends on**: Phase 23 (independent of the model — can interleave with Phases 25/26)
**Requirements**: PERF-02, PERF-03, PERF-04, VIZ-15, VIZ-16, VIZ-17
**Success Criteria** (what must be TRUE):
  1. `twin-snapshot` reads **incremental cursor-fold projections** (`milesSinceRefuel`, `inductionDeadlines`) instead of two full event-log scans per epoch — optimizer epoch latency no longer grows with run length (a read-side change only, no new golden; rebuild-equivalence preserved)
  2. `@alexanderfedin/async-queue` is wired into **runtime plumbing only** (worker↔optimizer handoff, DB write-batching, ws backpressure), with the vendored `dist/` resolved and `vendor/*` in the workspace; an ESLint `no-restricted-imports` rule **bans it from the deterministic core**, and an append-order==generation-order test proves the queue never reorders the event stream
  3. The map renders 100+ hubs **without clutter** via OpenLayers `Cluster` + `declutter` + `VectorImageLayer`: static topology is sent **once**, per-tick deltas carry only trailers + transient suggestions (per-tick payload bytes stay bounded as hub count grows), regional centers + the near-full-mesh backbone render as a distinct visual tier (centers vs spokes vs backbone), and an opt-in/decluttered advisory-suggestion overlay (accept-green / reject-red) is available
  4. A **sustained continental-run** at ~80–130 hubs holds a target sim-min/wall-sec without the freeze/stall failure mode (PERF-04), demonstrable live end-to-end
**Plans**: TBD
**UI hint**: yes

### Phase 28: Continental Hardening
**Goal**: Consolidate the determinism guarantees for the full continental OODA model into one passing audit — every new model's golden, agent-order-shuffle, N-agent-RNG-decorrelation, and continuation-equivalence all green together — closing the milestone's keystone constraint with a single auditable gate.
**Depends on**: Phases 24, 25, 26 (all model-changing phases must be in)
**Requirements**: DET-02
**Success Criteria** (what must be TRUE):
  1. Each new model (continental topology, OODA agents, coordinators, optimizer-backed coordinators) has its **own committed new golden**, captured only after same-seed reproducibility + the flags-off gate are proven first (no non-reproducible golden baked in)
  2. The consolidated determinism suite is green together: **agent-order-shuffle** (shuffle the per-tick agent set → byte-identical batch), **N-agent-RNG-decorrelation** (N agents → N independent streams; rename/reorder leaves goldens unchanged), and **continuation-equivalence** (chunked == all-at-once) across every v3.0 flag combination
  3. **Master flags-off gate re-asserted:** with all v3.0 flags absent and explicit-`false`, the seed-42 10k-tick golden is byte-identical to `3920accc…` (the full DET-01 two-part gate per flag, audited in one place); the cross-arch capture environment is documented next to each new golden with the integer-LUT contingency noted
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 23. Multi-Center Topology | 0/TBD | Not started | - |
| 24. OODA Step-Agents | 0/TBD | Not started | - |
| 25. Coordination Centers | 0/TBD | Not started | - |
| 26. Coordinator ↔ Optimizer | 0/TBD | Not started | - |
| 27. Perf + Plumbing + Scale Viz | 0/TBD | Not started | - |
| 28. Continental Hardening | 0/TBD | Not started | - |

| Milestone | Phases | Status | Shipped |
|-----------|--------|--------|---------|
| v1.0 MVP | 1–5 | ✅ Complete | 2026-06-20 |
| v1.1 Realistic Time Model + Hardening | 6–8 | ✅ Complete | 2026-06-22 |
| v1.2 Driver HOS & Hub Detail | 9–18 | ✅ Complete | 2026-06-22 |
| v2.0 Complete Simulation Model | 19–22 | ✅ Complete | 2026-06-25 |
| v2.1 sim-perf hardening | (in 19–22 range) | ✅ Shipped to main | 2026-06-26 |
| v3.0 Continental OODA Network | 23–28 | 🚧 Planning | - |
