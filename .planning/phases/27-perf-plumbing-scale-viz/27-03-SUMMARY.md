---
phase: 27-perf-plumbing-scale-viz
plan: "03"
subsystem: web-map-viz
tags: [viz, clustering, tier-styles, openLayers, VIZ-15, VIZ-16]
dependency_graph:
  requires: [packages/simulation/src/network/centers.ts, packages/api/src/app.ts]
  provides: [clustered-hub-layer, tier-branched-styles, legend-tier-sections]
  affects: [packages/web/src/map/layers.ts, packages/web/src/map/MapView.tsx, packages/web/src/map/coloring.ts]
tech_stack:
  added: [ol/source/Cluster, VectorImageLayer(declutter:true)]
  patterns: [pre-allocated-style-cache, hub-partition-kind, rgba-opacity-encoding]
key_files:
  created:
    - packages/web/test/scale-viz.unit.test.ts
  modified:
    - packages/simulation/src/index.ts
    - packages/api/src/app.ts
    - packages/api/src/routes/queries.ts
    - packages/web/src/map/coloring.ts
    - packages/web/src/panels/Legend.tsx
    - packages/web/src/map/layers.ts
    - packages/web/src/map/MapView.tsx
    - packages/web/src/map/layers.test.ts
decisions:
  - "rgba() opacity encoding in stroke color string (OL 10 Style Options has no top-level opacity property)"
  - "HubLayers interface exposes both unified source (for metric updates) + tier sources (for layer styling)"
  - "Backbone-color assertion in test uses regex match on rgba since style encodes opacity in rgba string"
metrics:
  duration: "~50 minutes"
  completed: "2026-06-27"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 9
---

# Phase 27 Plan 03: Scale Visualization — Cluster + Tier Styles (VIZ-15/VIZ-16) Summary

## One-liner

VectorImageLayer+Cluster for 80-130 spoke field clustering (VIZ-15) + four visual tiers via size/ring/weight (NOT hue) with REST-only isBackbone/kind/tier DTO fields and pre-allocated zero-frame-alloc cached styles (VIZ-16).

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Tier DTO fields (kind/tier + isBackbone) | fe6f94c | `packages/simulation/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/routes/queries.ts` |
| 2 | Tier-branched cached styles + legend (VIZ-16) | c7b4600 | `packages/web/src/map/coloring.ts`, `packages/web/src/panels/Legend.tsx`, `packages/web/test/scale-viz.unit.test.ts` |
| 3 | Clustered/decluttered hub layer + center tier (VIZ-15) | c81dec2 | `packages/web/src/map/layers.ts`, `packages/web/src/map/MapView.tsx`, `packages/web/src/map/layers.test.ts` |

## What Was Built

### VIZ-16 — Four Visual Tiers (Task 1+2)

**API tier DTO fields (REST-only, never on ws payload):**
- `HubDto.kind: "center" | "spoke"` — derived from `deriveCenterPartition()` at server startup
- `HubDto.tier?: number` — 1 for centers, 2 for spokes
- `RouteDto.isBackbone: boolean` — derived from the backbone leg id set at server startup

**Tier-branched cached styles** (`packages/web/src/map/coloring.ts`):
- Center markers: radius 20px + amber `#f59e0b` 3px ring, pre-allocated per volume bucket
- Spoke markers: radius 12px + white `#ffffff` 2px ring, pre-allocated per volume bucket
- Backbone legs: `rgba(203,213,225,0.9)` stroke, 4px width (pre-allocated constant)
- Spoke legs: `rgba(148,163,184,0.55)` stroke, 2px width (pre-allocated constant)
- Duty-tier caches: center+spoke variants for driver duty overlay (CENTER_DUTY_STYLE_CACHE / SPOKE_DUTY_STYLE_CACHE)
- Legend constants: `HUB_TIER_LABELS`, `HUB_TIER_RING_COLORS`, `LEG_TIER_LABELS`, `LEG_TIER_COLORS`
- `hubStyleTiered(feature)`: tier-branch outermost → duty → volume → default (zero alloc)
- `routeStyleTiered(feature)`: isBackbone-branch → risk → load → default (zero alloc)

**Legend extended** (`packages/web/src/panels/Legend.tsx`):
- Added "Hub tier" section: Regional center (amber ring) / Spoke hub (white ring)
- Added "Route tier" section: Backbone / Spoke leg

### VIZ-15 — Clustered/Decluttered Hub Layer (Task 3)

