---
status: passed
---

# Phase 14 — Verification

**Verified:** 2026-06-22
**Branch:** `feature/phase-14-hub-detail-endpoint-ws-driver-buckets` (not merged, not pushed)

## Gate (ALL green)

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` (turbo) | ✅ 10/10 tasks (web + all packages) |
| Typecheck | `pnpm typecheck` (`tsc -p tsconfig.eslint.json`, incl. tests) | ✅ clean, no errors |
| Lint | `pnpm lint` (`eslint .`) | ✅ clean, 0 problems |
| Tests | `pnpm test:all` (unit + integration + ui) | ✅ **1386 passed / 132 files** (was ~1356; +30 new) |

### Determinism / regression safety (pure read-layer — confirmed)
- Sim determinism goldens — `packages/simulation/test/determinism.unit.test.ts` → ✅ 8/8.
- Phase-13 driver-status golden replay (live == rebuilt) —
  `packages/api/test/driver-status-golden-replay.int.test.ts` → ✅ pass.
- Projections golden replay — `packages/api/test/projections-golden-replay.int.test.ts` → ✅ pass.
- Existing ws envelope/snapshot tests → ✅ unchanged + green (additive optional field).
- New endpoint integration test — `packages/api/test/hub-detail.int.test.ts`
  (real Postgres testcontainer) → ✅ **8/8**.

## Success criteria → evidence

### SC1 — Endpoint returns trailers at the hub with status / dock / assigned-driver duty + remaining legal drive time ✅
- Code: `routes/hub-detail.ts` — `trailer_state WHERE current_hub_id=:id`; per-trailer
  `status` / `dockDoorId` / `assignedPackageIds`; `driver_id → driver_status` `IN (...)`
  join → `{ driverId, dutyStatus, remainingDriveMinutes }` | `null`.
- Tests: `hub-detail.test.ts` ("returns trailers … status, dockDoorId, packages",
  "includes the bound driver's duty status + remaining drive minutes", "driver is
  null when no bound driver"); `hub-detail.int.test.ts` HUBQ-01 (asserts the exact
  `remainingDriveMinutes` via `remainingLegalDriveMinutes` over the seeded clock).

### SC2 — Load-plan summary via shared `planLoad` helper; slice-based utilization; dwell from `audit_timeline` (not `last_event_at`); `nextHubId` via `buildRoute`; ETA labelled an estimate ✅
- Code: shared `routes/load-plan-helper.ts` `reconstructTrailerPlan` (used by BOTH
  `plan-detail.ts` and `hub-detail.ts`); `utilization` = exported
  `utilizationFraction` (`Σ usedVolume / Σ capacityVolume`); `arrivedAtMs` from
  `audit_timeline … TrailerArrivedAtHub ORDER BY global_seq DESC LIMIT 1`;
  `nextHubId` = `buildRoute(...)[0]`; `estimatedEtaMs` + `etaIsEstimate`.
- Tests: `hub-detail.test.ts` (HUBQ-03/04 rear→nose + util in (0,1]; HUBQ-05 "NOT
  last_event_at" with a later `TrailerDocked`/`last_event_at` decoy; HUBQ-06 next
  hub + fallback; HUBQ-07 estimate > arrival + flag; in-transit → null);
  `scoring.test.ts` (`utilizationFraction` zone-wise denominator + DRY with
  `utilizationScore`); `plan-detail.test.ts` (additive `utilization`);
  `hub-detail.int.test.ts` HUBQ-03/04/05/06/07.

### SC3 — `trailer_state(current_hub_id)` index backs the query (no full-table scan) ✅
- Index `idx_trailer_state_current_hub` confirmed present in
  `packages/projections/src/schema.{ts,sql}` (landed Phase 13).
- Test: `hub-detail.int.test.ts` HUBQ-02 — asserts the index row exists in
  `pg_indexes` AND an `EXPLAIN` of `WHERE current_hub_id = :id` shows an
  `idx_trailer_state_current_hub` access path (an index path exists; no forced seq scan).

### SC4 — ws `HubState` carries `driverCount` / `onBreakCount` / `restingCount`; DTO stable across REST and ws ✅
- Code: `ws/envelope.ts` — optional driver buckets on `HubState`, compared in
  `hubChanged` (`?? 0`); `ws/snapshots.ts` — `buildSnapshotPayload` sets them via
  the exported pure `driverBucketsPerHub`. REST DTO (`HubTrailerDto`) is distinct
  and richer; ws carries counts only.
- Tests: `envelope.test.ts` (HUBQ-08 driverCount/onBreak/resting diffs +
  back-compat absent=0); `snapshots.test.ts` (`driverBucketsPerHub` tally + skips);
  `hub-detail.int.test.ts` HUBQ-08 (real `buildSnapshotPayload`: DFW = 1 driver
  on_break; empty hub = 0).

## Requirement → evidence checklist

| Req | Where | Test evidence |
|---|---|---|
| HUBQ-01 | `hub-detail.ts` (presence + status/dock/packages + driver join) | `hub-detail.test.ts` x3; int HUBQ-01 |
| HUBQ-02 | `schema.{ts,sql}` index; index-backed filter | int HUBQ-02 (pg_indexes + EXPLAIN) |
| HUBQ-03 | `load-plan-helper.ts` `reconstructTrailerPlan` (shared, DRY) | `hub-detail.test.ts` HUBQ-03/04; `plan-detail.test.ts` |
| HUBQ-04 | `utilizationFraction` exported + additive `TrailerPlanDto.utilization` | `scoring.test.ts` x4; `plan-detail.test.ts`; int HUBQ-03/04 |
| HUBQ-05 | `readArrivedAtMs` (audit_timeline DESC LIMIT 1) | `hub-detail.test.ts` HUBQ-05 (decoys); int HUBQ-05 |
| HUBQ-06 | `nextHubId = buildRoute(...)[0]` | `hub-detail.test.ts` HUBQ-06 + fallback; int HUBQ-06 |
| HUBQ-07 | `estimateDepartMs` + `etaIsEstimate`; in-transit null | `hub-detail.test.ts` x2; int HUBQ-07 |
| HUBQ-08 | `HubState` driver buckets + `driverBucketsPerHub` in `buildSnapshotPayload` | `envelope.test.ts` x3; `snapshots.test.ts` x3; int HUBQ-08 |

## Verdict

All 4 success criteria met and all 8 requirements (HUBQ-01..08) evidenced; full
`test:all` green (1386). **status: passed.**
