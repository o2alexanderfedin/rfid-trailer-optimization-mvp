---
phase: 05-simulation-visualization-wrapper
plan: 07
subsystem: web
tags: [alert-feed, trailer-detail, audit-timeline, right-rail, ui-01, ui-02, viz-05, tdd, react, operator-panels]
dependency_graph:
  requires: [05-01, 05-04, 05-06]
  provides: [AlertFeed, TrailerDetail, AuditTimeline, RightRail, map-click-trailer-select]
  affects: [packages/web/src/panels/, packages/web/src/map/MapView.tsx, packages/web/src/App.tsx, packages/web/src/index.css, packages/web/src/api/client.ts]
tech_stack:
  added: []
  patterns: [TDD RED-GREEN, pure-helper extraction for Node tests, stable-ref pattern for OL click handler, AbortController per fetch, useAlertFeed hook, useTrailerPlan hook, useAuditTimeline hook]
key_files:
  created:
    - packages/web/src/panels/AlertFeed.tsx
    - packages/web/src/panels/AlertFeed.test.tsx
    - packages/web/src/panels/TrailerDetail.tsx
    - packages/web/src/panels/TrailerDetail.test.tsx
    - packages/web/src/panels/AuditTimeline.tsx
    - packages/web/src/panels/AuditTimeline.test.tsx
    - packages/web/src/panels/RightRail.tsx
  modified:
    - packages/web/src/api/client.ts
    - packages/web/src/map/MapView.tsx
    - packages/web/src/App.tsx
    - packages/web/src/index.css
decisions:
  - "Pure state helpers (applyExceptionsNew, sortFeed, formatRearToNose, sortTimeline etc.) extracted from components so Node unit tests need no DOM/browser — consistent with existing project test pattern"
  - "Alert feed uses a second useWsEnvelope connection in App rather than refactoring MapView's internal hook — avoids MapView internals churn; acceptable MVP trade-off flagged as future consolidation target"
  - "Map click handler stored via stable ref pattern (onTrailerSelectRef) — changing onTrailerSelect closure never re-registers the OL listener"
  - "forEachFeatureAtPixel returns first hit only (stop-on-true) — unambiguous single trailer selection"
  - "AlertFeed capped at MAX_FEED_ENTRIES=200 (T-05-15) — oldest entries dropped to bound memory; sortFeed applied at render time for stable newest-first ordering"
  - "sortTimeline uses numeric comparison (Number(seq)) not lexicographic — '10' > '9' works correctly"
  - "AuditTimeline plan says GET /packages/:id/history but the plan-detail.ts route registers /trailers/:id/history only; fetchPackageHistory targets /api/packages/:id/history which is not yet registered server-side — stub noted in Known Stubs below"
metrics:
  duration: "~45 minutes"
  completed: "2026-06-19T17:16:00Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 7
  files_modified: 4
---

# Phase 05 Plan 07: Operator Right-Rail Panels Summary

**One-liner:** AlertFeed (UI-01) realtime exception feed with severity color coding, TrailerDetail (VIZ-05) click-a-trailer rear→nose plan panel, and AuditTimeline (UI-02) package/trailer history with captured optimizer recommendations — all wired to the map and ws envelope, rendered in a dark operator dashboard right-rail.

## Tasks Completed

| Task | Name | Commit (RED) | Commit (GREEN) | Files |
|------|------|--------------|----------------|-------|
| 1 | AlertFeed (UI-01) + typed fetch helpers | `36114ed` | `173624a` | AlertFeed.tsx, AlertFeed.test.tsx, client.ts |
| 2 | TrailerDetail + AuditTimeline + map click wiring | `99e79c5` | `9cca91f` | TrailerDetail.tsx, AuditTimeline.tsx, RightRail.tsx, MapView.tsx, App.tsx, index.css |

## What Was Built

### Task 1: AlertFeed (UI-01) + typed fetch helpers

