# Stack Research — Milestone v1.1 "Realistic Time Model + Hardening"

**Researched:** 2026-06-21
**Method:** Inline (main-loop) research grounded in the codebase — the 4 parallel research subagents were lost to a transient Anthropic 529 overload wave; the main loop was unaffected, so research was done directly against source. Exact library versions are deferred to per-phase `/gsd-plan-phase` research (gsd-phase-researcher) where Context7/web can pin them.
**Confidence:** HIGH on "no new runtime deps + precompute-to-static-GeoJSON". MEDIUM on exact ORS endpoint/version specifics (pin at plan-phase).

## Headline

**v1.1 needs essentially NO new runtime dependencies.** The only external system is OpenRouteService (ORS), used **offline at precompute time only** — a dev script fetches `driving-hgv` road geometry between the 10 hubs once and writes a static GeoJSON committed to the repo. Runtime stays pure, deterministic, single-language TS/Node, exactly as v1.0.

## Additions (with dev-vs-runtime classification)

| Item | Version | Dev or Runtime | Rationale |
|------|---------|----------------|-----------|
| OpenRouteService Directions API (`driving-hgv` profile) | public REST API (api.openrouteservice.org) — pin endpoint at plan-phase | **Precompute-time only** (NOT a dependency) | Returns road-following geometry + `summary.distance` (m) + `summary.duration` (s) per leg. Free-tier API key is a build-time secret (env var in the script), never shipped. |
| Node built-in `fetch` | Node 22 (already present) | n/a | The precompute script calls ORS with global `fetch` — no HTTP client dep needed. |
| `@turf/length` (optional) | turf 7.x — pin at plan-phase | **devDependency** (precompute only) | Only if we want to recompute per-leg length from geometry. **Likely unnecessary** — ORS already returns `summary.distance`. Prefer storing ORS distance/duration directly (KISS). |

## Existing capabilities to reuse (do NOT re-add)

- **Determinism strategy** — v1.0 already commits static, byte-identical geometry (`greatCircle` in `routes.ts`). v1.1 swaps the *source* of that geometry (great-circle → precomputed ORS polylines) but keeps the same "static data committed to repo" pattern. No new infra.
- **Log-normal sampler** — `sampleLogNormal` (Box–Muller) in `packages/simulation/src/timing.ts` is sufficient. The deterministic **expected-value estimator** the optimizer needs is a one-line closed form (`median·exp(σ²/2)`, clamped) — **no stats library required**.
- **Seeded RNG** (`Rng`), Vitest 4, Playwright, Kysely, Fastify, OpenLayers — all unchanged.

## What NOT to add (anti-stack)

- ❌ **No runtime routing engine** (OSRM / Valhalla / GraphHopper self-host) — massive infra for a demo; the route set is 18 static legs (9 spokes × 2 directions).
- ❌ **No `openrouteservice-js` runtime SDK** — a runtime routing client would (a) break determinism and (b) add a network dependency to the sim/plan hot path. ORS is precompute-only.
- ❌ **No live API calls at simulation or planning time** — hard determinism constraint (threat T-01-15). All road data is frozen into committed GeoJSON.
- ❌ **No stats/distribution library** (jStat, simple-statistics) — the closed-form log-normal mean is trivial; a dep would be over-engineering (YAGNI).

## Precompute workflow (recommended shape)

1. A `scripts/precompute-routes.ts` (or a `packages/simulation` dev script) reads the 10 hubs from `hubs.ts`, calls ORS Directions `driving-hgv` for each directed leg, and writes `packages/simulation/src/network/road-geometry.generated.json` (GeoJSON LineString coords + distance_m + duration_s per `routeId`).
2. The file is **committed** to the repo (determinism + offline runtime).
3. A checksum/regeneration guard ties the generated file to the hub coordinates so drift is detectable (see PITFALLS).
4. `routes.ts` loads the static geometry instead of computing `greatCircle`; the per-leg ORS `distance_m` feeds TIME-01's distance-derived transit medians.

## Sources

- Codebase: `packages/simulation/src/network/routes.ts`, `timing.ts`, `packages/optimizer/src/graph/*`, workspace `package.json` dependency graph.
- ORS `driving-hgv` Directions API — capability known from prior art; **pin exact endpoint/response schema/version at plan-phase** (gsd-phase-researcher with Context7/web).
