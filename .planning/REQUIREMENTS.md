# Requirements — Milestone v3.0 "Continental OODA Network"

**Milestone goal:** Scale to a continental network (big-city hubs, 1–3/state, on multiple regional sort
centers) and add a decentralized **OODA agent** layer (trucks + hubs) plus **advisory coordination-center**
entities — preserving the deterministic, event-sourced, golden-replay core.

**Keystone (applies to every requirement):** each feature is flag-gated; flags-off stays **byte-identical
to the v2.0 golden `3920accc…`**; the new model gets its own new goldens. See `DET-*`.

Detail + rationale: `.planning/research/SUMMARY.md` (+ STACK/FEATURES/ARCHITECTURE/PITFALLS/DESIGN-CONSULT).

---

## v3.0 Requirements

### Big-city hubs (HUB) — Phase A
- [x] **HUB-01**: A dev-only build-time generator emits a committed, checksummed `us-big-cities.generated.json` (city, 2-letter state, lat/lon, population/rank, IANA timezone); the runtime imports only the committed JSON (no city-data dependency at runtime), mirroring the `road-geometry.generated.json` pattern.
- [x] **HUB-02**: Hub set is selected as **1–3 hubs per state** by MSA/metro-population rank (per-state floor 1, cap 3), yielding **~80–130 hubs**, fully deterministic/static (no clock/RNG).
- [x] **HUB-03**: Metros spanning state lines are de-duplicated to a single hub; the total stays within the ~80–130 continental envelope.
- [x] **HUB-04**: Dataset **attribution compliance** is shipped (SimpleMaps backlink OR "city data © GeoNames CC BY 4.0" credit) in README/UI footer.

### Multi-center topology (NET) — Phase A
- [x] **NET-01**: The engine supports **more than one regional center**; `buildRoutes` is generalized off the hard-wired single center (`USA_HUBS[0]`) to a `centerOf(spoke)` model.
- [x] **NET-02**: The system auto-selects regional centers partitioned by **freight-corridor + timezone**, with the **center count parameterized** (not hard-coded). The concrete count is **chosen empirically in Phase A** from a real continental run (research envelope ~4–8; near-full-mesh stays cheap and per-center fan-out stays bounded across that range); never collapse to a single primary.
- [x] **NET-03**: Each big-city hub is assigned to a center by the corridor/timezone partition with a great-circle **nearest-center tie-break by stable id**, subject to a **leg-length cap** (no spoke assigned across an implausible distance).
- [x] **NET-04**: Centers are linked by a **near-full-mesh backbone** (great-circle legs), giving **≤2-hop** coast-to-coast routing, validated by an **anti-SPOF** (remove-any-center connectivity) check.
- [x] **NET-05**: Freight flows **spoke → center → backbone → center → spoke**; `detectAffectedScope` gains a **per-center scope partition** (the scaling fix).

### OODA step-agents (OODA) — Phase B
- [x] **OODA-01**: Each **truck** runs a deterministic `step()` = Observe→Orient→Decide→Act that emits existing/new domain events, on a **per-N-tick cadence with an "anything-to-decide?" guard** (never per-tick-decide-for-all).
- [x] **OODA-02**: Each **hub** runs a deterministic `step()` emitting domain events (dispatch/hold/consolidate decisions).
- [x] **OODA-03**: Agents own **binding local feasibility** (fuel, HOS/rest, dock capacity) that a coordinator **cannot override** — the agent reuses the existing HOS/fuel/consolidation logic, it is not rebuilt.
- [x] **OODA-04**: Per-tick agent passes iterate a **sorted-by-stable-id** array, draw from a **stable-id-derived seeded substream**, and read a **frozen per-tick observation surface** (no mid-tick read-your-writes).
- [x] **OODA-05**: Agent state serializes into the world state so a continued run is **byte-identical** to an uninterrupted run (continuation-equivalence).

