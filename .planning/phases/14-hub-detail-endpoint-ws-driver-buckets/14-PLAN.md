---
phase: 14
title: Hub-detail endpoint + ws driver buckets
milestone: v1.2
status: complete
requirements: [HUBQ-01, HUBQ-02, HUBQ-03, HUBQ-04, HUBQ-05, HUBQ-06, HUBQ-07, HUBQ-08]
---

# Phase 14 — Plan

## Goal

`GET /api/hubs/:id/detail` aggregates everything the (Phase-17) Hub Detail panel
needs — trailers at the hub with status, dock door, assigned packages, bound-driver
duty + remaining legal drive minutes, a load-plan summary (rear→nose + slice-aware
utilization), arrival time, next hub, and an explicitly-estimated ETA — plus ws
`HubState` driver buckets for map coloring. Pure read-layer over existing
projections + the immutable log; no sim/optimizer behavior change.

## Approach (TDD: tests first → green → refactor)

### Task 1 — Shared load-plan reconstruction helper (HUBQ-03, DRY)
Extract the `plan-detail.ts` reconstruction (`buildBlocks` / `buildRoute` /
`toRearToNose` / `planLoad`) into `packages/api/src/routes/load-plan-helper.ts`
as `reconstructTrailerPlan(...)`, plus the shared DB readers
`readHubOutboundIndex` / `readRouteDestHubs`. Both `/trailers/:id/plan` and the
new hub-detail route call it — neither re-implements the shaping.

- Export `utilizationFraction` from `@mm/load-planner` (was private) as the single
  source of the slice-aware ratio `Σ usedVolume / Σ capacityVolume` (HUBQ-04);
  `utilizationScore` already derives from it, so the displayed ratio and the
  optimizer penalty never diverge.
- Refactor `plan-detail.ts` to consume the helper and add the additive
  `utilization` field to `TrailerPlanDto` (VIZ-05 parity — preserve existing tests).

### Task 2 — `GET /hubs/:id/detail` route (HUBQ-01/02/05/06/07)
New `packages/api/src/routes/hub-detail.ts`, mirroring `queries.ts` /
`plan-detail.ts` conventions (thin handler, schema-validated `:id`, single
parameterized reads, stable DTO):

- Trailers `WHERE current_hub_id = :id` (index-backed; HUBQ-01/02), each with
  `status`, `dockDoorId`, `assignedPackageIds`.
- Driver join `trailer_state.driver_id → driver_status` (one `IN (...)` query) →
  `{ driverId, dutyStatus, remainingDriveMinutes }` or `null` (HUBQ-01).
- Per-trailer summary via the shared helper → `rearToNose`, `utilization`,
  `nextHubId` (HUBQ-03/04/06).
- `arrivedAtMs` = most recent `TrailerArrivedAtHub` for `(trailer_id, hub_id)` in
  `audit_timeline` (`ORDER BY global_seq DESC LIMIT 1`) — NOT `last_event_at`
  (HUBQ-05).
- `estimatedEtaMs` for PARKED trailers = `arrivedAtMs + expectedDwell(hubRole) +
  expectedTransit(currentHub→nextHub)`, flagged `etaIsEstimate`; in-transit →
  `null` (use ws `etaMs`) (HUBQ-07). Hub role from a local center-hub derivation
  (degree over `RouteRegistered` legs, mirroring `twin-snapshot.ts`).
- Unseen hub → `{ hubId, trailers: [] }` (not 404). Trailers sorted by id (P3).

Wire in `server.ts`; export the registrar + DTOs from `index.ts`.

### Task 3 — ws `HubState` driver buckets (HUBQ-08)
- Add optional `driverCount` / `onBreakCount` / `restingCount` to `HubState`
  (back-compat additive — old clients ignore them, an old server's absent fields
  read as 0 via `?? 0`); extend `hubChanged` so tick deltas carry bucket changes.
- Extract the pure `driverBucketsPerHub(trailerRows, driverRows)` tally (exported
  for unit testing) and call it from `buildSnapshotPayload`, which now also reads
  `trailer_state(current_hub_id, driver_id)` + `driver_status(driver_id, status)`.

## Tests

- `routes/hub-detail.test.ts` (inject + fake DB): HUBQ-01..07, driver join,
  HUBQ-05 audit source (not `last_event_at`), HUBQ-07 estimate labelling, empty
  hub, P3 sort, `:id` validation.
- `routes/plan-detail.test.ts`: additive `utilization` assertion (HUBQ-04 parity).
- `scoring.test.ts`: `utilizationFraction` (HUBQ-04 single source).
- `ws/envelope.test.ts`: HUBQ-08 driver-bucket diffs + back-compat (absent = 0).
- `ws/snapshots.test.ts`: `driverBucketsPerHub` unit coverage.
- `test/hub-detail.int.test.ts` (testcontainers): controlled inline-append
  scenario over real Postgres — HUBQ-01..08 end-to-end, incl. EXPLAIN proving the
  `current_hub_id` index path (HUBQ-02) and ws driver buckets via the real
  `buildSnapshotPayload`.

## Hard constraints

Pure read-layer: confirm sim determinism goldens + the Phase-13 driver-status
golden replay still pass. Strict TS, no `any`. DRY (shared helper), KISS. Additive
ws field — keep existing envelope/snapshot tests green.

## Gate

`pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test:all` (unit +
integration + ui) ALL green.
