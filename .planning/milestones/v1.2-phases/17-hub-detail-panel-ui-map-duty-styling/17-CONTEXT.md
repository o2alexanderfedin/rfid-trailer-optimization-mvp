# Phase 17: Hub Detail panel UI + map duty styling - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; FRONTEND phase — design pre-approved by user)

<domain>
## Phase Boundary

Make hub icons **clickable** and render a **compact Hub Detail panel** in the right rail consuming the Phase-14 `GET /api/hubs/:id/detail`, with click-through to the existing VIZ-05 trailer plan; and **color hub markers** by driver duty distribution from the ws `HubState` buckets. This is the v1.2 demo payoff — driver HOS becomes visible.

**In scope:** VIZ-07..11. **OUT of scope:** README/screenshots (Phase 18).
</domain>

<decisions>
## Implementation Decisions (design pre-approved: COMPACT + click-through)

### Hub click → panel (VIZ-07)
- Extend `MapView.tsx`'s existing `forEachFeatureAtPixel` click handler to also detect `feature.get('hubId')` and invoke a new `onHubSelect(hubId)` callback (today it only reads `trailerId`). Wire `selectedHubId` through `App.tsx` → `RightRail.tsx`, mirroring the existing trailer-selection flow (VIZ-05). Hub features already carry `hubId`/`name` (`layers.ts`).
- New `HubDetail.tsx` panel; header shows hub name/id.

### Compact rows (VIZ-08) — approved layout
```
┌ Hub: Dallas (DAL) ────────────────┐
│ 3 trucks here · click row for plan │
├────────────────────────────────────┤
│ ▸ TRL-014  ⬤ docked   dwell 12m    │
│    util 78% · 9 pkgs · → ATL ~14m   │
│    driver D003 ⬤ resting · 0m left  │
│ ▸ TRL-022  ⬤ arrived  dwell 3m     │
│    util 64% · 6 pkgs · → ORD ~31m   │
│    driver D007 ⬤ driving · 214m left│
│  (ETA ~ = estimate)                 │
└────────────────────────────────────┘
  click a row → full rear→nose plan (VIZ-05)
```
- Each row: trailer id + operational status + **live elapsed dwell** (compute `simMs − arrivedAtMs` from the ws `simMs`, tick live — reuse `simClock.ts`); utilization %, package count, next hub + **estimated** ETA (mark estimates clearly); and the assigned **driver's duty status + remaining legal drive minutes** (the v1.2 hero datum) shown as a number AND a duty color/bucket.

### Click-through + exceptions (VIZ-09, VIZ-10)
- Clicking a row opens the existing VIZ-05 `TrailerDetail` (full rear→nose plan + instructions + explanation) — reuse the component, don't duplicate.
- Show open exceptions per trailer by filtering the already-streamed ws `exceptionsOpen` by `entityId === trailerId` (no extra fetch; per the grounding, `entityId` carries only trailerId).

### Map duty styling (VIZ-11)
- Color hub markers by driver-duty distribution from the ws `HubState` buckets (`driverCount`/`onBreakCount`/`restingCount`, added in Phase 14) — e.g. a hub whose drivers are all resting reads distinctly. Extend `coloring.ts`/`layers.ts`; add to `Legend.tsx` if appropriate.

### Tests + conventions
- Keep the `ol/Map` in a ref, driven imperatively (never re-render the map node). Reuse the WsProvider/wsClient store. **TDD:** `ui` (jsdom + RTL + MSW) tests for `HubDetail` (fetch + render + live dwell + click-through), and a `browser` (Chromium) test for hub-click selection + marker styling (mirror `MapView.browser.test.tsx`). Run BOTH `pnpm test:all` AND `pnpm test:browser`.

### Claude's Discretion
Exact styling, component decomposition, whether dwell uses a shared hook — follow `TrailerDetail.tsx`/`RightRail.tsx`/`MapView.tsx` conventions. Match the existing visual language (don't introduce a new design system).
</decisions>

<code_context>
## Existing Code Insights

### Reuse / analogs
- `packages/web/src/panels/TrailerDetail.tsx` (VIZ-05 panel — `fetchTrailerPlan` + render; the click-through target) + `RightRail.tsx` (panel host, accepts `selectedTrailerId` today — add `selectedHubId`).
- `packages/web/src/map/MapView.tsx` (click handler L~164-181 reads only `trailerId`; extend for `hubId`), `layers.ts` (hub features w/ `hubId`/`name`, feature id `hub:{id}`), `coloring.ts` (bucket→color), `Legend.tsx`, `simClock.ts` (sim time), `WsProvider.tsx`/`wsClient.ts` (ws store incl. `simMs`, `HubState`, `exceptionsOpen`).
- Phase-14 `GET /api/hubs/:id/detail` DTO (trailers at hub + status/dock + driver duty + remaining drive minutes + util + arrivedAtMs + nextHubId + estimated ETA) and ws `HubState` driver buckets.

### Established Patterns
- React 19 + OpenLayers 10; map in a ref driven imperatively from ws; panels fetch-on-select (REST) + live ws state; jsdom `ui` tests (RTL + MSW) + Chromium `browser` tests for the map.
</code_context>

<specifics>
## Specific Ideas

Reqs: **VIZ-07, VIZ-08, VIZ-09, VIZ-10, VIZ-11**. Full verified UI integration map: `.planning/research/v1.2-HUB-DETAIL-GROUNDING.md` (the click-wiring, RightRail, layers hub features, simMs dwell). The hero datum is **driver duty status + remaining legal drive time** — make it prominent. ETAs are estimates — label them.

**Note:** Do NOT edit `.planning/ROADMAP.md` or `.planning/REQUIREMENTS.md` — the orchestrator manages those.
</specifics>

<deferred>
## Deferred Ideas
- README supported-features list + screenshots (captured from this running UI) → Phase 18.
</deferred>
