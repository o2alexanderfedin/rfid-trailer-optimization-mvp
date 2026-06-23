# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Milestones

- ✅ **v1.0 MVP** — Phases 1–5 (shipped 2026-06-20) — full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Realistic Time Model + Hardening** — Phases 6–8 (shipped 2026-06-22) — full details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 Driver HOS & Hub Detail** — Phases 9–18 (in progress)

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

### 🚧 v1.2 Driver HOS & Hub Detail (Phases 9–18)

> **Keystone constraint:** determinism. HOS-*off* stays byte-identical to the pre-v1.2 golden replay; HOS-*on* adds a new golden. All HOS RNG flows through one new isolated seeded substream. Grounding: `research/v1.2-DRIVER-HOS-GROUNDING.md`, `research/v1.2-HUB-DETAIL-GROUNDING.md`.

- [x] **Phase 9: Driver model + HOS config + duty/phase events** — Driver entity, HosClock, full-FMCSA HosConfig, driver + load/unload events ✅ 2026-06-22
- [x] **Phase 10: Pure forward-labeling HOS engine** — deterministic drive/break/rest engine shared by sim + optimizer ✅ 2026-06-22
- [x] **Phase 11: Sim HOS enforcement + load/unload events + golden** — 5th RNG substream; HOS-off byte-identical to pre-v1.2 golden ✅ 2026-06-22
- [x] **Phase 12: Driver relay / swap at hubs** — per-hub driver pools, deterministic handoffs ✅ 2026-06-22
- [x] **Phase 13: Driver-status projection + tables** — OPERATIONAL read-model feeding hub-detail ✅ 2026-06-22
- [x] **Phase 14: Hub-detail endpoint + ws driver buckets** — GET /api/hubs/:id/detail aggregation ✅ 2026-06-22
- [x] **Phase 15: Optimizer HOS-aware** — consume driver status, soft restCost preference ✅ 2026-06-22
- [ ] **Phase 16: Optimizer HOS-enforced** — hard legal-drive gate, rest-as-serviceMin, relay recommendation
- [ ] **Phase 17: Hub Detail panel UI + map duty styling** — clickable hub → compact panel + click-through
- [ ] **Phase 18: README features + screenshots** — supported-features list + live screenshots

## Phase Details (v1.2)

### Phase 9: Driver model + HOS config + duty/phase events

**Goal**: Introduce the `Driver` entity, `HosClock`, and full-FMCSA `HosConfig`, plus the new closed-union events (driver lifecycle + authoritative load/unload phase events), with zod schemas and contract tests green.
**Depends on**: Phase 8 (v1.1 baseline)
**Requirements**: DRV-01, DRV-02, DRV-03, HOS-01, EVT-01, EVT-02

**Success criteria**:
1. `Driver` + `HosClock` + `HosConfig` zod schemas exist in `@mm/domain`; full-FMCSA constants present (660/840/480/30/600/4200/2040 + sleeper-split params).
2. New events (`DriverRegistered`/`DriverAssignedToTrip`/`DriverDutyStateChanged`/`DriverSwappedAtHub`, `UnloadStarted`/`LoadStarted`/`UnloadCompleted`) join the closed union; `contract.assert.ts` + validation tests pass.
3. `Trip` carries optional `driverId` with existing fixtures still valid (back-compat).
4. typecheck / lint / build green.

### Phase 10: Pure forward-labeling HOS engine (shared sim + optimizer)

**Goal**: A deterministic HOS engine (drive / break / rest / sleeper-split sequencing + remaining-legal-drive) as a pure `@mm/domain` module reused by both sim and optimizer (DRY).
**Depends on**: Phase 9
**Requirements**: HOS-02, HOS-03

