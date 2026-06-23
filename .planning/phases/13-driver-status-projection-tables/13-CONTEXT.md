# Phase 13: Driver-status projection + tables - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; projection read-model, has replay-determinism integration test)

<domain>
## Phase Boundary

Build the **driver-status read model** in `@mm/projections`: a pure reducer folding the driver events into one row per driver, with OPERATIONAL (read-your-writes) Postgres tables, feeding the Phase-14 hub-detail endpoint. Plus the supporting schema changes (`driver_id` on `trailer_state`, `current_hub_id` index).

**In scope:** PRJ-01 (`driverStatusReducer` + driver-status row shape), PRJ-02 (`DriverStatusTable` + `DriverAssignmentTable` DDL, OPERATIONAL registration, inline-runner upserts, `trailer_state.driver_id`, `trailer_state(current_hub_id)` index).
**OUT of scope:** the hub-detail endpoint/ws buckets (Phase 14), optimizer (15–16), UI (17).
</domain>

<decisions>
## Implementation Decisions

### driverStatusReducer (PRJ-01)
- Pure reducer (mirror `reducers/trailer-state.ts`) folding `DriverRegistered`/`DriverAssignedToTrip`/`DriverDutyStateChanged`/`DriverSwappedAtHub` into ONE deterministic row per driver: `driverId`, `status` (driving/on_break/resting/off_duty), `remainingDriveMinutes`, `dutyWindowDeadline`, `totalDrivenMinutes`, `weeklyOnDutyMin`, `currentHubId`, `currentTripId`, `lastEventAt`.
- Derive `remainingDriveMinutes`/`dutyWindowDeadline` from the latest `HosClock` snapshot (carried in `DriverDutyStateChanged`) using the **Phase-10** `@mm/domain` engine (`remainingLegalDriveMinutes`) — reuse, don't reimplement. Keys off `occurredAt`, never wall-clock. Deterministic (id-sorted where ordering matters, like existing reducers' `compareIds`).
- A `DriverAssignmentTable` row tracks driver↔trip/trailer assignment (for join-free hub-detail queries).

### Tables + runner (PRJ-02)
- Add `DriverStatusTable` + `DriverAssignmentTable` Kysely interfaces + **idempotent** DDL to `schema.ts` / `schema.sql` (mirror existing OPERATIONAL tables like `trailer_state`).
- Register both as **OPERATIONAL** (read-your-writes — not CATCHUP) and thread their upserts through `runner/inline.ts` (and TRUNCATE/rebuild in `runner/rebuild.ts`) following the existing pattern.
- Add `driver_id` column to `trailer_state` (stamped from `DriverAssignedToTrip`/`DriverSwappedAtHub` so the assigned driver is queryable join-free), and an index on `trailer_state(current_hub_id)` (the hub-scoped query backing for Phase 14 — no full-table scan).

### Replay determinism (PRJ-02 success criterion 3)
- Live == rebuilt: an integration test (testcontainers Postgres, mirroring the existing golden-replay integration test) proving the driver-status projection rebuilt from the event log byte-matches the live-applied state.

### Claude's Discretion
Exact column types, OPERATIONAL registration mechanics, whether driver-status is one table or split — follow existing `@mm/projections` conventions. **TDD mandatory** (unit reducer tests + the replay-determinism integration test).
</decisions>

<code_context>
## Existing Code Insights

### Reuse / analogs
- `packages/projections/src/reducers/trailer-state.ts` (FND-06) — the closest analog: one-row-per-entity reducer (`trailerId`, `status`, `currentHubId`, `tripId`, `dockDoorId`, `assignedPackageIds`, `lastEventAt`); also where `driver_id` stamping is added.
- `packages/projections/src/reducers/hub-inventory.ts`, `reducer.ts`, `index.ts` — reducer registration patterns.
- `packages/projections/src/schema.ts` + `schema.sql` — table interfaces + DDL (mirror an OPERATIONAL table).
- `packages/projections/src/runner/inline.ts` — OPERATIONAL upsert threading; `runner/rebuild.ts` — rebuild/TRUNCATE; `runner/catchup.ts`.
- `@mm/domain` Phase-10 `remainingLegalDriveMinutes`/`mayDriveNow`; Phase-9 driver events.
- The existing golden-replay integration test (api/projections) — pattern for the live==rebuilt driver-status test.

### Established Patterns
- Pure reducers fold → upsert; `compareIds` determinism; OPERATIONAL vs CATCHUP split; idempotent DDL; events key off `occurredAt`.
</code_context>

<specifics>
## Specific Ideas

Reqs: **PRJ-01, PRJ-02**. Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` (projections integration row) and `.planning/research/v1.2-HUB-DETAIL-GROUNDING.md` (the `current_hub_id` index + `driver_id` on `trailer_state` were flagged there). This read model is consumed by the Phase-14 `GET /api/hubs/:id/detail` endpoint — design the row to carry what that panel needs (driver duty status + remaining legal drive time).
</specifics>

<deferred>
## Deferred Ideas
- `GET /api/hubs/:id/detail` endpoint + ws `HubState` driver buckets → Phase 14.
</deferred>
