---
status: passed
---

# Phase 17 — Hub Detail panel UI + map duty styling — VERIFICATION

**Milestone:** v1.2 · **Branch:** `feature/phase-17-hub-detail-panel-ui-map-duty-styling`
**Requirements:** VIZ-07, VIZ-08, VIZ-09, VIZ-10, VIZ-11

## Gate results

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` | PASS (turbo, all packages) |
| Typecheck | `pnpm typecheck` | PASS (0 errors, strict TS, no `any`) |
| Lint | `pnpm lint` | PASS (0 problems) |
| Unit + integration + ui | `pnpm test:all` | PASS — see numbers below |
| Browser (Chromium / real OpenLayers) | `pnpm test:browser` | PASS — see numbers below |

Exact counts are recorded in the phase commit / report. New/extended suites all green; no existing web suite (MapView, RightRail, TrailerDetail, App, coloring, layers, Legend) regressed.

## Success-criteria checklist (criteria → evidence)

### Criterion 1 — Clicking a hub opens a Hub Detail panel (VIZ-07)
- `MapView.tsx` click handler detects `feature.get('hubId')` → `onHubSelect`; hub hit takes priority; empty click deselects.
- `App.tsx` threads `selectedHubId` (mutually exclusive with `selectedTrailerId`); `RightRail.tsx` shows an auto-focused **Hub** tab with the `Hub: {id}` header hosting `HubDetail`.
- Evidence: `MapView.browser.test.tsx` "VIZ-07: a click over a hub marker selects its hubId (and clears any trailer)"; `RightRail.test.tsx` "shows the Hub tab and renders the HubDetail panel when a hub is selected"; `HubDetail.test.tsx` header tests.

### Criterion 2 — Compact rows + click-through + exceptions (VIZ-08/09/10)
- **VIZ-08** rows render status, **live elapsed dwell** (`simMs − arrivedAtMs` via `useLiveSimMs`, ticking), utilization %, package count, next hub + clearly-**estimated** ETA (`~`), and the driver's duty status + remaining legal drive minutes as a **number AND a duty bucket** (`data-duty-bucket`).
  - Evidence: `HubDetail.test.tsx` "shows status, live dwell, utilization %, package count, and next hub per row", "shows the driver's duty status AND remaining legal drive minutes (the hero datum)", "labels the ETA as an estimate (~)", "re-renders the dwell as sim time advances (live)"; `useLiveSimMs.test.tsx` (resync + interval tick + paused-freeze).
- **VIZ-09** clicking a row opens the **reused** VIZ-05 `TrailerDetail` (rear→nose + instructions + explanation) with a back affordance.
  - Evidence: `HubDetail.test.tsx` "clicking a trailer row opens the reused VIZ-05 TrailerDetail plan".
- **VIZ-10** per-row open-exceptions badge from ws `exceptionsOpen` filtered by `entityId === trailerId` (no extra fetch).
  - Evidence: `HubDetail.test.tsx` "shows a per-row exceptions badge filtered by the trailer's entityId"; `useOpenExceptions.test.tsx` (snapshot/tick set maintenance + `entityId` filter).

### Criterion 3 — Hub markers colored by driver-duty distribution; Legend updated (VIZ-11)
- `dutyColoring.ts` `classifyDutyBucket` (all-available 0 / some-on-break 1 / some-resting 2 / all-out 3) + `DUTY_COLORS`/`DUTY_BUCKET_LABELS` single source of truth.
- `coloring.ts` `hubStyle` prefers `dutyBucket` (zero-alloc cache), falling back to volume; `layers.ts` `applyHubBuckets` derives + sets/clears `dutyBucket`; `Legend.tsx` driver-duty section.
- Evidence: `dutyColoring.test.ts`; `coloring.test.ts` "hubStyle (VIZ-11 driver-duty coloring)"; `layers.test.ts` duty-bucket derivation; `Legend.test.tsx` driver-duty section; `MapView.browser.test.tsx` "VIZ-11: a snapshot with driver buckets styles the hub markers by duty".

### Criterion 4 — Full gate green; no regressions
- All five gate commands pass; existing web suites unchanged behaviorally (duty styling is additive — volume-only hub features and prior `hubStyle` tests never set `dutyBucket`; the `ol/Map` node is never re-rendered, styling is a `feature.set('dutyBucket', …)` into the existing zero-alloc cache).

## Requirement → evidence map

| Req | Where delivered | Test evidence |
|---|---|---|
| VIZ-07 | `MapView.tsx`, `App.tsx`, `RightRail.tsx` | `MapView.browser.test.tsx`, `RightRail.test.tsx` |
| VIZ-08 | `HubDetail.tsx`, `useLiveSimMs.ts` | `HubDetail.test.tsx`, `useLiveSimMs.test.tsx` |
| VIZ-09 | `HubDetail.tsx` (reuses `TrailerDetail`) | `HubDetail.test.tsx` click-through |
| VIZ-10 | `useOpenExceptions.ts`, `HubDetail.tsx` | `useOpenExceptions.test.tsx`, `HubDetail.test.tsx` |
| VIZ-11 | `dutyColoring.ts`, `coloring.ts`, `layers.ts`, `Legend.tsx` | `dutyColoring.test.ts`, `coloring.test.ts`, `layers.test.ts`, `Legend.test.tsx`, `MapView.browser.test.tsx` |

## Constraints honored
- `ol/Map` in a ref, imperative from ws; map node never re-rendered.
- Strict TS, no `any`; reused `TrailerDetail`, WsProvider/wsClient store, `simClock`; matched existing visual language.
- Did NOT edit `.planning/ROADMAP.md` or `.planning/REQUIREMENTS.md`; did not merge or push.
