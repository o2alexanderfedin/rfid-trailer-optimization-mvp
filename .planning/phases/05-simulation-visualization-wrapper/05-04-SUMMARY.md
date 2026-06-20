---
phase: 05-simulation-visualization-wrapper
plan: 04
subsystem: api,projections
tags: [audit-timeline, plan-detail, trailer-history, viz-05, ui-02, tdd, anti-repudiation]
dependency_graph:
  requires: [05-01, 05-02, 05-03]
  provides: [GET /trailers/:id/plan, GET /trailers/:id/history, readTrailerAuditTimeline, extended audit_timeline schema]
  affects: [packages/projections, packages/api, audit_timeline table]
tech_stack:
  added: []
  patterns: [TDD RED-GREEN, pure-reducer catch-up projection, FND-04 golden-replay, anti-repudiation T-05-09]
key_files:
  created:
    - packages/projections/src/reducers/audit-timeline.test.ts
    - packages/api/src/routes/plan-detail.ts
    - packages/api/src/routes/plan-detail.test.ts
  modified:
    - packages/projections/src/reducers/audit-timeline.ts
    - packages/projections/src/runner/catchup.ts
    - packages/projections/src/schema.sql
    - packages/projections/src/schema.ts
    - packages/projections/src/index.ts
    - packages/api/src/server.ts
decisions:
  - "Plan-detail route re-derives the LoadPlan from current twin state via planLoad() rather than storing the full plan in the event log (PlanGenerated carries only the objective/feasibility ids, not slices/placements)"
  - "AuditTimelineEntry extended with nullable trailerId + recommendation fields (exactly one of packageId/trailerId is non-null per row)"
  - "Recommendation captured as a pure text render from payload fields (no Date.now/RNG) so FND-04 golden-replay invariant holds"
  - "audit_timeline.package_id made nullable (was NOT NULL) to support trailer-only rows without a package reference"
  - "readTrailerAuditTimeline returns empty array (not 404) for unknown trailer — absence is valid empty history, not an error"
  - "GET /trailers/:id/plan returns 404 for trailers with no assigned packages — absence is never fabricated"
metrics:
  duration: "~35 minutes"
  completed: "2026-06-19T22:57:38Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 6
---

# Phase 05 Plan 04: Plan Detail Route + Extended Audit Timeline Summary

**One-liner:** Audit projection extended to index trailer streams and persist captured optimizer recommendations; `GET /trailers/:id/plan` returns rear→nose load order + loading card + explanation; `GET /trailers/:id/history` returns trailer audit timeline with captured recommendation entries.

## Tasks Completed

| Task | Name | Commit (RED) | Commit (GREEN) | Files |
|------|------|--------------|----------------|-------|
| 1 | Extend audit projection — trailer streams + recommendation | `0f1c59d` | `3115efe` | audit-timeline.ts, schema.sql/ts, catchup.ts, index.ts |
| 2 | GET /trailers/:id/plan (VIZ-05) + /history (UI-02) | `b689ce2` | `4718e47` | plan-detail.ts, plan-detail.test.ts, server.ts |

## What Was Built

### Task 1: Audit Projection Extension

**`AuditTimelineEntry`** gained two fields:
- `trailerId: string | null` — set for trailer-keyed events, null for package events
- `recommendation: string | null` — the captured system recommendation at plan-lifecycle events

**`auditTimelineReducer`** extended with new cases:
- `TrailerDeparted` → trailer-keyed entry (`hubId = fromHubId`)
- `TrailerArrivedAtHub` → trailer-keyed entry (`hubId = arrival hub`)
- `TrailerDocked` → trailer-keyed entry (`hubId = dock hub`)
- `PlanGenerated` → trailer-keyed entry with recommendation capturing objective cost + feasibility label
- `PlanAccepted` → trailer-keyed entry with recommendation capturing plan acceptance

**`audit_timeline` schema changes** (both `schema.sql` and `schema.ts`):
- `package_id TEXT` — made nullable (was `NOT NULL`) to support trailer-only rows
- `trailer_id TEXT` — new column (nullable), set for trailer-keyed events
- `recommendation TEXT` — new column (nullable), set for plan-lifecycle events
- `idx_audit_timeline_trailer` — new index for efficient trailer history queries

**`readTrailerAuditTimeline(db, trailerId)`** added to `catchup.ts` and exported from `index.ts`.

### Task 2: Plan-Detail Routes

