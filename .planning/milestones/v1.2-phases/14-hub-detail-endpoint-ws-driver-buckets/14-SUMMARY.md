---
phase: 14
title: Hub-detail endpoint + ws driver buckets
milestone: v1.2
status: complete
requirements: [HUBQ-01, HUBQ-02, HUBQ-03, HUBQ-04, HUBQ-05, HUBQ-06, HUBQ-07, HUBQ-08]
---

# Phase 14 — Summary

## What shipped

A new `GET /api/hubs/:id/detail` read endpoint and ws `HubState` driver buckets,
backing the (Phase-17) Hub Detail panel. All over existing projections + the
immutable event log — a pure read-layer, no sim/optimizer behavior change.

### `GET /hubs/:id/detail` (`packages/api/src/routes/hub-detail.ts`)
Returns the trailers currently at a hub (`trailer_state WHERE current_hub_id=:id`,
index-backed), each with:
- `status`, `dockDoorId`, `assignedPackageIds` (HUBQ-01).
- `driver`: the bound driver's `dutyStatus` + `remainingDriveMinutes` via a single
  `trailer_state.driver_id → driver_status` `IN (...)` join, or `null` (HUBQ-01).
- `rearToNose` + `utilization` (slice-aware `Σ usedVolume / Σ capacityVolume`) +
  `nextHubId`, all from the shared reconstruction helper (HUBQ-03/04/06).
- `arrivedAtMs` from the most recent `TrailerArrivedAtHub` in `audit_timeline`
  (`ORDER BY global_seq DESC LIMIT 1`) — NOT `last_event_at` (HUBQ-05).
- `estimatedEtaMs` + `etaIsEstimate` for parked trailers
  (`arrivedAtMs + expected dwell(hub role) + expected transit(next leg)`);
  in-transit trailers get no fabricated estimate (HUBQ-07).

Unseen hub → `{ hubId, trailers: [] }` (not 404); trailers id-sorted (P3).

### Shared helper (`packages/api/src/routes/load-plan-helper.ts`) — DRY
The `plan-detail.ts` reconstruction (`buildBlocks` / `buildRoute` / `toRearToNose`
/ `planLoad`) is now single-sourced as `reconstructTrailerPlan(...)`, plus the DB
readers `readHubOutboundIndex` / `readRouteDestHubs`. `plan-detail.ts` was
refactored to consume it; `TrailerPlanDto` gained the additive `utilization`
field (HUBQ-04, VIZ-05 parity preserved). `utilizationFraction` is now exported
from `@mm/load-planner` as the single source of the ratio.

### ws driver buckets (`packages/api/src/ws/{envelope,snapshots}.ts`) — HUBQ-08
`HubState` gained optional `driverCount` / `onBreakCount` / `restingCount`
(back-compat additive; `hubChanged` compares them with `?? 0`).
`buildSnapshotPayload` now reads `trailer_state` + `driver_status` and tallies the
buckets via the exported pure `driverBucketsPerHub(...)` — the same trailer→driver
join the REST endpoint performs, reduced to counts for map coloring. The REST DTO
stays distinct from (and richer than) the ws buckets.

## Key decisions / corrections honored
- **Dwell trap**: `arrivedAtMs` reads `audit_timeline`, never `last_event_at`
  (which advances on later events and under-reports dwell). Proven by a test that
  seeds a later `TrailerDocked` + a later `last_event_at` and asserts neither wins.
- **Slice-aware utilization**: reused/extended `utilizationFraction` (not a flat
  `volume/50`); same function `utilizationScore` already derives from (DRY).
- **ETA is an estimate**: explicitly flagged `etaIsEstimate`; in-transit trailers
  carry `null` (the ws `etaMs` covers them).
- **Back-compat ws**: driver buckets are OPTIONAL so the versioned envelope and
  every existing snapshot/envelope test stay valid unchanged.
- **`nextHubId` semantics**: when packages are indexed as outbound at a hub their
  next-unload hub is that hub (same reconstruction the trailer-plan route uses);
  otherwise it falls back to the first `RouteRegistered` leg out of the current hub.

## Files changed
- Added: `packages/api/src/routes/load-plan-helper.ts`,
  `packages/api/src/routes/hub-detail.ts`,
  `packages/api/src/routes/hub-detail.test.ts`,
  `packages/api/test/hub-detail.int.test.ts`.
- Modified: `packages/api/src/routes/plan-detail.ts` (+ `.test.ts`),
  `packages/api/src/server.ts`, `packages/api/src/index.ts`,
  `packages/api/src/ws/envelope.ts` (+ `.test.ts`),
  `packages/api/src/ws/snapshots.ts` (+ `.test.ts`),
  `packages/load-planner/src/scoring.ts` (+ `.test.ts`),
  `packages/load-planner/src/index.ts`.

## Gate result
`build` + `typecheck` + `lint` clean; `test:all` **1386 passed (132 files)**
(unit + integration + ui), up ~30 from the prior ~1356. Sim determinism goldens
and the Phase-13 driver-status golden replay int test unaffected (still green).
New endpoint integration test passes **8/8** against a real Postgres testcontainer.