**Success criteria**:
1. Given an `HosClock` + driving leg, the engine returns the legal sequence + updated clock; identical inputs → identical output (property test).
2. 14h window enforced as an elapsed wall-clock deadline — a break does NOT extend it (explicit unit test).
3. Sleeper-berth 7/3 & 8/2 splits handled; 70h/8-day weekly cap + 34h restart enforced.
4. `remainingLegalDriveMinutes` + "may drive now" correct across boundary cases.

### Phase 11: Sim HOS enforcement + load/unload events + determinism golden

**Goal**: The sim assigns drivers per trip, accrues duty time, injects mandatory rest/breaks, and emits duty + load/unload phase events — deterministically, via a 5th RNG substream, with HOS-off byte-identical to the pre-v1.2 golden and a new HOS-on golden.
**Depends on**: Phase 10
**Requirements**: SIM-HOS-01, SIM-HOS-02, SIM-HOS-03, SIM-HOS-05, SIM-HOS-06

**Success criteria**:
1. 5th `hosRng` substream added; salt-collision test passes (no clash with `0x5f1da7c3`/`0x3ca71d5f`/`0x00007717`).
2. Drivers accrue driving minutes; 30-min break / 10h rest injected on breach with duty-state transitions emitted.
3. Load/unload phase events emitted in deterministic event-queue order.
4. Same seed + `HosConfig` → byte-identical stream; **HOS-off byte-identical to pre-v1.2 golden**; new HOS-on golden-replay test green.

### Phase 12: Driver relay / swap at hubs

**Goal**: Per-hub driver pools enable deterministic relay — when a driver is out of legal hours, the trailer is handed to a fresh driver at the hub so freight keeps moving.
**Depends on**: Phase 11
**Requirements**: DRV-04, SIM-HOS-04

**Success criteria**:
1. Each hub maintains a driver pool; a fresh driver is selected deterministically on handoff.
2. `DriverSwappedAtHub` emitted; the tired driver enters rest; the trailer continues.
3. Relay path preserves determinism (golden extended/updated and green).

### Phase 13: Driver-status projection + tables

**Goal**: A pure driver-status read model (status, remaining drive minutes, duty-window deadline, current hub/trip) with OPERATIONAL tables, feeding the hub-detail endpoint.
**Depends on**: Phase 12
**Requirements**: PRJ-01, PRJ-02

**Success criteria**:
1. `driverStatusReducer` folds driver events into one deterministic row per driver.
2. `DriverStatusTable` + `DriverAssignmentTable` DDL; registered OPERATIONAL (read-your-writes); `driver_id` on `trailer_state`; index on `trailer_state(current_hub_id)`.
3. Live == rebuilt (replay determinism) for driver state.

### Phase 14: Hub-detail endpoint + ws driver buckets

**Goal**: `GET /api/hubs/:id/detail` aggregates trailers-at-hub with status, cargo summary, utilization, dwell, next hub, estimated ETA, and driver duty; ws `HubState` carries driver buckets.
**Depends on**: Phase 13
**Requirements**: HUBQ-01, HUBQ-02, HUBQ-03, HUBQ-04, HUBQ-05, HUBQ-06, HUBQ-07, HUBQ-08

**Success criteria**:
1. Endpoint returns trailers at the hub with status / dock / assigned-driver duty + remaining legal drive time.
2. Load-plan summary via the shared `planLoad` helper; **slice-based** utilization; dwell from `audit_timeline` (not `last_event_at`); `nextHubId` via `buildRoute`; ETA labelled an estimate.
3. `trailer_state(current_hub_id)` index backs the query (no full-table scan).
4. ws `HubState` carries `driverCount` / `onBreakCount` / `restingCount`; DTO stable across REST and ws.

### Phase 15: Optimizer HOS-aware

**Goal**: The rolling optimizer consumes driver status and soft-prefers drivers with more remaining hours.
**Depends on**: Phase 13 (projection) + Phase 10 (engine)
**Requirements**: OPT-HOS-01

**Success criteria**:
1. The rolling-epoch snapshot includes `DriverStatus`.
2. A `restCost` objective weight soft-prefers higher-remaining-hours drivers; default weight reproduces prior plans (deterministic).
3. glpk LP oracle + planner-vs-validator property tests stay green.