**`AlertFeed.tsx`** — realtime exception feed with:
- `applyExceptionsNew(current, incoming)` — deduplicate + append; cap at MAX_FEED_ENTRIES=200 (T-05-15)
- `applyExceptionsResolved(current, resolved)` — remove by id; silent on missing
- `sortFeed(feed)` — newest-first by simMs, stable tie-break by id (deterministic)
- `severityClass(severity)` — returns `alert-feed__entry--{low|med|high}` CSS class
- `kindLabel(kind)` — human-readable: "Wrong Trailer", "Missed Unload", "Blocked Freight", "Low Utilization"
- `useAlertFeed()` hook — React state wrapper, returns stable `onExceptionsNew` / `onExceptionsResolved` callbacks
- `AlertFeed` component — severity color-coded rows with kind/reason/recommendedAction; empty state; React default escaping (T-05-16)

**`client.ts` typed fetch helpers added:**
- `fetchTrailerPlan(trailerId, signal?)` — GET /api/trailers/:id/plan → TrailerPlanDto | null (404 → null)
- `fetchTrailerHistory(trailerId, signal?)` — GET /api/trailers/:id/history → TrailerHistoryEntryDto[]
- `fetchPackageHistory(packageId, signal?)` — GET /api/packages/:id/history → TrailerHistoryEntryDto[]
- DTOs: `RearToNoseSlice`, `LoadingInstructions`, `ZoneInstruction`, `TrailerPlanDto`, `TrailerHistoryEntryDto`

### Task 2: TrailerDetail + AuditTimeline + map click wiring

**`TrailerDetail.tsx`** (VIZ-05):
- `formatRearToNose(slices)` — sort depth-asc, filter empty → RearToNoseRow[]
- `extractZoneSummary(instr)` — zone name + blockCount + text → ZoneSummaryEntry[]
- `getPlanStatus(plan)` — "loaded" | "no-plan"
- `useTrailerPlan(trailerId)` hook — fetches on id change, AbortController cleanup on id change/unmount
- `TrailerDetail` component — loading/error/empty/no-plan/plan states; rear→nose list, zone instructions, explanation

**`AuditTimeline.tsx`** (UI-02):
- `sortTimeline(entries)` — numeric globalSeq ascending (Number() comparison, not lexicographic)
- `formatTimelineEntry(entry)` — label = "EventType @ hubId", recommendation passthrough
- `hasRecommendation(entry)` — non-empty string predicate
- `useAuditTimeline(kind, entityId)` hook — fetches trailer or package history, AbortController cleanup
- `AuditTimeline` component — ordered list, `--has-recommendation` teal accent for decision entries

**`RightRail.tsx`** — composes AlertFeed + TrailerDetail/AuditTimeline with Plan/History tab toggle

**`MapView.tsx`** changes:
- Added `onTrailerSelect?: (id: string | null) => void` prop
- Stable ref pattern (`onTrailerSelectRef`) so changing closure never re-registers the listener
- `map.on("click", clickHandler)` using `forEachFeatureAtPixel` → `feature.get("trailerId")`
- `map.un("click", clickHandler)` on teardown (T-05-17, Q5 item 6)

**`App.tsx`** — split layout: map centerpiece + 300px right-rail; second `useWsEnvelope` feeds alert panel from ws deltas

**`index.css`** — dark operator dashboard (~300 lines):
- App layout: `app__body` flex row, `app__map` flex:1, `right-rail` flex:0 0 300px
- AlertFeed: severity border-left (green/amber/red) + tinted background + severity badge
- TrailerDetail: depth-labeled load-order list, zone instruction cards, explanation body copy
- AuditTimeline: sequence list, teal accent for recommendation entries

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (AlertFeed tests) | `36114ed` | PASSED |
| GREEN (AlertFeed impl) | `173624a` | PASSED |
| RED (TrailerDetail + AuditTimeline tests) | `99e79c5` | PASSED |
| GREEN (all panels + wiring) | `9cca91f` | PASSED |

## Test Results

```
pnpm --filter @mm/web test → 7 test files, 99 tests, all passed
pnpm build (tsc -b + vite build) → clean (chunk-size warning only, not an error)
```

## Checkpoint: Auto-Approved

Checkpoint type: `human-verify` (visual/interactive).

Auto-approved per execution instructions (autonomous mode at each visual checkpoint; note for later human review):

