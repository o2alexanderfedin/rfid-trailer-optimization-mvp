# Architecture Research — Milestone v1.1 "Realistic Time Model + Hardening"

**Researched:** 2026-06-21 (inline, codebase-grounded)
**Confidence:** HIGH — integration points verified against real source + the workspace dependency graph.

## Dependency graph (verified)

```
@mm/domain          (base leaf — NO @mm/* deps)
   ├── @mm/simulation   (deps: domain, event-store, projections)   ← draws random timing
   └── @mm/optimizer    (deps: domain, load-planner)               ← needs deterministic timing
@mm/api               (deps: ALL — composition root / wiring)
```

**Key fact:** `@mm/simulation` and `@mm/optimizer` do **not** depend on each other. So the shared timing config cannot live in either without risking a cross-import.

## Decision 1 — Shared timing source of truth (resolves OPT-10 + DRY)

`TimingConfig` / `DEFAULT_TIMING_CONFIG` currently live in `@mm/simulation/src/timing.ts`. The optimizer must derive its deterministic estimate from the **same** numbers.

**Move the config + a pure estimator into `@mm/domain`** (the leaf both already import):
- `@mm/domain`: `LogNormalParams`, `TimingConfig`, `DEFAULT_TIMING_CONFIG`, and a **pure** `expectedMinutes(p: LogNormalParams): number` = `clamp(p.median * Math.exp(p.sigma**2 / 2), p.min, p.max)`. No RNG, no clock — fits domain's purity rule.
- `@mm/simulation/timing.ts`: keeps `sampleLogNormal(rng, params)` (needs `Rng`), now importing the config types from `@mm/domain` instead of defining them.
- `@mm/optimizer` (or the `@mm/api` wiring): imports `expectedMinutes` + config from `@mm/domain` to compute the deterministic `travelMin` / dwell service time.

This guarantees: change one config → both the random sim draw AND the deterministic plan estimate move together. No circular dep. (Alternative: `@mm/api` computes estimates and passes them in — also viable since api wires both — but domain placement is the cleaner DRY answer and keeps the estimator unit-testable in isolation.)

## Decision 2 — Time-expanded graph wiring (OPT-09)

Two distinct injections in `packages/optimizer/src/graph/`:

1. **Transit → `OptimizerRoute.travelMin`.** `time-expanded.ts` already uses `route.travelMin` for BOTH the arrival timestep (`ceilToStep(departMin + travelMin)`, line 162) and trip cost (`tripCostPerMin * travelMin`, line 172). So feeding the *expected* (and TIME-01 distance-derived) transit into `travelMin` is a clean, localized change — no graph-shape change. Source of `travelMin`: `buildTravelModel(twin.routes)` (`epoch.ts:347`) and `OptimizerRoute` construction in `flow/freight-stage.ts:118`.
2. **Dwell → service time (NEW concept).** There is currently **no `serviceMin`** in `OptimizerScope`/graph types — dwell is only a flat per-timestep `waitCost`. To make the optimizer respect that a trailer must dwell at a hub before re-departing, introduce a **minimum service offset**: when building `trip` edges, the earliest feasible departure node = `arrival + expectedDwell(hubRole)` rounded to the step grid. This is the **design-heavy** part (DESIGN-required in the brief) and should be its own carefully-tested task. Options: (a) add `serviceMin` per hub to scope and offset trip-edge tails; (b) raise `waitCost` to reflect dwell duration (weaker — affects cost not feasibility). Prefer (a) for correctness.

**Hub role:** the graph needs to know which hub is the center (for `dwellCenter` vs `dwellSpoke`). The center is `hubs[0]` (Memphis) per `routes.ts`; expose hub role to the optimizer scope/network (it currently only has `hubId`).

## Decision 3 — Road geometry seam (VIZ-06 + TIME-01)