### Coordination centers (COORD) — Phases C (rule-based) + D (optimizer-backed)
- [x] **COORD-01**: **One advisory coordination center per regional center** — an event-sourcing process-manager that runs **in-fold** (not as an async subscriber), with bounded per-center scope.
- [x] **COORD-02**: Coordinators emit advisory **`ActionSuggested`** events (re-route / hold / consolidate / dispatch); the target agent **accepts** (`SuggestionAccepted` + the binding event) or **rejects** (`SuggestionRejected` + reason code) based on its local feasibility.
- [ ] **COORD-03**: **Visible reject-with-reason** — a rejected suggestion (e.g. "won't divert: HOS/fuel") surfaces in the alert feed + audit timeline (the headline "smart and honest" demo moment).
- [x] **COORD-04**: Anti-oscillation / anti-conflict guards ship with the **first** coordinator: **hysteresis dead-band, seeded-jitter exponential backoff, sim-time TTL, single-owner lease per agent, reject-path pruning**; `ActionSuggested`/`Accepted`/`Rejected` are classified **scope-neutral** (no re-plan feedback storm).
- [x] **COORD-05**: Every agent has a **feasible no-op default** so each tick always closes (no advisory-reject Zeno livelock).
- [x] **COORD-06**: A coordinator **may invoke the existing optimizer** as a **scoped, pure `runEpoch` suggestion engine called synchronously in-fold** (not the async worker path); the global `RollingLoop` is disabled under the coordinator flag so the two never double-plan. *(Phase D; sub-flag with a heuristic fallback if profiling shows the in-fold call is too heavy.)*

### Performance & plumbing (PERF)
- [x] **PERF-01**: `applyHubInventory` is **key-scoped to the touched hub id(s)** — shipped **in Phase A** (P1-blocking; prevents the latent v2.1-style O(events×hubs) freeze from going active at 100 hubs).
- [x] **PERF-02**: `twin-snapshot` reads **incremental cursor-fold projections** (`milesSinceRefuel`, `inductionDeadlines`) instead of two full event-log scans per epoch. *(Phase E)*
- [x] **PERF-03**: `@alexanderfedin/async-queue` is wired into **runtime plumbing only** (worker↔optimizer handoff, DB write-batching, ws backpressure), **banned from the deterministic core by ESLint**; the vendored `dist/` is resolved and `vendor/*` added to the workspace; an append-order==generation-order test guards it. *(Phase E)*
- [ ] **PERF-04**: A **sustained continental-run** at ~80–130 hubs holds a target sim-min/wall-sec without the freeze/stall failure mode. *(Phase E)*

### Scale visualization (VIZ) — continues v2.0 numbering
- [x] **VIZ-15**: 100+ hubs render **without clutter** via OpenLayers `Cluster` + `declutter` + `VectorImageLayer`; static topology is sent **once**, per-tick deltas carry only trailers + transient suggestions.
- [x] **VIZ-16**: Regional centers + the near-full-mesh backbone render as a **distinct visual tier** (centers vs spokes vs backbone legs).
- [ ] **VIZ-17**: An **advisory-suggestion overlay** (accept-green / reject-red) is opt-in / decluttered on the map.

### Determinism keystone (DET) — cross-cutting, every phase
- [x] **DET-01**: Every v3.0 feature is **flag-gated**; per flag, BOTH `flag:false === absent` AND `absent ⇒ golden 3920accc…` (the two-part flags-off gate); the generalized multi-center `buildRoutes` produces the **identical `Route[]`** for the legacy 10-hub input.
- [ ] **DET-02**: Each new model (topology, OODA agents, coordinators) **captures its own new golden**, with **agent-order-shuffle**, **N-agent-RNG-decorrelation**, and **continuation-equivalence** tests green.
- [x] **DET-03**: No `Date.now()` / `Math.random()` / `async-queue` in the decision core; all hashed payloads go through `canonicalize`; a CI/ESLint static guard fails on a violation.

---

## Future Requirements (deferred — not this milestone)

- **Binding / orchestration coordinators** — coordinators that *command* rather than advise (violates the locked advisory-first + "no fully automated dispatch without override" boundary).
- **Coordinator-uses-optimizer beyond per-center scoped suggestions** — cross-center / network-wide optimizer-driven coordination.
- **Empirically-tuned & UI-exposed anti-oscillation constants** — operator-adjustable hysteresis/TTL/cooldown/lease knobs (v3.0 ships sensible seeded defaults).
- **Live continental A/B "money slide"** at scale (extends the deferred v1 UI-04 live A/B).

