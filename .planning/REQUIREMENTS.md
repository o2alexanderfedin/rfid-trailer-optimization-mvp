# Requirements — Milestone v1.1 "Realistic Time Model + Hardening"

**Defined:** 2026-06-21
**Milestone goal:** Make the simulated time model defensible end-to-end — so the rolling optimizer plans against realistic, geography-derived dwell+transit instead of flat constants — and close the post-v1.0 audit follow-ups.
**Continues REQ-ID numbering from v1.0** (OPT-01..08, VIZ-01..05, etc.). v1.0's 48 requirements are archived in `milestones/v1.0-REQUIREMENTS.md`.

> Research basis: `.planning/research/SUMMARY.md` (+ STACK/FEATURES/ARCHITECTURE/PITFALLS). Determinism is mandatory throughout; TDD; strict TS (no `any`).

## v1.1 Requirements

### Optimizer time-awareness (OPT)
- [ ] **OPT-09**: The rolling optimizer plans against **expected dwell + transit** derived from the timing model — folding them into the time-expanded graph's trip travel (`OptimizerRoute.travelMin`) and a hub **service-time** offset — instead of fixed 15-min steps with flat dwell. A change to the timing config produces a correspondingly different plan.
- [ ] **OPT-10**: The optimizer's per-leg/per-hub planning estimate is derived **deterministically** from the timing distribution config via a single shared estimator (`expectedMinutes` = clamped `median·exp(σ²/2)`, the distribution **mean**), so planner output is reproducible and the same config drives both the simulator's random draw and the planner's estimate (DRY).

### Realistic time model (TIME)
- [ ] **TIME-01**: Per-leg transit **medians are derived from real route distance/geography** (precomputed road distance ÷ representative HGV speed), so each leg has a distance-appropriate transit distribution rather than a single flat ~30-min median.
- [ ] **TIME-02**: A distinct **center-hub re-dispatch dwell** is modeled (cross-dock unload → re-sort → re-dispatch) so the wired-but-unused `dwellCenter` distribution applies at the center, separate from spoke dwell — with exactly one dwell applied per stop (no double-count).

### Visualization (VIZ)
- [ ] **VIZ-06**: Route geometry **follows real roads** — trailers animate along precomputed OpenRouteService `driving-hgv` polylines (committed as static GeoJSON to preserve determinism) instead of straight great-circle arcs; downstream ws/animation is unchanged (geometry stays `[lon,lat][]`).

### Hardening (HRD)
- [ ] **HRD-01**: `parseEnvelope` **tolerates a missing `speed` field**, falling back to a `DEFAULT_SPEED` (with a one-time warning) so a partial/older server envelope still animates the map — while still rejecting genuinely malformed envelopes (bad `v`/`type`/`seq`/`simMs`/`payload`).

### Quality (QA)
- [ ] **QA-01**: Coverage top-up — the `wsClient` socket path (`useWsEnvelope`: open-once, seq-gap→resync, snapshot-replace, tick-apply) and overall **branch** coverage are raised toward the project bar with **behavior-asserting** tests (no metric gaming).

## Out of Scope (v1.1)

- **Full stochastic / robust optimization** (scenario sampling, Monte-Carlo planning, chance constraints) — v1.1 uses a single deterministic expected-value estimate; robust optimization remains out of scope.
- **Service-level / percentile planning estimate** — the **mean** is the v1.1 estimator; a configurable p-percentile safety margin is a future knob, not this milestone.
- **Runtime / live routing** (OSRM/Valhalla self-host, live ORS calls, time-of-day traffic) — road data is precomputed offline and committed; no network in the sim/plan hot path.
- **HGV hours-of-service / legally-mandated break modeling** — average overhead is absorbed into medians.
- Carried-forward v1.0 deferrals (live 8-metric A/B money slide, durable idempotency, ws-connection consolidation, true-volume utilization) — tracked in `milestones/v1.0-MILESTONE-AUDIT.md`; not pulled into v1.1 unless a phase touches them incidentally.

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| OPT-09 | _(filled by roadmap)_ | Planned |
| OPT-10 | _(filled by roadmap)_ | Planned |
| TIME-01 | _(filled by roadmap)_ | Planned |
| TIME-02 | _(filled by roadmap)_ | Planned |
| VIZ-06 | _(filled by roadmap)_ | Planned |
| HRD-01 | _(filled by roadmap)_ | Planned |
| QA-01 | _(filled by roadmap)_ | Planned |
