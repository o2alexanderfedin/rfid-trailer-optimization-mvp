# Phase 17 — Hub Detail panel UI + map duty styling — PLAN

**Milestone:** v1.2
**Branch:** `feature/phase-17-hub-detail-panel-ui-map-duty-styling`
**Type:** FRONTEND (React 19 + OpenLayers 10), design pre-approved (compact rows + click-through)
**Requirements:** VIZ-07, VIZ-08, VIZ-09, VIZ-10, VIZ-11
**Method:** TDD (RED → GREEN → refactor). Reuse VIZ-05 `TrailerDetail`, the WsProvider/wsClient store, and `simClock`. Keep `ol/Map` in a ref, imperative from ws.

## Goal

Make hub icons clickable and render a compact Hub Detail panel in the right rail that consumes the Phase-14 `GET /api/hubs/:id/detail`, with click-through to the reused VIZ-05 trailer plan; and color hub markers by driver-duty distribution from the ws `HubState` buckets. The v1.2 demo payoff: driver HOS becomes visible.

## Approach (cite the analogs)

| Concern | Analog reused | New work |
|---|---|---|
| Hub click → select | `MapView.tsx` `forEachFeatureAtPixel` click handler (read `trailerId`) | Detect `feature.get('hubId')` → new `onHubSelect`; hub hit takes priority; thread `selectedHubId` `App.tsx` → `RightRail` |
| Panel + fetch-on-select | `TrailerDetail.tsx` `useTrailerPlan` + branchy render | `HubDetail.tsx` + `useHubDetail` over `fetchHubDetail` |
| Live dwell | `simClock.ts` (`makeSimClock`), `MapView.onEnvelope` resync+setSpeed | `useLiveSimMs` hook — server-anchored sim clock on the React render path, ticks 1s |
| Exceptions per row | ws `exceptionsOpen` / `exceptionsNew`/`Resolved` (`App.tsx` alert wiring) | `useOpenExceptions` — open set filtered by `entityId === trailerId` (no extra fetch) |
| Click-through plan | `TrailerDetail` (VIZ-05) | `HubDetail` row click sets `openTrailerId` → renders `TrailerDetail` + a back affordance |
| Duty hub coloring | `coloring.ts` `hubStyle` zero-alloc cache, `layers.ts` `applyHubBuckets`, `Legend.tsx` | `dutyColoring.ts` (`classifyDutyBucket` + `DUTY_COLORS`); `hubStyle` prefers `dutyBucket`; `applyHubBuckets` derives it; Legend driver-duty section |

## Tasks (TDD order)

1. **API client** — add `HubTrailerDriverDto` / `HubTrailerDto` / `HubDetailDto` + `fetchHubDetail` (mirror server DTO in `packages/api/src/routes/hub-detail.ts`; empty hub is valid, not 404).
2. **VIZ-11 duty coloring (pure)** — `dutyColoring.ts` (`DUTY_COLORS`, `DUTY_BUCKET_LABELS`, `classifyDutyBucket`, `hubHasDriverData`). Test first.
3. **VIZ-11 hub style + apply** — `coloring.ts` `hubStyle` prefers `dutyBucket` (fallback volume); `layers.ts` `applyHubBuckets` derives + sets `dutyBucket`. Tests added to `coloring.test.ts` + `layers.test.ts` (existing volume tests unchanged).
4. **VIZ-11 Legend** — driver-duty section from the single source of truth.
5. **Live clock hook** — `useLiveSimMs` (subscribe ws, resync, 1s interval). Test with fake timers.
6. **VIZ-10 exceptions hook** — `useOpenExceptions` (pure helpers + hook). Test.
7. **VIZ-08/09 panel** — `HubDetail.tsx` (compact rows: status, live dwell, util %, pkg count, next hub + EST eta, driver duty + remaining drive minutes as number AND bucket; click-through to `TrailerDetail`; per-row exceptions badge). Pure formatters tested + render branches via RTL + MSW.
8. **VIZ-07 wiring** — `MapView` `onHubSelect`; `App.tsx` `selectedHubId` (mutually exclusive with trailer); `RightRail` Hub tab + `HubDetail` host.
9. **CSS** — `index.css` hub-detail rows (match the dark operator aesthetic).
10. **Browser test** — hub-click selection + duty `dutyBucket` styling in real Chromium (mirror `MapView.browser.test.tsx`).

## Success criteria

1. Clicking a hub opens a Hub Detail panel (header hub id) in the right rail — VIZ-07.
2. Each trailer row shows status, live dwell, util %, pkg count, next hub + clearly-estimated ETA, and the driver's duty status + remaining legal drive minutes (number AND bucket) — VIZ-08; click-through reuses VIZ-05 `TrailerDetail` — VIZ-09; per-row open exceptions from ws `exceptionsOpen` — VIZ-10.
3. Hub markers color by driver-duty distribution from the ws driver buckets; Legend updated — VIZ-11.
4. Gate green: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all`, `pnpm test:browser`; existing web tests still pass.

## Constraints honored

- `ol/Map` stays in a ref, driven imperatively; the map node is never re-rendered (duty styling is `feature.set('dutyBucket', …)` → existing zero-alloc `hubStyle`).
- Strict TS, no `any`. Reuse `TrailerDetail`, WsProvider/wsClient, `simClock`. No new design system.
- Did NOT edit `.planning/ROADMAP.md` or `.planning/REQUIREMENTS.md`.
