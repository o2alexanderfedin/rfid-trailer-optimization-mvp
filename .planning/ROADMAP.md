# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Milestones

- ✅ **v1.0 MVP** — Phases 1–5 (shipped 2026-06-20) — full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- 🔨 **v1.1 Realistic Time Model + Hardening** — Phases 6–8 (started 2026-06-21)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–5) — SHIPPED 2026-06-20</summary>

- [x] Phase 1: Operational Data Foundation + Live Map Spike (7/7 plans) — completed 2026-06-19
- [x] Phase 2: Load Planning (6/6 plans) — completed 2026-06-19
- [x] Phase 3: RFID-Assisted Validation (7/7 plans) — completed 2026-06-19
- [x] Phase 4: Rolling Optimizer (6/6 plans) — completed 2026-06-19
- [x] Phase 5: Simulation + Visualization Wrapper (8/8 plans) — completed 2026-06-19

</details>

### 🔨 v1.1 Realistic Time Model + Hardening (Phases 6–8)

**Milestone goal:** Make the simulated time model defensible end-to-end — so the rolling optimizer plans against realistic, geography-derived dwell+transit instead of flat constants — and close the post-v1.0 audit follow-ups. Cross-cutting: determinism mandatory, TDD, strict TS (no `any`).

#### Phase 6: Realistic Geography & Time Model
**Goal:** Establish a shared deterministic timing foundation and make the simulation's geography + time realistic — road-following routes, distance-derived transit, and a distinct center-hub re-dispatch dwell.
**Requirements:** VIZ-06, TIME-01, TIME-02
**Enabling infra:** move `TimingConfig` / `DEFAULT_TIMING_CONFIG` + a pure `expectedMinutes()` estimator into `@mm/domain` (shared leaf — avoids a `@mm/simulation`↔`@mm/optimizer` circular dep).
**Success criteria:**
1. Trailers animate along real road-following polylines (precomputed ORS `driving-hgv` → committed static GeoJSON), not straight arcs; geometry replays byte-identically.
2. Each leg's transit scales with its real road distance (longer legs take proportionally longer), drawn around a distance-derived median.
3. A trailer through the center hub incurs a distinct, longer re-dispatch dwell (`dwellCenter` ≈ 65 min expected), separate from spoke dwell, applied exactly once.
4. The shared timing config + `expectedMinutes()` live in `@mm/domain`, consumed by the simulator with no behavior regression (golden-replay keystone stays green).
5. Determinism preserved: same seed ⇒ identical timing + geometry across runs.

#### Phase 7: Time-Aware Optimizer
**Goal:** Make the rolling optimizer plan against the realistic time model — fold expected dwell + transit into the time-expanded graph so plans reflect real leg durations, derived deterministically from the shared timing config. *(Design-heavy core; depends on Phase 6.)*
**Requirements:** OPT-09, OPT-10
**Success criteria:**
1. The graph's trip travel reflects expected (distance-derived) transit and a hub service-time offset reflects expected dwell — not fixed 15-min steps with flat dwell.
2. The planning estimate is the deterministic clamped log-normal **mean** (`median·exp(σ²/2)`) via the single shared `expectedMinutes`; identical inputs ⇒ identical plan.
3. Changing the timing config produces a correspondingly different plan (optimizer demonstrably consumes timing).
4. The scenario-reopt keystone + golden fixtures are re-baselined with each plan delta explained; glpk oracle + planner-vs-validator property tests stay green (no masked regression).
5. No dwell double-counting: end-to-end planned leg time matches expected sim time within tolerance.

#### Phase 8: Client Hardening & Coverage
**Goal:** Harden the realtime client against partial envelopes and raise meaningful coverage on the ws socket path. *(Independent; naturally last.)*
**Requirements:** HRD-01, QA-01
**Success criteria:**
1. A ws envelope missing `speed` still animates the map (`DEFAULT_SPEED` fallback) with a one-time warning; malformed envelopes (bad `v`/`type`/`seq`/`simMs`/`payload`) are still rejected.
2. The `wsClient` socket path (open-once, seq-gap→resync, snapshot-replace, tick-apply) is covered by behavior-asserting tests.
3. Branch coverage rises toward the project bar without metric gaming (assertions verify behavior).

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Operational Data Foundation + Live Map Spike | v1.0 | 7/7 | ✅ Complete | 2026-06-19 |
| 2. Load Planning | v1.0 | 6/6 | ✅ Complete | 2026-06-19 |
| 3. RFID-Assisted Validation | v1.0 | 7/7 | ✅ Complete | 2026-06-19 |
| 4. Rolling Optimizer | v1.0 | 6/6 | ✅ Complete | 2026-06-19 |
| 5. Simulation + Visualization Wrapper | v1.0 | 8/8 | ✅ Complete | 2026-06-19 |
| 6. Realistic Geography & Time Model | v1.1 | 0/? | ○ Not Started | — |
| 7. Time-Aware Optimizer | v1.1 | 0/? | ○ Not Started | — |
| 8. Client Hardening & Coverage | v1.1 | 0/? | ○ Not Started | — |
