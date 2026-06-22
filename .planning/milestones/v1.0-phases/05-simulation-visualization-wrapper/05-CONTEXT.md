# Phase 5: Simulation + Visualization Wrapper — Context

**Gathered:** 2026-06-19
**Status:** Ready for UI-spec + planning
**Mode:** Autonomous (decisions from 05-RESEARCH.md + REQUIREMENTS acceptance criteria + sensible product defaults; assumptions flagged for redirect)

<domain>
## Phase Boundary

The persuasive live demo that composes every prior phase: an animated realtime USA map (OpenLayers/OSM) colored by state, click-through to a trailer's load plan + "why", a streaming exception feed, a read-only audit timeline, operator scenario knobs that drive **visible re-optimization**, and the before/after KPI "money slide" proving the optimizer beats the baseline.

Requirements: **SIM-04, VIZ-02, VIZ-03, VIZ-04, VIZ-05, UI-01, UI-02, UI-03, UI-04** (9), PLUS the **OPT-02/05/06/07 live-wiring** carried from Phase 4 — a live rolling-optimizer loop + repair endpoint is the backend SIM-04's "visible re-optimization" depends on.

Builds on the shipped Phase-1 map slice (`packages/web/src/map/`, `ws/snapshots.ts`, `geo-track.ts`) — current code teleports trailers to the latest keyframe; this phase adds client-side tweening, a widened ws envelope, panels, and the optimizer live loop, preserving the existing leak guard.
</domain>

<decisions>
## Implementation Decisions (architecture — from 05-RESEARCH.md, Google AI Mode + ol 10 docs)

- **VIZ-02 animation:** `VectorLayer` + in-place geometry mutation (NOT WebGL — demo is ~20–50 trailers); interpolate via `ol` `postrender` + `frameState.time` → sim-clock fraction clamped [0,1] → `LineString.getCoordinateAt(fraction)` to follow the route; resync by re-anchoring keyframes to the shared sim clock (no vertex snapping). WebGL is the >2,000-point escape hatch only.
- **VIZ-04 ws protocol:** versioned envelope — full `snapshot` on connect/resync + per-tick `tick` delta carrying ONLY changed fields (trailer leg/timing keyframes, hub/route metric buckets, exception new/resolved, KPI partials, plan deltas); `seq`+`simMs` for drop-detection + clock resync. Pushed per sim tick / on-event, never per-raw-event (Anti-Pattern 4). The rolling-service also broadcasts on re-optimization.
- **VIZ-03 coloring:** pre-allocated `STYLE_CACHE: Style[]` keyed by integer metric bucket; `StyleFunction` returns cached refs (zero per-frame allocation); legend from the same COLORS/BUCKETS arrays; update via `feature.set(bucket)`, never source rebuild.
- **P10 leak discipline:** keep all Phase-1 invariants (single source, in-place mutation, map-once-in-ref, strict disposal incl. new overlays); multi-minute headed-Playwright soak asserting flat `usedJSHeapSize` after forced GC.
- **OPT live-wiring:** add a `RollingOptimizerService` live loop (periodic + event-triggered, reusing Phase-4 `runEpoch`/`scope`/`twin`/`freeze`); surface repair recommendations via `GET /api/optimizer/recommendations`; wire min-cost-flow on the live freight-assignment path. The rolling loop writes plan events (OCC-safe) and broadcasts diffs.
- **KPI plumbing (UI-03/UI-04):** `GET /api/kpis` (utilization, rehandle count/min, wrong-trailer, missed-unload, SLA-violation rate, on-time depart/arrive) + `GET /api/kpis/comparison` (baseline vs optimizer on the same seeded stream, with deltas) — reuse Phase-2 baseline + load-planner scores + Phase-3 exception counts. Seed-deterministic.
- **Stack:** React 19 + Vite + `ol` 10.9; keep `ol/Map` in a `useRef`, drive imperatively from the ws stream (never React-re-render the map node). Fastify + native `ws` backend.

### Claude's Discretion — product defaults (ASSUMPTIONS, flagged for redirect)
- **Scenario knobs (SIM-04):** 4 operator controls — hub congestion, trip delay, demand spike, sensor-noise level — via `POST /api/scenario`; deterministic given seed; a knob change triggers a scoped re-optimization visible on map/feed/KPIs within bounded ticks.
- **Demo story / money slide (UI-04):** seeded run → operator injects a congestion/demand spike → optimizer repairs (split/reassign/hold/over-carry) visibly → money slide shows baseline-vs-optimizer deltas; scenario calibrated so the optimizer demonstrably wins on rehandle + SLA (not theater).
- **Layout:** map centerpiece + right-rail panels (alert feed, KPI dashboard, selected-trailer detail) + a toggle to the before/after money-slide view; clean, legible operator aesthetic (apply frontend-design principles: spacing, alignment, contrast).
</decisions>

<code_context>
## Existing Code Insights
- `packages/web/src/map/{MapView.tsx,layers.ts}` + `useTrailerSnapshots.ts` — Phase-1 map (static styles, teleport-to-keyframe). Extend, don't rebuild.
- `packages/api/src/ws/snapshots.ts` — current ws snapshot (trailer points + hub positions). Widen the envelope here.
- `packages/api/src/sim/driver.ts` — sim driver loop (now RFID-enabled); add scenario injection + rolling-loop hook here.
- `packages/optimizer/src/{rolling,flow,repair}` — Phase-4 libs to wire live; `packages/api/src/optimizer/rolling-service.ts` + `routes/optimizer.ts` exist (in-memory) — extend to a live loop + recommendations endpoint.
- `packages/api/src/routes/{queries,exceptions,plan}.ts` — read APIs to extend for KPIs/zone/plan-detail.
</code_context>

<specifics>
## Specific Ideas / Acceptance Criteria
Per-req acceptance criteria are in REQUIREMENTS.md + the milestone progress audit. Keystones for this phase: (1) a headed-Playwright **flat-memory soak** over a multi-minute animated run; (2) a **seed-deterministic KPI comparison** test proving the optimizer beats the baseline; (3) a **scenario-knob → visible re-optimization** e2e (knob change ⇒ changed plan + pushed state diff).
</specifics>

<deferred>
## Deferred / Out of Scope (v2)
- VIZX/OPS v2 requirements. WebGL trailer rendering (only if counts exceed ~2,000). Multi-user/auth. Real WMS/TMS/RFID hardware.
</deferred>