### Phase 16: Optimizer HOS-enforced

**Goal**: Hard HOS enforcement — rest-as-`serviceMin` feasibility, reject illegal legs (reusing the Phase-2 LIFO validation-gate pattern), and insert-rest / relay recommendations via local repair.
**Depends on**: Phase 15
**Requirements**: OPT-HOS-02, OPT-HOS-03

**Success criteria**:
1. Optional `restMin` folds into `serviceMin` in `feasibility.ts` — no new graph edge kind.
2. A hard gate rejects any leg the assigned driver cannot legally complete (reuses the same HOS engine).
3. `localRepair` surfaces an `insertRestStop` / driver-relay recommendation via `EpochRecommendation` when HOS makes an assignment infeasible.
4. Determinism + glpk oracle tests green; integer arithmetic preserved.

### Phase 17: Hub Detail panel UI + map duty styling

**Goal**: Clickable hub → compact Hub Detail panel (status, dwell, util, next hub + ETA, driver duty + remaining drive time) with click-through to the existing VIZ-05 trailer plan; hub markers colored by driver duty distribution.
**Depends on**: Phase 14 (endpoint)
**Requirements**: VIZ-07, VIZ-08, VIZ-09, VIZ-10, VIZ-11

**Success criteria**:
1. Clicking a hub opens the panel (mirrors the VIZ-05 selection flow); header shows hub name/id.
2. Compact rows show status, live elapsed dwell (`simMs − arrivedAtMs`), utilization %, next hub + estimated ETA, and driver duty + remaining drive time (number + bucket).
3. Expanding a row / click-through shows the full VIZ-05 rear→nose plan; open exceptions shown.
4. Hub markers styled by the ws driver-duty buckets.

### Phase 18: README features + screenshots

**Goal**: README documents the supported features across v1.0–v1.2 with screenshots of the live map, Hub Detail panel, and driver HOS in action.
**Depends on**: Phase 17
**Requirements**: DOC-01, DOC-02

**Success criteria**:
1. README lists supported features across v1.0–v1.2, accurate to shipped code.
2. Screenshots of the live USA map, the Hub Detail panel, and driver duty/HOS embedded (captured from the running UI).

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Operational Data Foundation + Live Map Spike | v1.0 | 7/7 | ✅ Complete | 2026-06-19 |
| 2. Load Planning | v1.0 | 6/6 | ✅ Complete | 2026-06-19 |
| 3. RFID-Assisted Validation | v1.0 | 7/7 | ✅ Complete | 2026-06-19 |
| 4. Rolling Optimizer | v1.0 | 6/6 | ✅ Complete | 2026-06-19 |
| 5. Simulation + Visualization Wrapper | v1.0 | 8/8 | ✅ Complete | 2026-06-19 |
| 6. Realistic Geography & Time Model | v1.1 | — | ✅ Complete | 2026-06-21 |
| 7. Time-Aware Optimizer | v1.1 | — | ✅ Complete | 2026-06-21 |
| 8. Client Hardening & Coverage | v1.1 | — | ✅ Complete | 2026-06-22 |
| 9. Driver model + HOS config + duty/phase events | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 10. Pure HOS engine (shared sim+optimizer) | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 11. Sim HOS enforcement + load/unload events + golden | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 12. Driver relay / swap at hubs | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 13. Driver-status projection + tables | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 14. Hub-detail endpoint + ws driver buckets | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 15. Optimizer HOS-aware | v1.2 | 1/1 | ✅ Complete | 2026-06-22 |
| 16. Optimizer HOS-enforced | v1.2 | 0/— | ⬜ Not started | — |
| 17. Hub Detail panel UI + map duty styling | v1.2 | 0/— | ⬜ Not started | — |
| 18. README features + screenshots | v1.2 | 0/— | ⬜ Not started | — |
