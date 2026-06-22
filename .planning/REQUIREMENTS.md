# Requirements: v1.2 — Driver HOS & Hub Detail

**Milestone goal:** Model driver Hours-of-Service (HOS) duty cycles end-to-end — **fully enforced** in both the deterministic simulation and the rolling-horizon optimizer, using the **full FMCSA** rule set, with **driver relay/swap at hubs** — and surface live hub operations (trucks present, status, cargo, dwell, next hop, driver duty + remaining legal drive time) through a **click-to-open Hub Detail panel**.

**Keystone constraint — determinism:** HOS-*off* must remain byte-identical to the pre-v1.2 golden replay; HOS-*on* adds a new golden. All HOS randomness flows through a single new isolated seeded RNG substream (salt collision-asserted against the existing `0x5f1da7c3` / `0x3ca71d5f` / `0x00007717`). Reducers key off `occurredAt` (virtual clock), never wall-clock.

> Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` and `.planning/research/v1.2-HUB-DETAIL-GROUNDING.md` (adversarially verified codebase + FMCSA analysis). Verifiers rated the full build EPIC (~3–5 weeks); optimizer HOS-enforcement is the riskiest slice.

---

## v1.2 Requirements

### Driver model (DRV)

- [ ] **DRV-01**: A `Driver` domain entity exists (`driverId`, optional `name`/`licenseClass`, `dutyStatus` ∈ {driving, on_break, resting, off_duty}) as a zod schema in `@mm/domain`; the inferred type is the single source of truth (DRY with event payloads).
- [ ] **DRV-02**: An `HosClock` value-object tracks per-driver integer-minute state (`driveTodayMin`, `dutyWindowStartAt`, `sinceLastBreakMin`, `weeklyOnDutyMin`, `comeOnDutyAt`, plus sleeper-berth split accumulators).
- [ ] **DRV-03**: The `Trip` entity carries an optional `driverId`; a trip may be unassigned (back-compat) or bound to exactly one driver.
- [ ] **DRV-04**: Each hub maintains a driver pool/roster so a fresh driver can be selected for relay/swap assignment.

### HOS engine (HOS)

- [ ] **HOS-01**: An `HosConfig` (beside `TimingConfig` in `@mm/domain`) holds the full-FMCSA constants — `maxDriveMin=660` (11h), `dutyWindowMin=840` (14h), `breakAfterDriveMin=480` (8h), `minBreakMin=30`, `resetOffDutyMin=600` (10h), `weeklyCapMin=4200` (70h/8-day), `restartMin=2040` (34h), and sleeper-berth split parameters (7/3 and 8/2).
- [ ] **HOS-02**: A pure, deterministic forward-labeling HOS engine: given an `HosClock` and a driving leg of N minutes, it returns the legal sequence (drive / insert 30-min break / insert 10h rest / apply sleeper-berth split) and the updated clock. Identical inputs → identical output. **Shared by simulation and optimizer (single module, DRY).**
- [ ] **HOS-03**: `remainingLegalDriveMinutes = min(maxDriveMin−driveTodayMin, dutyWindowDeadline−now, breakAfterDriveMin−sinceLastBreakMin)` clamped ≥0; "may drive now" iff remaining>0 **and** `weeklyOnDutyMin < weeklyCapMin`. The 14h window is **elapsed wall-clock** (an absolute deadline; it does NOT pause for breaks/dwell).

### Duty & phase events (EVT)

- [ ] **EVT-01**: New driver-lifecycle events join the closed domain-event union with per-event zod schemas — `DriverRegistered`, `DriverAssignedToTrip`, `DriverDutyStateChanged` (carries reason + clock snapshot), `DriverSwappedAtHub` (relay handoff). `contract.assert.ts` and validation tests pass.
- [ ] **EVT-02**: Authoritative load/unload phase events join the union — `UnloadStarted`, `LoadStarted`, `UnloadCompleted` (carry `trailerId`, `hubId`, `tripId`, `occurredAt`; no RNG) — giving true trailer status.

### Simulation enforcement (SIM-HOS)

- [ ] **SIM-HOS-01**: A fifth isolated seeded RNG substream (`hosRng = seed XOR <new distinct salt>`) is added in `engine.ts`, with a test asserting the salt does not collide with the rfid/over-carry/timing salts.
- [ ] **SIM-HOS-02**: On `TrailerDeparted` the sim assigns a legal driver and emits `DriverAssignedToTrip` + `DriverDutyStateChanged(driving)`; driving minutes accrue across transit ticks into the driver's `HosClock`.
- [ ] **SIM-HOS-03**: Before each next departure the sim runs the HOS engine; on a would-be breach it injects a 30-min break or 10h rest (or sleeper-berth split) as scheduled queue time drawn from `hosRng` at deterministic evaluation time, emitting duty-state transitions.
- [ ] **SIM-HOS-04**: Driver relay/swap at hubs — when the assigned driver lacks legal hours to continue, the trailer is handed to a fresh driver from the hub pool (`DriverSwappedAtHub`), deterministically; the tired driver enters rest.
- [ ] **SIM-HOS-05**: The sim emits `UnloadStarted` after `TrailerDocked`, `UnloadCompleted` after the last unload scan, and `LoadStarted` before `TrailerDeparted`, in deterministic event-queue order.
- [ ] **SIM-HOS-06**: Determinism holds — same seed + same `HosConfig` yields a byte-identical stream; with HOS disabled the stream is byte-identical to the pre-v1.2 golden; a new HOS-on golden-replay test is added.

### Driver-status projection (PRJ)

- [ ] **PRJ-01**: A pure `driverStatusReducer` folds the driver events into one row per driver — `status`, `remainingDriveMinutes`, `dutyWindowDeadline`, `totalDrivenMinutes`, `weeklyOnDutyMin`, `currentHubId`, `currentTripId`, `lastEventAt` — deterministically (id-sorted).
- [ ] **PRJ-02**: `DriverStatusTable` + `DriverAssignmentTable` interfaces and idempotent DDL are added to projections, registered as OPERATIONAL (read-your-writes) and threaded through the inline runner; `driver_id` is added to `trailer_state`, and an index on `trailer_state(current_hub_id)` backs hub-scoped queries.

### Optimizer HOS (OPT-HOS)

- [ ] **OPT-HOS-01**: The rolling-epoch snapshot consumes `DriverStatus`; the objective soft-prefers drivers with more remaining hours via a `restCost` weight.
- [ ] **OPT-HOS-02**: Hard enforcement — an optional `restMin` on `Stop` folds into `serviceMin` in `feasibility.ts` (rest-as-time; no new graph edge kind), and a hard gate in route planning rejects any leg the assigned driver cannot legally complete, reusing the proven Phase-2 LIFO validation-gate pattern. Reuses the same HOS engine (HOS-02).
- [ ] **OPT-HOS-03**: When HOS makes an assignment infeasible, the optimizer surfaces an `insertRestStop` or driver-relay recommendation through the existing `localRepair → EpochRecommendation` path.

### Hub-detail read model & API (HUBQ)

- [ ] **HUBQ-01**: `GET /api/hubs/:id/detail` returns the trailers currently at the hub (`current_hub_id = :id`) with each trailer's status, `dock_door_id`, assigned packages, and assigned-driver duty status + remaining legal drive minutes.
- [ ] **HUBQ-02**: The trailers-at-hub query is backed by an index on `trailer_state(current_hub_id)` (no full-table scan per hub click).
- [ ] **HUBQ-03**: For each trailer the response includes a load-plan summary (and on demand the full rear→nose plan), reusing the existing Phase-2 `planLoad` reconstruction via a shared helper extracted from `plan-detail.ts` (DRY).
- [ ] **HUBQ-04**: Each trailer entry includes a utilization ratio computed the slice-aware way — `Σ(slice.usedVolume) / Σ(slice.capacityVolume)` (NOT `volume/50`) — and the same field is added to the existing `TrailerPlanDto` for VIZ-05 parity.
- [ ] **HUBQ-05**: Each trailer entry includes `arrivedAtMs`, derived from the most recent `TrailerArrivedAtHub` event for `(trailer_id, hub_id)` in `audit_timeline` (the response must NOT use `last_event_at`), so the client computes live elapsed dwell against ws `simMs`.
- [ ] **HUBQ-06**: Each trailer entry includes `nextHubId`, derived from assigned packages' `nextUnloadHubId` via the existing `buildRoute` reconstruction (null when no onward route can be derived).
- [ ] **HUBQ-07**: Each trailer entry includes an estimated time-to-depart / ETA to next hub = `arrivedAtMs + expected dwell (HosConfig/TimingConfig, hub role) + expected transit (next leg)`, explicitly labelled an estimate; trailers already in transit use the existing ws `etaMs` (no fabricated server estimate).
- [ ] **HUBQ-08**: The ws `HubState` envelope carries small integer driver buckets (`driverCount`, `onBreakCount`, `restingCount`) so the map can color hubs by driver duty distribution; the detail DTO stays stable across REST and ws.

### Hub Detail panel UI (VIZ)

- [ ] **VIZ-07**: Clicking a hub icon opens a Hub Detail panel in the right rail, mirroring the VIZ-05 trailer-selection flow, with hub name/id in the header.
- [ ] **VIZ-08**: The panel lists each trailer at the hub in a compact row — operational status, dock door, live elapsed dwell (`simMs − arrivedAtMs`), utilization %, next hub + estimated ETA, and the assigned driver's duty status + remaining legal drive time (shown as both a number and a bucket).
- [ ] **VIZ-09**: Expanding a trailer row (or click-through) shows its full rear→nose load order, loading instructions, and explanation, reusing the exact VIZ-05 `TrailerDetail` rendering.
- [ ] **VIZ-10**: The panel shows open exceptions tied to each trailer (ws `exceptionsOpen` filtered by `entityId`) and hub-scoped exceptions via the detail endpoint.
- [ ] **VIZ-11**: Hub markers on the map are styled by driver duty distribution from the ws buckets (e.g. a hub whose drivers are all resting reads distinctly).

### Documentation (DOC)

- [ ] **DOC-01**: `README.md` lists the supported features across v1.0–v1.2 (operational twin, load planner, RFID validation, optimizer, realistic time model, driver HOS, Hub Detail panel).
- [ ] **DOC-02**: `README.md` embeds screenshots of the live USA map, the Hub Detail panel, and driver duty/HOS in action (captured from the running UI).

---

## Future Requirements (deferred)

- Persistent durable idempotency for `(epoch, scopeHash)` (restart durability) — carried v1.0 debt.
- True volume-based trailer utilization in the optimizer twin (vs package-count proxy) — carried v1.0 debt.
- Live 8-metric A/B "money slide" (vs the calibrated seed-42 2-metric) — deferred from v1.0.
- Team-driver (two-driver) extended-limit modeling.
- HOS adverse-driving 2-hour extension and short-haul 150-air-mile exemption.

## Out of Scope (v1.2)

- **Real ELD / telematics integration** — HOS is simulated and deterministic, not sourced from hardware.
- **EU / non-US duty rules** — model US FMCSA (49 CFR Part 395) only.
- **60h/7-day weekly variant** — pick the single 70h/8-day cap to avoid a carrier-type branch.
- **Exact MILP driver-scheduling (VRTDSP branch-and-price)** — out per the no-MILP constraint; HOS is enforced as heuristic feasibility checks (Goel & Kok forward-labeling is polynomial).
- **Real WMS/TMS or RFID hardware integration** — still simulation-driven.

---

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| _(populated by roadmapper)_ | | |