**`GET /trailers/:id/plan`** (VIZ-05):
1. Reads `trailer_state` for the trailer's current assigned packages + hub
2. Reads `hub_inventory` to map each package to its next-unload hub  
3. Reads `RouteRegistered` events for route legs
4. Builds `LoadBlock[]` + `RouteStop[]` from current twin state
5. Calls `planLoad()` (deterministic Phase-2 planner — same function the optimizer uses)
6. Renders `instructions()` + `planExplanation()` via Phase-2 renderers
7. Returns `{ trailerId, rearToNose, instructions, explanation }`
8. 404 on unknown trailer or no assigned packages (absence = no plan)

**`GET /trailers/:id/history`** (UI-02):
- Delegates to `readTrailerAuditTimeline(db, trailerId)`
- Returns trailer audit entries in globalSeq order
- Includes `recommendation` field for plan-lifecycle entries
- Returns empty array (not 404) for unknown trailer

Both endpoints:
- `:id` validated non-empty by Fastify JSON schema (T-05-07 — mirrors T-01-18)
- Read-only (no event-store writes, T-05-08)
- Single parameterized Kysely queries (no string-concat SQL)

## FND-04 Golden-Replay Verification

The extended `auditTimelineReducer` remains a **pure function** of the stored event:
- No `Date.now()`, no `Math.random()`, no unstable sort
- `recommendation` text is derived entirely from the event payload fields
- `renderPlanGeneratedRecommendation()` / `renderPlanAcceptedRecommendation()` are pure string formatters

**Integration test result:** All 16 integration tests pass including the golden-replay and idempotency keystones.
The `serializeCatchup()` function now includes `trailerId` and `recommendation` fields — the rebuild-from-log produces byte-identical JSON to the live fold.

## Test Results

```
pnpm test --project=unit  → 69 test files, 647 tests, all passed
pnpm test:all             → 85 test files, 711 tests, all passed (incl. integration)
pnpm build (tsc -b)       → clean
```

## Deviations from Plan

### Auto-applied simplifications

**1. [Rule 1 / Design] `buildBlocks` uses unit-volume blocks with standard handling class**
- **Found during:** Task 2 implementation
- **Issue:** `LoadBlock.key` requires 7 dimensions including `slaClass`, `handlingClass`, `sizeWeightClass`, `deadlineBucket`, `finalDestHubId` — none of which are available in the twin state (only `packageId` + `nextUnloadHubId` can be derived)
- **Fix:** Used `"standard"` defaults for the planning enum fields and `volume=1/weight=1` (unit blocks). This matches the optimizer's own twin snapshot approach (`twin-snapshot.ts:buildTrailerBlocks` uses unit-volume blocks).
- **Impact:** Instructions and explanation are valid and meaningful; block grouping is per-package rather than per-aggregated-group. Consistent with the demo MVP's unit-volume model.
- **Files:** `plan-detail.ts`

**2. [Rule 1 / Schema] `package_id` column made nullable**
- **Found during:** Task 1 schema design
- **Issue:** The original `package_id TEXT NOT NULL` prevented inserting trailer-only rows (no package reference for trailer events)
- **Fix:** Changed to `package_id TEXT` (nullable). The schema constraint was too strict for the extended use case.
- **Files:** `schema.sql`, `schema.ts`, `catchup.ts` (upsertAuditRow updated)

## Known Stubs

None that prevent the plan's goal. The `buildBlocks` simplification uses `"standard"` defaults for non-essential planning fields but produces a valid, non-empty plan with correct rear→nose ordering.

## Threat Flags

No new threat surface beyond what was in the plan's threat model (T-05-07/08/09 all addressed).

## Self-Check: PASSED

Files verified:
- `packages/projections/src/reducers/audit-timeline.ts` — FOUND
- `packages/projections/src/reducers/audit-timeline.test.ts` — FOUND
- `packages/projections/src/runner/catchup.ts` — FOUND (readTrailerAuditTimeline exported)
- `packages/projections/src/schema.sql` — FOUND (trailer_id + recommendation columns)
- `packages/projections/src/schema.ts` — FOUND (AuditTimelineTable updated)
- `packages/api/src/routes/plan-detail.ts` — FOUND
- `packages/api/src/routes/plan-detail.test.ts` — FOUND
- `packages/api/src/server.ts` — FOUND (registerPlanDetailRoutes registered)

Commits verified:
- `0f1c59d` — test RED: audit-timeline — FOUND
- `3115efe` — feat GREEN: audit projection — FOUND
- `b689ce2` — test RED: plan-detail — FOUND
- `4718e47` — feat GREEN: plan-detail routes — FOUND