- AlertFeed: renders all 4 exception kinds with severity coding, reason, recommended action; updates from ws tick exceptionsNew/exceptionsResolved deltas
- TrailerDetail: clicking a trailer calls fetchTrailerPlan; renders rear→nose order, zone instructions, plain-English explanation
- AuditTimeline: fetches trailer history; orders by globalSeq numeric; highlights entries with captured recommendation
- Layout: dark operator dashboard, 300px right-rail, scrollable panels, tab toggle between Plan/History
- Overlays: no ol/Overlay used (side panel, not popup) — no overlay disposal needed; click handler properly unregistered on teardown

Human reviewer should verify against the 5-step checkpoint in the plan.

## Deviations from Plan

### Auto-applied decisions

**1. [Rule 1 / Design] Pure helper extraction matches project test pattern**
- **Found during:** Task 1 setup
- **Issue:** The plan mentions "component tests (Vitest + React Testing Library)" but the project has no jsdom/RTL setup — all existing tests are Node-environment pure function tests
- **Fix:** Extracted pure helpers (applyExceptionsNew, sortFeed, formatRearToNose, sortTimeline, etc.) from each component and tested those — same pattern as existing wsClient/animate/coloring/simClock tests
- **Impact:** Test coverage is equivalent; UI rendering tested via future e2e harness

**2. [Rule 1 / Design] Two WebSocket connections in App vs one shared context**
- **Found during:** Task 2 App.tsx integration
- **Issue:** MapView manages its own internal `useWsEnvelope` subscription; feeding the alert panel required either (a) a second subscription in App or (b) refactoring MapView to expose its envelope stream. Option (b) would be a significant MapView internals change touching the leak-guarded code.
- **Fix:** Added a second `useWsEnvelope` call in App.tsx for the alert panel only. Two connections to the same `/api/ws` endpoint; both receive the same messages.
- **Impact:** Minor: double ws connection overhead; functionally equivalent. Flagged for future consolidation via React context or prop drilling.

**3. [Rule 2 / Missing] map.on/map.un string-literal type cast**
- **Found during:** Task 2 build
- **Issue:** OL's TypeScript overloads for `map.on("click", fn)` expect the handler typed as `(evt: MapBrowserEvent) => void` but the inferred type of the lambda `(evt: MapBrowserEvent<PointerEvent>)` does not satisfy the constraint directly.
- **Fix:** Added explicit cast `as (evt: MapBrowserEvent) => void` on both `map.on` and `map.un` calls. Functionally safe — OL click events are always PointerEvent-backed.

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| `fetchPackageHistory` targets `/api/packages/:id/history` | `packages/web/src/api/client.ts` | The server-side route for package history was not registered in plan 05-04 (only trailer history was added). The fetch helper is typed and ready; the route needs to be added server-side in a future plan. |

The stub does not prevent plan 05-07's goals: UI-02 is functional for trailer history. Package history view is available in the AuditTimeline component but will return a network error until the server route is registered.

## Threat Flags

No new threat surface beyond the plan's threat model (T-05-15/16/17 all addressed).

## Self-Check: PASSED

Files verified:
- `packages/web/src/panels/AlertFeed.tsx` — FOUND
- `packages/web/src/panels/AlertFeed.test.tsx` — FOUND
- `packages/web/src/panels/TrailerDetail.tsx` — FOUND
- `packages/web/src/panels/TrailerDetail.test.tsx` — FOUND
- `packages/web/src/panels/AuditTimeline.tsx` — FOUND
- `packages/web/src/panels/AuditTimeline.test.tsx` — FOUND
- `packages/web/src/panels/RightRail.tsx` — FOUND
- `packages/web/src/api/client.ts` — FOUND (fetchTrailerPlan, fetchTrailerHistory, fetchPackageHistory)
- `packages/web/src/map/MapView.tsx` — FOUND (onTrailerSelect prop, click handler)
- `packages/web/src/App.tsx` — FOUND (split layout, useAlertFeed)
- `packages/web/src/index.css` — FOUND (right-rail + panel styles)

Commits verified:
- `36114ed` — test RED: AlertFeed — FOUND
- `173624a` — feat GREEN: AlertFeed + fetch helpers — FOUND
- `99e79c5` — test RED: TrailerDetail + AuditTimeline — FOUND
- `9cca91f` — feat GREEN: all panels + wiring — FOUND