`routes.ts::buildRoutes` returns `Route { routeId, fromHubId, toHubId, geometry }` — geometry is the ONLY road-shaped field; the domain `Route` has no distance/travel. Downstream (ws protocol → web animation) consumes `geometry` shape-agnostically. So:
- Swap `greatCircle(...)` for loading precomputed static GeoJSON (`road-geometry.generated.json`). **Geometry shape unchanged** (still `[lon,lat][]`) → ws + OpenLayers animation untouched.
- The precomputed per-leg `distance_m` becomes the new input to TIME-01's transit median: `median_transit(leg) = distance_km / avgHgvKmh * 60`, with σ from config. This connects VIZ-06 → TIME-01.

## Decision 4 — Center re-dispatch dwell (TIME-02)

In the simulator's modeled cycle, center arrival is currently a terminal unload (no re-dispatch dwell site), so `dwellCenter` never fires. Insert a distinct **center dwell + re-dispatch** step so a trailer/freight passing through the center incurs `dwellCenter` (≈65 min expected) before its next leg. Must not double-count with spoke dwell (see PITFALLS).

## Decision 5 — parseEnvelope hardening (HRD-01, trivial)

`wsClient.ts:65` `if (!isSimSpeedState(r["speed"])) return null;` drops the whole envelope. Change: if `speed` is missing/invalid but `v/type/seq/simMs/payload` are valid, **synthesize a `DEFAULT_SPEED`** and accept the envelope, emitting a one-time `console.warn` (observability, not silent masking). Keep returning `null` for genuinely malformed envelopes (bad v/type/seq).

## New vs modified components

| Component | New / Modified | Notes |
|-----------|----------------|-------|
| `@mm/domain` timing config + `expectedMinutes` | **New** (moved/added) | Shared source of truth; pure. |
| `@mm/simulation/timing.ts` | Modified | Import config from domain; keep sampler. |
| `packages/simulation/src/network/road-geometry.generated.json` | **New** | Precomputed ORS polylines + distance/duration. |
| `scripts/precompute-routes.ts` | **New** (dev) | Offline ORS fetch → static JSON + checksum. |
| `routes.ts` | Modified | Load static geometry; expose per-leg distance. |
| Simulation timing/network wiring (transit medians, center dwell) | Modified | TIME-01, TIME-02. |
| `@mm/optimizer` graph types + `time-expanded.ts` | Modified | Add service-time offset; feed expected `travelMin`. |
| `epoch.ts` / `freight-stage.ts` travel model | Modified | Derive `travelMin` from expected/distance estimate. |
| `wsClient.ts` `parseEnvelope` | Modified | DEFAULT_SPEED fallback + warn-once. |
| `wsClient` tests | **New/Modified** | QA-01 coverage. |

## Suggested build order (dependency-respecting)

1. **Shared timing config + `expectedMinutes` in `@mm/domain`** (foundation for everything; pure, fully unit-testable). Re-point simulation to it (no behavior change → keystone stays green).
2. **Road-following routes (VIZ-06)** — precompute script + static GeoJSON + `routes.ts` swap, exposing per-leg distance. (Independent of optimizer; verifiable on the map.)
3. **Distance-derived transit (TIME-01) + center re-dispatch dwell (TIME-02)** — simulation-side time model, building on (1)+(2). Re-baseline sim fixtures honestly.
4. **Optimizer consumes timing (OPT-09 + OPT-10)** — the meaty core; depends on (1) for `expectedMinutes` and (3) for a defensible time model. Add `serviceMin` offset + expected `travelMin`. **Carefully** re-baseline the scenario-reopt keystone (distinguish intended change from regression).
5. **Hardening + coverage (HRD-01 + QA-01)** — independent; can run any time, naturally last.

## Sources
- `packages/{simulation,optimizer,domain,api}/package.json`; `packages/optimizer/src/graph/{time-expanded,types}.ts`; `packages/optimizer/src/rolling/{epoch,types}.ts`; `packages/optimizer/src/flow/freight-stage.ts`; `packages/optimizer/src/vrptw/types.ts`; `packages/simulation/src/{timing.ts,network/routes.ts}`; `packages/web/src/map/wsClient.ts`; `packages/domain/src/entities/index.ts`.