**`HubLayers` interface** (`packages/web/src/map/layers.ts`):
```typescript
interface HubLayers {
  readonly centerLayer: VectorLayer;      // un-clustered tier-1 (≤8 centers)
  readonly spokeLayer: VectorImageLayer;  // clustered + declutter tier-2 spoke field
  readonly source: VectorSource;          // unified — for applyHubBuckets metric updates
  readonly centerSource: VectorSource;    // tier-1 features only
  readonly spokeSource: VectorSource;     // tier-2 features only (fed to Cluster)
}
```

**Spoke cluster layer:**
- `Cluster({ distance: 40, minDistance: 20, source: spokeSource })`
- `VectorImageLayer({ source: clusterSource, style: clusterStyle, declutter: true })`
- 4 pre-allocated `CLUSTER_STYLES` (radii 14/17/20/22, log-bucketed by member count)
- `clusterStyle`: count>1 → log-bucket size + setText(count); count=1 → delegate to hubStyleTiered

**MapView.tsx layer insertion order:** routes(1) / spokeLayer(2) / centerLayer(3) / trailers above

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Completeness] OL 10 Style has no top-level opacity option**
- **Found during:** Task 2 (coloring.ts)
- **Issue:** `error TS2353: 'opacity' does not exist in type 'Options'` — OL 10 does not support opacity as a Style constructor option. Opacity is a layer-level property; per-style opacity must be encoded in the color's alpha channel.
- **Fix:** Used rgba() strings for backbone and spoke leg stroke colors: `rgba(203,213,225,0.9)` for backbone (≈#cbd5e1 @ 90%) and `rgba(148,163,184,0.55)` for spoke leg (≈#94a3b8 @ 55%).
- **Files modified:** `packages/web/src/map/coloring.ts`
- **Test update:** Fixed scale-viz.unit.test.ts backbone-color assertion to accept either the hex or the rgba encoding using a regex pattern.
- **Commit:** c81dec2

**2. [Rule 3 - Missing export] `deriveCenterPartition` not exported from @mm/simulation**
- **Found during:** Task 1 (app.ts / queries.ts compilation)
- **Issue:** `deriveCenterPartition`, `DEFAULT_CENTER_COUNT`, `generateBigCityHubs`, `pickRegionalCenters`, `buildBackbone`, `CenterPartition`, `BackboneLeg` were not in the simulation package public index.
- **Fix:** Added all needed exports to `packages/simulation/src/index.ts`.
- **Files modified:** `packages/simulation/src/index.ts`
- **Commit:** fe6f94c

**3. [Rule 1 - Bug] Missing required `kind` and `isBackbone` fields on test fixtures**
- **Found during:** Task 3 (layers.test.ts compilation)
- **Issue:** `TS2741: Property 'kind' is missing in type '...' but required in type 'HubDto'`; similar for `isBackbone` on RouteDto.
- **Fix:** Updated `hub()` fixture helper to accept optional `kind` (default `"spoke"`) + derive `tier`; updated `route()` fixture to accept optional `isBackbone: false`; updated MSW handlers (`packages/web/test/msw/handlers.ts`) HUBS and ROUTES with all required fields.
- **Commit:** c81dec2

## Verification

- All 33 determinism tests pass — golden hashes `3920accc`/`94689f99`/`edfa5a6d` byte-identical
- 194 web unit tests pass (14 test files)
- 318 api unit tests pass (30 test files)
- `packages/web` TypeScript clean (zero errors)
- `packages/api` TypeScript clean (zero errors)
- Web production build clean: 246 modules, 560 kB bundle, gzip 167 kB
- Pre-existing typecheck errors in `projections-golden-replay.int.test.ts`, `induction-deadline.unit.test.ts`, `trailer-fuel-rebuild.unit.test.ts`, `vite.config.ts` — all pre-existing, not caused by this plan

## Threat Flags

None. All changes are frontend rendering (coloring, layer structure) or read-only REST DTO additions. No new network endpoints, auth paths, or schema changes introduced.

## Known Stubs

None. Both `kind`/`tier` (hub) and `isBackbone` (route) are wired to live `deriveCenterPartition()` data at server startup.

## Self-Check: PASSED

- `packages/web/src/map/coloring.ts` — exists, exports hubStyleTiered/routeStyleTiered/tier constants
- `packages/web/src/map/layers.ts` — exists, exports HubLayers interface + createHubLayer returning HubLayers
- `packages/web/src/panels/Legend.tsx` — exists, renders Hub tier + Route tier sections
- `packages/web/test/scale-viz.unit.test.ts` — exists, 25 tests (25 passed in 194 total)
- `packages/api/src/app.ts` — exists, exports kind/tier on HubDto
- `packages/api/src/routes/queries.ts` — exists, exports isBackbone on RouteDto
- Commit fe6f94c: confirmed present (git log)
- Commit c7b4600: confirmed present (git log)
- Commit c81dec2: confirmed present (git log)
