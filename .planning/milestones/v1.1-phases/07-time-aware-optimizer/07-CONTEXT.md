# Phase 7: Time-Aware Optimizer - Context

**Gathered:** 2026-06-21
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous) — decisions locked from v1.1 research + Phase 6 outcomes + user confirmation (transit scale = realistic-absolute).

<domain>
## Phase Boundary

Make the rolling optimizer plan against the realistic time model that Phase 6 established — so plans reflect real per-leg transit + role-based dwell, derived deterministically from the shared timing config. In scope: OPT-09 (optimizer consumes expected timing) and OPT-10 (deterministic MEAN estimate via the single shared estimator). OUT: VIZ-06 real road data (Phase 6 follow-up, needs ORS key); Phase 8 hardening/coverage.
</domain>

<decisions>
## Implementation Decisions

### Estimate semantics (OPT-10) — LOCKED
- The deterministic planning estimate is the log-normal **MEAN** via the existing pure `expectedMinutes(p)` in `@mm/domain` (`clamp(median·exp(σ²/2), min, max)`). NOT median, NOT a percentile. Single source of truth — the optimizer and the simulator both derive from the same `TimingConfig`.

### Transit scale — LOCKED (user-confirmed)
- **Realistic-absolute**: per-leg transit median = great-circle (haversine) distance @ 80 km/h (the Phase-6 / TIME-01 default). The optimizer plans against these real durations. (Reversible to compressed-proportional via a routes.ts formula change if ever desired — not now.)

### Shared per-leg derivation placement (DRY, avoid circular dep)
- The optimizer (`@mm/optimizer`, deps: domain + load-planner) CANNOT import `@mm/simulation`, where `haversineKm` / `transitParamsForLeg` / `buildTransitParamsByLeg` currently live (`packages/simulation/src/network/routes.ts`).
- **Move the pure geography→transit derivation into `@mm/domain`** (the shared leaf both already import; `Hub` with lon/lat is a domain entity): `haversineKm(a,b)`, `transitParamsForLeg(from,to,sigma)`, and a convenience `expectedTransitMinutes(from,to,config)` = `expectedMinutes(transitParamsForLeg(...))`. `@mm/simulation` re-imports them (no behavior change — keep its tests + the keystone green). The optimizer imports them to compute `travelMin`.

### What the optimizer consumes (OPT-09) — TWO surfaces (planner to map precisely)
1. **Time-expanded min-cost-flow graph** (`packages/optimizer/src/graph/{types,time-expanded}.ts`): `OptimizerRoute.travelMin` must be the **expected per-leg transit** (not flat/geometry). It already drives both `arriveTimestep` (`ceilToStep(departMin + travelMin)`, time-expanded.ts:162) and trip cost (`tripCostPerMin·travelMin`, :172). Source of `travelMin`: the twin route (`rolling/types.ts:93`) → `flow/freight-stage.ts:118` / `epoch.ts buildTravelModel`. Populate from `expectedTransitMinutes`.
2. **VRPTW routing** (`packages/optimizer/src/vrptw/*`): the `TravelModel.travelMin(from,to)` oracle returns expected transit; `RouteStop.serviceMin` (`feasibility.ts:51` `departureMin = serviceStart + serviceMin`) carries **expected DWELL** — role-based: `expectedMinutes(dwellCenter)` at the center hub, `expectedMinutes(dwellSpoke)` at spokes (Phase-6 TIME-02 parity). One dwell per stop, no double-count.

### Dwell-as-service-time
- Prefer reusing the existing `RouteStop.serviceMin` / VRPTW path for dwell. For the flow graph, decide (planner) whether dwell needs a graph-level service offset or is sufficiently represented by the VRPTW serviceMin + wait edges — avoid double-counting dwell across the two surfaces.

### Horizon / timestep
- Realistic transit (hundreds of min/leg) spans many 15-min timesteps; ensure the rolling epoch's scope horizon is large enough that real legs fit (planner to verify `ceilToStep` + horizon sizing; a leg must not exceed the horizon and vanish).

### Determinism + keystone (MANDATORY)
- Pure, integer-cost graph; no clock/RNG. Changing `travelMin`/adding `serviceMin` WILL shift optimizer output → the `scenario-reopt` + optimizer golden fixtures + the `projections-golden-replay` keystone must be **re-baselined with each delta EXPLAINED** (never blind `-u`; never weaken assertions). The glpk.js LP oracle + planner-vs-validator property test must stay green. **Integration keystones MUST be run with Docker — not audited** (a Phase-6 audit gave a false PASS; only the real integration run caught the regression — PITFALLS P6).
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@mm/domain`: `expectedMinutes`, `TimingConfig`, `DEFAULT_TIMING_CONFIG` (Phase-6 foundation).
- `@mm/simulation/network/routes.ts`: `haversineKm`, `transitParamsForLeg`, `buildTransitParamsByLeg` (to be moved/shared via domain).
- `@mm/optimizer`: `OptimizerRoute.travelMin` (graph/types.ts:140), `time-expanded.ts` (162/172), `vrptw/feasibility.ts` (`serviceMin` at :51, `travelMin` oracle at :46), `rolling/epoch.ts` (`buildTravelModel`), `flow/freight-stage.ts:118`.

### Established Patterns
- Pure, deterministic, integer-cost graph; glpk.js test-only oracle; seeded determinism; DIP config injection.

### Integration Points
- domain (new shared geography/transit derivation) → optimizer (travelMin + serviceMin) ; simulation re-imports the moved helpers ; api wires the twin's route travelMin.
</code_context>

<specifics>
## Specific Ideas
- Map ALL travelMin/serviceMin population sites; one expected-timing source; re-baseline keystones with explained deltas; verify integration with Docker.
</specifics>

<deferred>
## Deferred Ideas
- VIZ-06 real ORS road polylines + switching TIME-01 median to ORS duration (Phase-6 follow-up, needs ORS key).
- Stochastic/robust optimization, percentile estimates — out of scope (v1.1 uses the deterministic mean).
</deferred>
