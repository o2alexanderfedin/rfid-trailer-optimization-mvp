---
phase: 27-perf-plumbing-scale-viz
plan: "06"
subsystem: api-ws-viz
tags: [VIZ-17, COORD-03, suggestions, overlay, feed, TDD]
dependency_graph:
  requires: [27-03, 27-05]
  provides: [VIZ-17, COORD-03-live-reject]
  affects: [envelope.ts, driver.ts, MapView.tsx, App.tsx, RightRail.tsx]
tech_stack:
  added: []
  patterns:
    - pre-allocated OL Style per outcome (module-level, zero per-frame alloc)
    - transient tick-only field (suggestions, Pitfall-7 compliant)
    - useSuggestions hook mirrors useAlertFeed pattern exactly
    - exactOptionalPropertyTypes-safe reasonCode omission via conditional spread
    - shared showSuggestions toggle state flows App → MapView + RightRail
key_files:
  created:
    - packages/api/src/ws/envelope.ts (SuggestionEvent interface + TickPayload.suggestions?)
    - packages/web/src/map/suggestionColoring.ts (two pre-allocated accept/reject Styles)
    - packages/web/src/panels/useSuggestions.ts (hook + pure helpers + MAX_FEED_ENTRIES)
    - packages/web/src/panels/SuggestionFeed.tsx (accept-green / reject-red component)
    - packages/web/test/useSuggestions.unit.test.ts (TDD RED/GREEN cycle)
  modified:
    - packages/api/src/main.ts (P27-B: refuelThresholdMiles: 250 demo override)
    - packages/api/src/ws/snapshots.ts (Broadcast signature + suggestions chaining)
    - packages/api/src/ws/envelope.ts (SuggestionEvent + TickPayload.suggestions)
    - packages/api/src/index.ts (export InductionEvent/DeliveryEvent/SuggestionEvent)
    - packages/api/src/sim/driver.ts (collectSuggestions + pendingSuggestions accumulator)
    - packages/web/src/map/layers.ts (createSuggestionLayer + flashSuggestion)
    - packages/web/src/map/MapView.tsx (suggestion layer + toggle visibility useEffect)
    - packages/web/src/map/coloring.ts (Rule-1: OL Style opacity → rgba alpha channel)
    - packages/web/src/App.tsx (useSuggestions wired, onSuggestions tick-only dispatch)
    - packages/web/src/panels/RightRail.tsx (Suggestions toggle + Advisory Suggestions section)
decisions:
  - Chose locationHubId (not raw lon/lat) in SuggestionEvent — mirrors established inductionEvents pattern; client resolves via hubLonLatRef
  - P27-B: refuelThresholdMiles: 250 only — ensures backbone legs (400-900 miles) trigger mustRefuel without touching DEFAULT_FUEL_CONFIG or targeting heuristic
  - exactOptionalPropertyTypes compliance: conditional spread for reasonCode in applySuggestions map() instead of explicit undefined
  - Suggestions toggle is a single checkbox in RightRail that drives both MapView.showSuggestions and the Advisory Suggestions section visibility
metrics:
  duration: "~45 min"
  completed_date: "2026-06-27"
  tasks_completed: 3
  files_changed: 13
---

# Phase 27 Plan 06: P27-B Live Fuel Reject + VIZ-17 Suggestion Overlay + Feed Summary

P27-B (COORD-03 live reject) + VIZ-17 (accept-green/reject-red advisory-suggestion overlay and feed with opt-in Suggestions toggle default OFF).

## What Was Built

### Task 1: P27-B Demo-Config Fuel Reject + Transient Suggestions DTO

**P27-B (COORD-03):** At the `packages/api/src/main.ts` continental demo config site, added `refuelThresholdMiles: 250` override on top of `{...DEFAULT_FUEL_CONFIG, enabled: true}`. Any truck that has driven 250+ miles (nearly every backbone leg, which are 400–900 miles) will have `mustRefuel: true` from `truckLegFeasibility()`, causing a deterministic "won't divert: fuel" `SuggestionRejected` when the coordinator targets it. The `DEFAULT_FUEL_CONFIG` in `packages/domain/src/fuel.ts` is untouched; no baked goldens moved.

**VIZ-17 DTO:** Added `SuggestionEvent` interface to `envelope.ts` with `suggestionId`, `kind`, `outcome`, `entityId`, `toHubId`, `reasonCode?`, and `locationHubId` (hub-id-based, resolved to lon/lat by client via `hubLonLatRef`). Added `suggestions?: readonly SuggestionEvent[]` to `TickPayload` only — NOT to `SnapshotPayload` (Pitfall-7 compliant). Added `collectSuggestions()` to `driver.ts` that builds a `suggestionId → ActionSuggested` index then emits `SuggestionEvent` objects for each `SuggestionAccepted`/`SuggestionRejected` in the tick. Extended `Broadcast` type in `snapshots.ts` to pass `suggestions` and chain them onto the tick delta.

### Task 2: Suggestion Map Overlay (OL Layer + Flash Markers)

Created `packages/web/src/map/suggestionColoring.ts` with two module-level pre-allocated `Style` objects (accept green `#16a34a` / reject red `#dc2626`, radius 13, white 2px stroke, glyph ✓/✕) — zero per-frame allocation, same discipline as `inductionColoring.ts`.

Added `createSuggestionLayer()` (with `declutter: true` to prevent burst stacking) and `flashSuggestion()` (add-then-`setTimeout`-remove, 2500ms default, `Date.now()/Math.random()` for feature-id uniqueness — sanctioned use) to `layers.ts`.

