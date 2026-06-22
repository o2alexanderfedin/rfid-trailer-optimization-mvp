# Phase 6: Realistic Geography & Time Model - Context

**Gathered:** 2026-06-21
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous, auto-optimized) — grey-area answers pre-resolved from the v1.1 research (`.planning/research/`) and auto-accepted.

<domain>
## Phase Boundary

Make the simulation's geography and time model realistic and establish the shared deterministic timing foundation the optimizer will later consume. In scope: precomputed road-following route geometry (VIZ-06), per-leg distance/duration-derived transit medians (TIME-01), a distinct center-hub re-dispatch dwell (TIME-02), and the enabling move of the timing config + a pure `expectedMinutes()` estimator into `@mm/domain`.

OUT of this phase: the optimizer consuming the timing (Phase 7), client hardening + coverage (Phase 8). Determinism is mandatory; TDD; strict TS (no `any`).
</domain>

<decisions>
## Implementation Decisions

### Area 1 — Road-following route geometry (VIZ-06)
- Use OpenRouteService **`driving-hgv`** profile, fetched **offline at precompute time only** — never at sim/plan runtime (determinism).
- Output: GeoJSON LineString per directed leg, written to a **committed static file** (e.g. `packages/simulation/src/network/road-geometry.generated.json`) keyed by `routeId`, carrying geometry + ORS `summary.distance` (m) + `summary.duration` (s).
- A dev script (e.g. `scripts/precompute-routes.ts`) reads hubs from `hubs.ts`, calls ORS with an API key from an env var (build-time secret, never shipped), and writes the file.
- **Resilience:** if a leg's ORS call fails, fall back to `greatCircle` for that leg and warn — the build never hard-breaks. Store a checksum of the hub coordinates alongside the geometry so drift (hub moved, geometry stale) is test-detectable.
- Geometry stays `[lon, lat][]` (GeoJSON axis order) and endpoints snap exactly to hub coords — so the ws protocol + OpenLayers animation are untouched (shape-agnostic seam). Simplify/bound vertex count per leg to keep payload reasonable.

### Area 2 — Distance-derived transit (TIME-01)
- Each leg's transit **median** = ORS `summary.duration` (seconds → minutes) for that leg. Using ORS duration directly (it already reflects road speed/geometry) is more realistic and simpler than assuming a flat average HGV speed over `summary.distance`. (Distance is stored too, for reference / an alternative speed-based derivation if needed.)
- Spread (σ) stays from config (transit σ = 0.3); only the **median** becomes per-leg. The log-normal sampler is unchanged — it just receives per-leg `LogNormalParams`.
- Clamp scales off the per-leg median (e.g. `min = max(5, round(median·0.4))`, `max = round(median·3)`) so long coast legs aren't clipped by the old global `[10, 120]` band.

### Area 3 — Center-hub re-dispatch dwell (TIME-02)
- Center hub = `hubs[0]` (Memphis), the existing convention in `routes.ts`/`hubs.ts`.
- A trailer/freight passing through the center incurs `dwellCenter` (≈65 min expected) **exactly once** at the re-dispatch boundary; spoke stops use `dwellSpoke`. Dwell is keyed by hub role — no double-count with a generic dwell (PITFALLS P4).

### Area 4 — Shared timing source of truth (enabling infra)
- Move `LogNormalParams`, `TimingConfig`, `DEFAULT_TIMING_CONFIG` and a **pure** `expectedMinutes(p: LogNormalParams): number = clamp(p.median · exp(p.sigma² / 2), p.min, p.max)` (the clamped log-normal MEAN) into `@mm/domain` (the leaf both `@mm/simulation` and `@mm/optimizer` import — avoids a circular dep).
- `@mm/simulation/timing.ts` re-imports the config/types from `@mm/domain`; `sampleLogNormal` (needs `Rng`) stays in simulation.
- **No sampler behavior change in this phase** — the golden-replay keystone must stay green. `expectedMinutes` is added now (unit-tested) and consumed by the optimizer in Phase 7.

### Claude's Discretion
- Exact ORS endpoint/response-schema details and library version pins (resolve during plan-phase research).
- Exact file layout of the precompute script + generated JSON, vertex-simplification threshold, and clamp constants — at Claude's discretion within the decisions above.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/simulation/src/timing.ts` — `sampleLogNormal(rng, params)` (Box–Muller), `LogNormalParams`, `TimingConfig`, `DEFAULT_TIMING_CONFIG` (dwellSpoke median 25 / dwellCenter median 60 / transit median 30; all σ 0.3–0.4; minutes).
- `packages/simulation/src/network/routes.ts` — `greatCircle(a, b, n)` (pure slerp), `buildRoutes(hubs)` (hub-and-spoke; center = `hubs[0]`); `Route { routeId, fromHubId, toHubId, geometry }` (geometry is the only road-shaped field).
- `packages/simulation/src/network/hubs.ts` — hub coordinates (precompute input).
- `Rng` (seeded) — `packages/simulation/src/rng.js`.

### Established Patterns
- Pure functions, NO `Date.now()` / `Math.random()` outside the seeded `Rng`; static geometry committed for byte-identical replay.
- Integer/deterministic discipline; `@mm/domain` is the shared base leaf (no `@mm/*` deps).
- Minutes are the canonical time unit (1 tick = 1 minute).

### Integration Points
- `routes.ts` — swap `greatCircle` generation for loading the precomputed static GeoJSON; expose per-leg distance/duration.
- `timing.ts` — import config from `@mm/domain`; per-leg transit medians from precomputed duration; center dwell wiring.
- `@mm/domain` entities/index — new home for timing config + `expectedMinutes`.
- The simulation engine cycle — where center re-dispatch dwell is inserted (TIME-02).
</code_context>

<specifics>
## Specific Ideas

- ORS `driving-hgv`; use ORS `summary.duration` as the per-leg transit median; center hub = Memphis (`hubs[0]`).
- Keep the v1.0 "precompute → committed static data" determinism strategy (mirrors how `greatCircle` geometry is already deterministic).
</specifics>

<deferred>
## Deferred Ideas

- Optimizer consuming the expected timing (`expectedMinutes` → `travelMin` + service-time offset) — **Phase 7**.
- Service-level / percentile transit estimate (vs the mean) — future robustness knob, out of v1.1 scope.
- Speed-based transit derivation from `summary.distance` (alternative to using ORS duration directly) — only if duration proves unsuitable.
- HGV hours-of-service / break modeling — out of scope (absorbed into medians).
</deferred>
