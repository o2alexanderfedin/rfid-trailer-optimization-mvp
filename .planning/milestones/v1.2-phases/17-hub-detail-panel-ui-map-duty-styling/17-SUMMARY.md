# Phase 17 — Hub Detail panel UI + map duty styling — SUMMARY

**Milestone:** v1.2 · **Branch:** `feature/phase-17-hub-detail-panel-ui-map-duty-styling`
**Requirements delivered:** VIZ-07, VIZ-08, VIZ-09, VIZ-10, VIZ-11
**Method:** TDD (RED → GREEN → refactor). Frontend only (React 19 + OpenLayers 10). No backend changes.

## What shipped

Clicking a hub icon on the live USA map now opens a **Hub Detail** panel in the right rail showing the trailers currently at that hub as compact rows — each with operational status, **live elapsed dwell** (ticking from ws `simMs`), utilization %, package count, next hub + a clearly-**estimated** ETA, and the assigned **driver's duty status + remaining legal drive minutes** (the v1.2 hero datum, shown as a number AND a duty-colored bucket). Clicking a row opens the existing VIZ-05 `TrailerDetail` plan (reused, not duplicated). Open exceptions for each trailer appear inline from the already-streamed ws channel (no extra fetch). On the map, **hub markers are colored by their driver-duty distribution** from the ws `HubState` driver buckets, with a matching Legend section.

## Files changed

### New
- `packages/web/src/map/dutyColoring.ts` — `DUTY_COLORS` / `DUTY_BUCKET_LABELS` / `classifyDutyBucket` / `hubHasDriverData` (VIZ-11 single source of truth). `+ dutyColoring.test.ts`.
- `packages/web/src/map/useLiveSimMs.ts` — server-anchored, 1s-ticking sim-clock reading for panels (live dwell). `+ useLiveSimMs.test.tsx`.
- `packages/web/src/panels/useOpenExceptions.ts` — live open-exception set + `entityId` filter (VIZ-10). `+ useOpenExceptions.test.tsx`.
- `packages/web/src/panels/HubDetail.tsx` — the VIZ-07..10 panel (compact rows, live dwell, exceptions badge, click-through). `+ HubDetail.test.tsx`.

### Modified
- `packages/web/src/api/client.ts` — `HubTrailerDriverDto` / `HubTrailerDto` / `HubDetailDto` + `fetchHubDetail` (empty hub is valid, not 404).
- `packages/web/src/map/coloring.ts` — `hubStyle` prefers a `dutyBucket` (zero-alloc duty cache from `DUTY_COLORS`), falling back to the volume bucket.
- `packages/web/src/map/layers.ts` — `applyHubBuckets` derives + sets `dutyBucket` (cleared when a hub has no driver data → volume fallback).
- `packages/web/src/map/Legend.tsx` — permanent driver-duty ramp section.
- `packages/web/src/map/MapView.tsx` — click handler detects `hubId` → `onHubSelect` (hub hit takes priority; empty click deselects).
- `packages/web/src/App.tsx` — `selectedHubId` state + `onHubSelect`, kept mutually exclusive with `selectedTrailerId`.
- `packages/web/src/panels/RightRail.tsx` — `selectedHubId` prop, auto-focused **Hub** tab hosting `HubDetail`.
- `packages/web/src/index.css` — `.hub-detail__*` compact-row styling (matches the dark operator aesthetic + the duty color ramp).
- Tests extended: `coloring.test.ts`, `layers.test.ts`, `Legend.test.tsx`, `RightRail.test.tsx`, `MapView.browser.test.tsx`.

## Key decisions

- **Live dwell on the React path:** the map's trailer tween reads `simClock` inside the OL `postrender` loop (off React). Panels can't hook that, so `useLiveSimMs` re-implements the same resync+setSpeed discipline against the shared ws bus and re-renders on a 1s interval — paused → frozen (monotonic), matching the trailer animation.
- **Duty coloring precedence:** `hubStyle` reads `dutyBucket` first, then `volumeBucket`. Existing volume-only features (and all prior `hubStyle` tests) are unchanged because they never set `dutyBucket`. The map node is never re-rendered — coloring is a `feature.set('dutyBucket', …)` into the existing zero-alloc cache.
- **Exceptions filter scope (honest):** ws `ExceptionItem.entityId` carries only the trailerId, so per-row badges cover trailer-scoped alerts; hub-scoped alerts are out of this client filter (documented in `useOpenExceptions`).
- **ETAs labelled estimates:** parked-trailer ETA renders with a leading `~` and a panel footnote; the row honors `etaIsEstimate` from the endpoint.

## Verification

See `17-VERIFICATION.md`. Gate: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all`, `pnpm test:browser`.