Wired into `MapView.tsx`: `showSuggestions` prop, `suggestionSourceRef`/`LayerRef` refs, stable `showSuggestionsRef`, a `useEffect` for visibility toggling (no map recreation), and flash logic in the tick branch. Also applied Rule-1 fix to `coloring.ts`: OL 10 `Style` has no top-level `opacity` property — moved backbone/spoke opacity to `rgba()` alpha channel in the stroke color (was silently ignored).

### Task 3: useSuggestions Hook + SuggestionFeed + App/RightRail Wiring (TDD)

**TDD RED:** `packages/web/test/useSuggestions.unit.test.ts` — 12 failing tests for `MAX_FEED_ENTRIES`, `applySuggestions` (cap/dedup/simMs attachment), `sortSuggestionFeed` (newest-first, non-mutation), `suggestionKindLabel`.

**TDD GREEN:** Implemented `useSuggestions.ts` with `MAX_FEED_ENTRIES = 200` cap, dedup-by-`suggestionId`, `exactOptionalPropertyTypes`-safe `reasonCode` handling via conditional spread. Exported pure helpers for Node unit tests.

Created `SuggestionFeed.tsx` cloning `AlertFeed.tsx` visual pattern: accept-green `#4ade80`, reject-red `#f87171`, verbatim `COORDINATION_REJECT_LABELS` copy, reuses `.alert-feed__*` CSS, NO `dangerouslySetInnerHTML` (threat T-27-15).

Updated `App.tsx`: `useSuggestions` wired; `onSuggestions` dispatched in the TICK branch only (Pitfall-7: never on snapshot). Single `showSuggestions` state flows to both `MapView` and `RightRail`.

Updated `RightRail.tsx`: "Suggestions" checkbox toggle (default OFF, `accentColor: #1d4ed8`), "Advisory Suggestions" section with count badge, both feed section and map overlay governed by the same prop.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] OL Style.opacity silently ignored (coloring.ts)**
- **Found during:** Task 2
- **Issue:** `new Style({ ..., opacity: 0.9 })` is not a valid OL 10 `Style` constructor property — OL has no top-level opacity; the value was silently discarded, rendering backbone/spoke legs at full opacity.
- **Fix:** Moved opacity to the stroke color's alpha channel: `rgba(203,213,225,0.9)` for backbone, `rgba(148,163,184,0.55)` for spoke.
- **Files modified:** `packages/web/src/map/coloring.ts`
- **Commit:** 5e8677d

**2. [Rule 2 - Missing export] SuggestionEvent / InductionEvent / DeliveryEvent not exported from api index**
- **Found during:** Task 3 (test import failed)
- **Issue:** The web test and `useSuggestions.ts` needed to import `SuggestionEvent` from `@mm/api` by name, but it wasn't re-exported from `packages/api/src/index.ts`.
- **Fix:** Added `InductionEvent`, `DeliveryEvent`, `SuggestionEvent` to the api index exports.
- **Files modified:** `packages/api/src/index.ts`
- **Commit:** 4cb64d2

**3. [Rule 1 - Bug] exactOptionalPropertyTypes: reasonCode mapping**
- **Found during:** Task 3 build (`tsc -b` error)
- **Issue:** `.map(e => ({ ..., reasonCode: e.reasonCode }))` sets `reasonCode: undefined` when the field is absent — incompatible with `exactOptionalPropertyTypes: true` which treats `{ reasonCode: undefined }` differently from omitting the key.
- **Fix:** Conditional spread: `if (e.reasonCode !== undefined) return { ...base, reasonCode: e.reasonCode }; return base;`
- **Files modified:** `packages/web/src/panels/useSuggestions.ts`
- **Commit:** 81c424b

## TDD Gate Compliance

- RED gate: `test(27-06)` commit `4cb64d2` — 12 failing tests (module not found).
- GREEN gate: `feat(27-06)` commit `81c424b` — 12 passing tests + build clean.

## Verification

- `pnpm exec vitest run --project unit` — 1918 tests pass (all 174 files).
- `pnpm --filter @mm/web build` — `tsc -b && vite build` zero errors.
- `pnpm --filter @mm/api build` — `tsc -b` zero errors.
- Continental determinism test (seed-42/300, difference-not-hash) — PASS.
- Baked goldens byte-identical: `3920accc`, `94689f99`, `edfa5a6d`, `162efbd8` — all present unchanged.
- `SnapshotPayload` has NO `suggestions` field (grep confirms zero occurrences inside the interface block).
- `SuggestionFeed.tsx` has NO `dangerouslySetInnerHTML` (threat T-27-15 — only doc comment mentions it).
- `onSuggestions` dispatched only in TICK branch of `App.tsx` `onAlertEnvelope`.

## Known Stubs

None — all data is wired live through the ws tick pipeline.

## Threat Flags

No new threat surface beyond what the plan's threat register covers (T-27-15/16/17 all mitigated).

## Self-Check: PASSED

- `packages/web/src/map/suggestionColoring.ts` — FOUND
- `packages/web/src/panels/useSuggestions.ts` — FOUND
- `packages/web/src/panels/SuggestionFeed.tsx` — FOUND
- `packages/web/test/useSuggestions.unit.test.ts` — FOUND
- Commits bb0f15e, 5e8677d, 4cb64d2, 81c424b — all present in git log