## Out of Scope (explicit exclusions)

- **True agent-based-model rewrite** of the event queue (per-tick agent loops replacing the deterministic EventQueue) — destroys determinism; OODA is layered *on top* as `SimTask` passes.
- **Live p-median / optimization-based hub siting** — hubs come from a static ranked dataset (live siting is an anti-feature for a reproducible demo).
- **Live ORS road geometry at continental scale** — great-circle arcs for the hundreds of new legs (ORS doesn't scale here and would break goldens).
- **Per-tick Decide for every agent** — per-N-tick + "anything-to-decide?" guard only (per-tick re-creates the v2.0 stall).
- **ML / capacity-balanced hub assignment** — corridor/timezone + nearest tie-break only.
- **Real RFID/IoT hardware + live WMS/TMS integration** — still simulation-only (carries from v1).

---

## Traceability

REQ-ID → Phase mapping (every v3.0 requirement maps to exactly one phase; 31/31 mapped, no orphans).
Roadmap phase labels A–E map to integer phases: **A → Phase 23**, **B → Phase 24**, **C → Phase 25**,
**D → Phase 26**, **E → Phase 27**, plus **Phase 28 (Continental Hardening)** as the consolidated
determinism/golden home. Every phase additionally re-asserts the flags-off `3920accc…` gate (DET-01).

| Requirement | Phase | Status |
|-------------|-------|--------|
| HUB-01 | Phase 23 — Multi-Center Topology | Complete |
| HUB-02 | Phase 23 — Multi-Center Topology | Complete |
| HUB-03 | Phase 23 — Multi-Center Topology | Complete |
| HUB-04 | Phase 23 — Multi-Center Topology | Complete |
| NET-01 | Phase 23 — Multi-Center Topology | Complete |
| NET-02 | Phase 23 — Multi-Center Topology | Complete |
| NET-03 | Phase 23 — Multi-Center Topology | Complete |
| NET-04 | Phase 23 — Multi-Center Topology | Complete |
| NET-05 | Phase 23 — Multi-Center Topology | Complete |
| PERF-01 | Phase 23 — Multi-Center Topology | Complete |
| DET-01 | Phase 23 — Multi-Center Topology (re-asserted every phase) | Complete |
| OODA-01 | Phase 24 — OODA Step-Agents | Complete |
| OODA-02 | Phase 24 — OODA Step-Agents | Complete |
| OODA-03 | Phase 24 — OODA Step-Agents | Complete |
| OODA-04 | Phase 24 — OODA Step-Agents | Complete |
| OODA-05 | Phase 24 — OODA Step-Agents | Complete |
| DET-03 | Phase 24 — OODA Step-Agents (decision-core guard lands here) | Complete |
| COORD-01 | Phase 25 — Coordination Centers | Complete |
| COORD-02 | Phase 25 — Coordination Centers | Complete |
| COORD-03 | Phase 25 — Coordination Centers (machinery done; fires live via P27-B) | Pending |
| COORD-04 | Phase 25 — Coordination Centers | Complete |
| COORD-05 | Phase 25 — Coordination Centers | Complete |
| COORD-06 | Phase 26 — Coordinator ↔ Optimizer | Complete |
| PERF-02 | Phase 27 — Perf + Plumbing + Scale Viz | Complete |
| PERF-03 | Phase 27 — Perf + Plumbing + Scale Viz | Complete |
| PERF-04 | Phase 27 — Perf + Plumbing + Scale Viz | Pending |
| VIZ-15 | Phase 27 — Perf + Plumbing + Scale Viz | Complete |
| VIZ-16 | Phase 27 — Perf + Plumbing + Scale Viz | Complete |
| VIZ-17 | Phase 27 — Perf + Plumbing + Scale Viz | Pending |
| DET-02 | Phase 28 — Continental Hardening (consolidated new-golden/order-shuffle/continuation audit) | Pending |

**Coverage: 31/31 requirements mapped to exactly one phase. No orphans, no duplicates.**
