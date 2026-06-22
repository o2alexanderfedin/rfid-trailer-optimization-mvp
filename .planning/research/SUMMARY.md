# Project Research Summary — Milestone v1.1 "Realistic Time Model + Hardening"

**Project:** Middle-Mile Trailer Optimization Platform (MVP)
**Milestone:** v1.1 — make the simulated time model defensible end-to-end + close post-v1.0 audit follow-ups
**Researched:** 2026-06-21
**Method:** Inline main-loop research, grounded directly in source. The 4 parallel research subagents were lost to a transient Anthropic **529 overload** wave (all 4 died at their tail); the main loop was unaffected, so research was conducted directly against the codebase. Exact external-library versions are deferred to per-phase `/gsd-plan-phase` research.
**Confidence:** HIGH on architecture/features/pitfalls (verified against source); MEDIUM on exact ORS endpoint/version specifics.

## Executive Summary

v1.1 is **internal refinement of a shipped system**, not new-domain work — which is why it needs **no new runtime dependencies**. The defining design question is a single closed-form statistics decision: how to turn the simulator's **stochastic log-normal** dwell/transit draws into ONE **deterministic** number the pure time-expanded optimizer graph can plan against. The answer is the distribution **MEAN** = `median·exp(σ²/2)` (clamped), computed once in a shared estimator so the same config drives both the random sim draw and the deterministic plan estimate. Everything else (road-following routes, distance-derived transit, center dwell, client hardening, coverage) is well-scoped engineering around that core.

## Key findings by dimension

**Stack** — No new runtime deps. OpenRouteService (`driving-hgv`) is used **precompute-only**: a dev script fetches road geometry once → static GeoJSON committed to the repo (preserving determinism). ORS returns `distance`+`duration` directly, so no turf/stats library is needed. Anti-stack: no runtime routing engine, no live API at sim/plan time.

**Features** — The stochastic→deterministic pivot (OPT-10): use the **mean** (unbiased vs realized throughput), not the median (optimistic) or a percentile (over-conservative; a future robustness knob). Table stakes: optimizer consumes expected transit (`travelMin`) + expected dwell (new `serviceMin` offset); distance-derived transit medians; center re-dispatch dwell so `dwellCenter` (≈65 min) finally fires; road polylines on the map; tolerant envelope parsing; meaningful coverage. Anti-features: full stochastic/robust optimization, live traffic, HOS break modeling.

**Architecture** — `@mm/simulation` and `@mm/optimizer` both depend on `@mm/domain` but **not each other** → put the shared `TimingConfig` + `DEFAULT_TIMING_CONFIG` + pure `expectedMinutes()` in `@mm/domain` (no circular dep); the RNG sampler stays in simulation. Time-expanded graph already keys travel off `route.travelMin` (lines 162/172) → feeding the expected/distance-derived transit there is localized; but dwell-as-service-time is a **new** concept (no `serviceMin` today — dwell is only a flat `waitCost`) and is the design-heavy task. Route geometry is a clean shape-agnostic seam (`Route.geometry` is `[lon,lat][]`) → swapping great-circle for static ORS polylines leaves ws + OpenLayers animation untouched.

**Pitfalls** — (P1) determinism breakage → precompute-only + committed GeoJSON; (P2) log-normal mean-vs-median bias → use mean, compute once; (P3) unit/epoch mismatches (minutes vs ticks vs 15-min steps vs ms vs 120× simSpeed); (P4) double-counting dwell (sim vs optimizer; center vs spoke); (P5) stale GeoJSON drift from hub coords → checksum guard + `[lon,lat]` axis check; (P6) **keystone/golden regression** — the biggest risk: re-baseline the scenario-reopt keystone only after explaining each plan delta, never blind `-u`; lean on the glpk oracle + planner-vs-validator property test; (P7) parseEnvelope fallback masking real protocol errors → fallback only for *missing* speed + warn-once; (P8) coverage gaming → assert behavior.

## Recommended build order (→ phases)

1. **Shared timing source of truth** in `@mm/domain` (`expectedMinutes` + config) — pure, fully testable, no behavior change (keystone stays green). Foundation.
2. **Road-following routes (VIZ-06)** — precompute script + static GeoJSON + `routes.ts` swap, exposing per-leg distance. Verifiable on the map; independent of the optimizer.
3. **Distance-derived transit (TIME-01) + center re-dispatch dwell (TIME-02)** — simulation-side time model, building on 1+2.
4. **Optimizer consumes timing (OPT-09 + OPT-10)** — the meaty design-heavy core; expected `travelMin` + new `serviceMin` offset; careful, explained keystone re-baseline.
5. **Hardening + coverage (HRD-01 + QA-01)** — independent; naturally last.

This maps cleanly to ~3–4 phases (steps 2+3 likely combine into one "realistic geography & time" phase; step 4 is its own phase; steps 1 and 5 attach to their neighbors or stand alone).

## Watch Out For (top 3)
1. **Keystone regression masking** — explain every fixture delta before re-baselining (P6).
2. **Mean vs median** — use the mean, in one shared place (P2).
3. **Double-counted dwell** — one dwell per stop, sim owns realized / optimizer owns estimate (P4).

## Sources
See per-dimension files (STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md). All grounded in `packages/{domain,simulation,optimizer,web}/src` + the workspace dependency graph.
