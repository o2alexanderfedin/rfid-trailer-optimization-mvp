# Phase 7: Time-Aware Optimizer — PLAN

**Planned:** 2026-06-21
**Branch:** `feature/v1.1-realistic-time-model` (feature branch — direct commits allowed; never touch develop/main, never push, never git flow)
**Scope:** OPT-09 (optimizer consumes expected per-leg transit + role-based dwell) + OPT-10 (deterministic MEAN estimate via the single shared `expectedMinutes`). OUT: VIZ-06 ORS road data, Phase-8 hardening/coverage.
**Authoritative inputs:** `07-CONTEXT.md` (LOCKED), `.planning/research/{ARCHITECTURE,PITFALLS,FEATURES,SUMMARY}.md`.

---

## 1. The complete map — every surface where transit/dwell enters the optimizer

Verified against source. There are **four code surfaces** plus the **shared-derivation move**. The optimizer graph/VRPTW internals already key off `travelMin`/`serviceMin`; the values today are **flat constants** injected upstream. The work is replacing those constants with the shared expected-timing estimate at each population site — NOT changing the graph math.

| # | Surface | File:line (verified) | Today | Target |
|---|---------|----------------------|-------|--------|
| S0 | **Shared derivation (NEW in @mm/domain)** | `packages/simulation/src/network/routes.ts:99,126,142` (`haversineKm`, `transitParamsForLeg`, `buildTransitParamsByLeg`) | live in `@mm/simulation` (optimizer can't import) | moved to `@mm/domain`; sim re-imports; add `expectedTransitMinutes(from,to,config)` + `expectedDwellMinutes(role,config)` |
| S1 | **PRIMARY population site — twin route travelMin** | `packages/api/src/optimizer/twin-snapshot.ts:33,83` (`TRANSIT_MIN = 30`, `travelMin: TRANSIT_MIN`) | flat 30 min for every leg | per-leg `expectedTransitMinutes(fromHub,toHub,config)` rounded to int, using hub coords from `HubRegistered` events |
| S2 | **PRIMARY population site — dwell as serviceMin** | `twin-snapshot.ts` `buildTrailerStops` (:98) → `TwinStop` has NO serviceMin; `epoch.ts stopsForTrailer:83-91` hardcodes `serviceMin: 0` | dwell only as flat `waitCost`; serviceMin = 0 everywhere | each stop's `serviceMin = expectedDwellMinutes(role,config)` (center vs spoke), one dwell per stop |
| S3 | VRPTW travelMin oracle | `epoch.ts buildTravelModel:57-70` (reads `TwinRoute.travelMin`) ; `vrptw/feasibility.ts:46` (`travel.travelMin`) ; `vrptw/types.ts:53` (`TravelModel`) | passes through whatever travelMin the twin carried (flat 30 via S1) | automatically correct once S1 feeds expected transit — **no change needed if S1 is the only travelMin source**; verify it threads through |
| S4 | Time-expanded graph travelMin | `optimizer/graph/types.ts:140` (`OptimizerRoute.travelMin`) ; `graph/time-expanded.ts:162,172` (`arriveTimestep = ceilToStep(departMin+travelMin)`, `cost = tripCostPerMin*travelMin`) ; populated at `flow/freight-stage.ts:117` (`travelMin: r.travelMin` from `TwinRoute`) | flat 30 via S1 → freight-stage | automatically correct once S1 feeds expected transit — **no change to graph code**; verify horizon sizing |

**Key architectural finding (drives the whole plan):** `TwinRoute.travelMin` is the **single upstream source** for both optimizer surfaces. `epoch.ts buildTravelModel` (VRPTW oracle, S3) and `freight-stage.ts:117` (graph `OptimizerRoute.travelMin`, S4) both read `TwinRoute.travelMin` verbatim. So **fixing the value once in `buildTwinSnapshot` (S1) propagates to BOTH the VRPTW oracle and the flow graph** — no duplicate estimate, no double-derivation. The optimizer-package graph/VRPTW code does NOT change; only the *injected value* changes. This is exactly the "expected transit at one source" the CONTEXT demands.

**Dwell is the genuinely new concept (S2).** Today `serviceMin` is `0` at every stop (`epoch.ts:85`) and `TwinStop`/`TwinRoute` carry no dwell. Dwell only exists as a flat per-timestep `waitCost` in the graph. To make the optimizer respect role-based dwell we set `RouteStop.serviceMin` on the VRPTW path (`feasibility.ts:51` already does `departureMin = serviceStart + serviceMin`). We do **NOT** add a graph-level service offset (see Task 5 decision) — that would double-count against the flow graph's existing `wait`/`hold` self-edges (PITFALLS P4).

**Hub-coordinate availability:** `buildTwinSnapshot` currently reads only `RouteRegistered` (routeId/from/to) — no coords. But `HubRegistered` events carry the full `Hub` (`hubSchema` includes `lat`/`lon`, verified `network/hubs.ts:14`). Task 4 adds a `HubRegistered` read to get coordinates for `expectedTransitMinutes`. Center hub = `hubs[0]` (MEM) per `routes.ts` topology; role is derivable from "is this hub the center of the hub-and-spoke" (the from/to that is the common hub across all legs), or simply `hubId === center`. Task 4 surfaces hub role to the twin.

---

## 2. Ordered task breakdown (TDD: failing test → implement → green)

Build order respects dependencies: shared derivation first (foundation, zero behavior change), then sim re-import (keystone stays green), then the two optimizer value sites, then dwell, then the explained keystone re-baseline + Docker integration verification.

### Task 1 — Move geography→transit derivation into `@mm/domain` (S0, foundation)

**Goal:** `@mm/domain` owns the pure geography helpers so the optimizer can import them (it cannot import `@mm/simulation`). Zero behavior change.

**Files to touch:**
- NEW `packages/domain/src/timing-geo.ts` (or extend `timing.ts`): move `haversineKm(a: Hub, b: Hub)`, `transitParamsForLeg(from, to, sigma)` verbatim from `routes.ts:99-134`. Add:
  - `expectedTransitMinutes(from: Hub, to: Hub, config: TimingConfig): number` = `expectedMinutes(transitParamsForLeg(from, to, config.transit.sigma))`.
  - `expectedDwellMinutes(role: "center" | "spoke", config: TimingConfig): number` = `expectedMinutes(role === "center" ? config.dwellCenter : config.dwellSpoke)`.
- `packages/domain/src/index.ts`: export the four symbols + `TimingConfig`/`DEFAULT_TIMING_CONFIG`/`expectedMinutes` (already exported — confirm).
- Keep `routeId(from,to)` string helper accessible: it's needed by `buildTransitParamsByLeg`. Either move `buildTransitParamsByLeg` too (preferred — it's pure geography) or keep it in sim re-deriving via the domain helper. **Decision: move `buildTransitParamsByLeg` to domain as well** (it is pure geography keyed by `routeId`), and have domain own a `routeId` helper OR accept it as already living in sim. To avoid a sim→domain `routeId` coupling churn, domain gets its own internal `legKey(from,to)` and `buildTransitParamsByLeg` returns a `Map` keyed by `${from}->${to}`; sim's `routeId`-keyed callers adapt. (If this widens the diff, fall back to: move only the 3 pure leg helpers, keep `buildTransitParamsByLeg` in sim re-importing them.)

**Test to add (failing first):** `packages/domain/test/timing-geo.unit.test.ts`:
- `haversineKm` symmetric, `=0` for coincident, known-value check (e.g. MEM↔ORD ≈ haversine km within 0.5 km).
- `expectedTransitMinutes(MEM, ORD, DEFAULT)` equals `expectedMinutes(transitParamsForLeg(MEM,ORD,0.3))` (the mean, not median) — pins OPT-10 semantics at the new surface.
- `expectedDwellMinutes("center",DEFAULT)` = `expectedMinutes(dwellCenter)` ≈ 65 (mean of median 60, σ 0.4: `60·exp(0.08)≈65.0`); `"spoke"` = `expectedMinutes(dwellSpoke)` ≈ 27.1.
- Purity: same inputs ⇒ identical output (no clock/RNG).

**Keystones affected:** none yet (pure addition; nothing consumes it).

### Task 2 — Re-point `@mm/simulation` to the moved helpers (S0, keystone-protective)

**Goal:** `@mm/simulation` re-imports the moved helpers from `@mm/domain` instead of defining them. **Byte-identical behavior** so the simulation timing tests and the `projections-golden-replay` keystone stay green WITHOUT re-baselining.

**Files to touch:**
- `packages/simulation/src/network/routes.ts`: delete the moved bodies; re-export from `@mm/domain` (`export { haversineKm, transitParamsForLeg, buildTransitParamsByLeg } from "@mm/domain"`) so `engine.ts:13` and `index.ts:19-21` keep working unchanged. Keep `greatCircle`, `buildRoutes`, `routeId`, road-geometry helpers in sim (they are sim/viz-specific).
- `packages/simulation/src/engine.ts:209`: `buildTransitParamsByLeg(USA_HUBS, ...)` call unchanged (now resolves to the domain impl). If `buildTransitParamsByLeg` key changed (Task 1 fallback), adapt the `transitByLeg.get(routeId(...))` lookup at `:213`.
- `packages/simulation/src/index.ts:19-21`: re-export still resolves.

**Test to add/update:**
- Existing `packages/simulation/test/timing-engine.unit.test.ts` and `rfid-determinism.unit.test.ts` MUST pass unchanged (proof of zero behavior change).
- Add one assertion in a sim test: `routes.transitParamsForLeg === domain.transitParamsForLeg` (identity) OR a value-equality check, to lock the re-import.

**Keystones affected:** `projections-golden-replay.int.test.ts` and `scenario-reopt.int.test.ts` MUST stay green with **NO change** (this task must not move sim output). If either moves here, it's a regression in the move — STOP and fix, do not re-baseline in this task. (Re-baselining belongs to Task 6, attributable to the optimizer value change only — PITFALLS cross-cutting rule.)

### Task 3 — Surface hub role + coordinates into the twin contract (enabler for S1/S2)

**Goal:** Give the twin enough to compute per-leg expected transit and per-stop role-based dwell.

**Files to touch:**
- `packages/optimizer/src/rolling/types.ts`: extend `TwinRoute` is NOT needed (travelMin already there). Add to the twin a way to know hub role for dwell. Two options:
  - (a) Add `role: "center" | "spoke"` to a new `TwinHub` and change `TwinSnapshot.hubs` from `readonly string[]` to `readonly TwinHub[]`. **Wider blast radius** (every `twin.hubs` consumer, `freight-stage.ts:111`, `epoch` scope).
  - (b) **PREFERRED:** keep `hubs: string[]`; add optional `centerHubId?: string` to `TwinSnapshot`. Dwell role = `hubId === centerHubId ? "center" : "spoke"`. Minimal, additive, back-compat (undefined ⇒ all spokes ⇒ matches today when dwell=0).
- **Decision: option (b).** Add `readonly centerHubId?: string` to `TwinSnapshot`.

**Test to add:** `packages/optimizer/src/rolling/types` is types-only; covered via Task 4/5 tests. Add a focused unit test in `epoch.test.ts` (Task 5) asserting center vs spoke serviceMin.

**Keystones affected:** none (additive optional field; existing epoch.test fixtures omit it ⇒ unchanged).

### Task 4 — Populate expected per-leg transit at the twin source (S1 → S3 + S4)

**Goal:** Replace the flat `TRANSIT_MIN = 30` with per-leg `expectedTransitMinutes` in `buildTwinSnapshot`. This is the **one change that feeds both** the VRPTW oracle (S3) and the flow graph (S4) — no duplication.

**Files to touch:**
- `packages/api/src/optimizer/twin-snapshot.ts`:
  - Add a `HubRegistered` events read (mirror the `RouteRegistered` read at :211): build `Map<hubId, Hub>` of coordinates. Determine `centerHubId` = the hub that appears as `fromHubId` OR `toHubId` in every leg's common endpoint (hub-and-spoke center); simplest deterministic rule: the hub that is an endpoint of the most legs, tie-broken lexicographically. (For the demo network this is MEM.)
  - Change `parseRouteRow`/route assembly: compute `travelMin = Math.round(expectedTransitMinutes(fromHub, toHub, DEFAULT_TIMING_CONFIG))` per leg instead of `TRANSIT_MIN`. Keep integer (P12). Fall back to `TRANSIT_MIN` if a hub's coords are missing (defensive, deterministic).
  - Inject `DEFAULT_TIMING_CONFIG` (or a passed-in `TimingConfig`) via DIP — add an optional `config: TimingConfig = DEFAULT_TIMING_CONFIG` param so tests can pin it.
  - Set `centerHubId` on the returned `TwinSnapshot` (Task 3).
  - Keep `TRANSIT_MIN` export for back-compat consumers (KPI route etc.) but it is no longer the route travel source — update the docstring at :18-23 and :202.
- `packages/optimizer/src/flow/freight-stage.ts`: NO change — `r.travelMin` (:117) now carries expected transit. Verify `TRANSIT_MIN = 60` horizon-sizing constant (:64) still bounds realistic legs; see Task 5 horizon verification.

**Test to add (failing first):** extend `packages/api/src/optimizer/twin-snapshot.test.ts`:
- Given `HubRegistered` for MEM+ORD and a `RouteRegistered` MEM→ORD, the resulting `TwinRoute.travelMin` equals `Math.round(expectedTransitMinutes(MEM, ORD, DEFAULT))` (≈ haversine/80·60 mean), NOT 30.
- A long coast leg (MEM→LAX) has a much larger `travelMin` than a short leg (MEM→IND) — proves per-leg, not flat.
- Missing-coords leg falls back to `TRANSIT_MIN` deterministically.
- `centerHubId` is set to MEM for the hub-and-spoke fixture.
- Determinism: two builds byte-identical.

**Keystones affected:** **`scenario-reopt.int.test.ts` + `projections-golden-replay.int.test.ts` WILL shift** (travelMin changes the optimizer arrival timesteps + trip costs + recommendations) — re-baseline in Task 6 (not here; keep the value change and the re-baseline in one attributable commit per PITFALLS cross-cutting). Unit test `epoch.test.ts` is insulated (it passes explicit `travelMin`).

### Task 5 — Role-based dwell as serviceMin on the VRPTW path (S2), no graph double-count

**Goal:** Each VRPTW stop carries `serviceMin = expectedDwellMinutes(role, config)` so a trailer must dwell (center vs spoke) before departing — surfaced via the existing `RouteStop.serviceMin` / `feasibility.ts:51` path. **No** graph-level service offset (avoids double-count with `wait`/`hold` edges — PITFALLS P4; the flow graph keeps owning idle dwell as `waitCost`, the VRPTW owns the planning dwell estimate).

**Files to touch:**
- `packages/optimizer/src/rolling/epoch.ts` `stopsForTrailer` (:83-110): replace `serviceMin: 0` with `serviceMin: expectedDwellMinutes(roleOf(stop.hubId), config)` where `roleOf` uses `twin.centerHubId` (Task 3). Both the in-route stops (:83) and off-route stops (:103) get the role-based value. **One dwell per stop** — never add a second dwell elsewhere. Thread `config` + `centerHubId` into `stopsForTrailer` (currently takes only `trailer`); pass from `runEpoch` (:374).
- Confirm `feasibility.ts:51` (`departureMin = serviceStart + stop.serviceMin`) and `route-trailers` carry it through (they do — `serviceMin` is read there). No change to feasibility/types beyond what's wired.
- **Horizon verification (CONTEXT requirement):** with realistic transit (hundreds of min/leg) + per-stop dwell (~27–65 min), confirm:
  - `freight-stage.ts` `horizonEndMin` (:198-199) already takes `max(defaultHorizonEnd, maxArrival + step)` so a long leg's arrival node always fits — verify with a test that a MEM→LAX-scale leg produces a non-empty trip edge (does not vanish off-grid). Bump the `TRANSIT_MIN = 60` default-horizon seed (:64) to a realistic value (e.g. derive from `max expectedTransitMinutes`) so the default horizon isn't absurdly short before the `maxArrival` clamp kicks in — purely a sizing safety, output-neutral given the `max()`.
  - `ceilToStep` (time-expanded.ts:44) rounds a multi-hundred-minute leg up to the 15-min grid correctly (already does; add an assertion).

**Test to add (failing first):**
- `epoch.test.ts`: a fixture with `centerHubId: "H2"` and a trailer routed through H2 → the routed stop at H2 has `departureMin - serviceStart === expectedDwellMinutes("center", DEFAULT)` (≈65), and a spoke stop ≈27. **Assert exactly ONE dwell per stop** (a center pass-through incurs `dwellCenter` once, not `dwellCenter + dwellSpoke`) — directly tests PITFALLS P4.
- A horizon test: a leg with `travelMin` ~ realistic LAX-scale value still yields a `trip` edge in `assignFreightForEpoch` (not dropped off-grid).
- Determinism: identical inputs ⇒ deep-equal `EpochResult`.

**Keystones affected:** `epoch.test.ts` existing fixtures that omit `centerHubId` ⇒ all stops spoke; but `serviceMin` changes from 0 to ~27 ⇒ **existing epoch.test.ts assertions on departure/ETA may shift** → update with an explained comment (intended: dwell now modeled). `scenario-reopt` + `golden-replay` shift → Task 6.

### Task 6 — Explained keystone re-baseline + Docker integration verification (P6, MANDATORY)

**Goal:** Re-baseline the integration keystones ONLY after Tasks 4+5 are green at the unit level, with **each delta explained in a comment**, never blind `-u`, never weakening/deleting an assertion. Verify with a **real Docker integration run** (not an audit — PITFALLS P6: a Phase-6 audit gave a false PASS).

**Files to touch (re-baseline, with comments):**
- `packages/api/test/scenario-reopt.int.test.ts`: the `BASELINE_TICKS` frontier comment block (already a precedent at :32-44 from the log-normal timing change) gets an ADDITIONAL explained note: which trailer docks where now that the optimizer plans against realistic transit + dwell, and why the implicated-in-scope trailer/objective delta is intended (not a regression). Keep gates (a) non-empty recs, (b) determinism, (c) T001 implicated — only adjust the literal frontier/expected values that legitimately moved, with the reason.
- `packages/api/test/projections-golden-replay.int.test.ts`: this asserts **live twin == rebuilt-from-log twin** (FND-04) — it should be **invariant** to optimizer travelMin/dwell (the optimizer does not write to the operational twin's golden projections; it emits recommendations/PlanGenerated). **Expectation: this keystone stays GREEN with no change.** If it moves, that signals optimizer output leaking into the operational projection replay — investigate as a regression, do NOT re-baseline blindly.
- Any optimizer golden snapshot under `packages/optimizer/src/**/__snapshots__` touched by Task 5 dwell: re-baseline with an inline comment per changed value.

**Verification (run, don't audit):**
- `pnpm -w build` → zero errors (strict TS, verbatimModuleSyntax: `import type`/`export type` everywhere).
- `pnpm -w test` (unit project) → all green, including `glpk-oracle.test.ts` (flow + graph) and `planner-vs-validator.property.test.ts` (these use their own hand/random fixtures, NOT the network travelMin, so they MUST stay green — if they break, the graph math changed, which it must not).
- `pnpm -w test:all` with Docker available (Testcontainers `postgres:17` via `pg-fixture.ts`, or `MM_PG_URL`) → `scenario-reopt` + `projections-golden-replay` + other `.int.test.ts` green. **Must be the real run** — Docker up, observed pass, not reasoned-about.
- Diff OLD vs NEW scenario-reopt recommendation key and confirm the delta direction matches the story (longer realistic transit on long legs ⇒ later arrivals / different scope ⇒ explained recs change). Record the explanation in the test comment.

**Keystones affected:** scenario-reopt (re-baselined, explained), golden-replay (expected invariant), optimizer snapshots (re-baselined, explained). glpk oracle + planner-vs-validator property (must stay green, untouched).

---

## 3. must_haves (derived from phase success criteria)

- [ ] **Optimizer demonstrably plans against expected timing.** `TwinRoute.travelMin` is per-leg `expectedTransitMinutes` (the log-normal MEAN, realistic-absolute haversine@80km/h), NOT flat 30; a long leg costs materially more than a short one in the plan (proven by a twin-snapshot test). (OPT-09 surface S1→S3→S4.)
- [ ] **Single shared estimator (OPT-10).** Transit + dwell estimates derive from the ONE pure `expectedMinutes`/`expectedTransitMinutes`/`expectedDwellMinutes` in `@mm/domain`; the simulator's RANDOM draw and the optimizer's DETERMINISTIC estimate read the same `TimingConfig`. No second derivation of transit anywhere (verified: `TwinRoute.travelMin` is the only source feeding both optimizer surfaces).
- [ ] **Role-based dwell, exactly once per stop (no double-count, PITFALLS P4).** Center stops carry `expectedDwellMinutes("center")` (≈65), spokes `≈27`, via `RouteStop.serviceMin` only; the flow graph adds NO extra service offset (idle dwell stays `waitCost`). A center pass-through incurs exactly one `dwellCenter` (explicit test).
- [ ] **Determinism preserved.** No `Date.now()`/`Math.random()`; pure integer-cost graph; `travelMin`/`serviceMin` are rounded integers (P12); same inputs ⇒ byte-identical `EpochResult` and byte-identical twin snapshot (tests assert deep-equal across two runs).
- [ ] **Horizon fits realistic legs.** A long (LAX-scale) leg still produces a `trip` edge — does not vanish off-grid; `ceilToStep` + `freight-stage` horizon clamp verified by test.
- [ ] **Keystones green, deltas explained.** `scenario-reopt` re-baselined with each change explained in a comment (never blind `-u`, never weakened/deleted assertions); `projections-golden-replay` stays green (optimizer change must not perturb operational-twin replay); glpk.js LP oracle (flow + graph) and planner-vs-validator property test stay green untouched.
- [ ] **Integration verified with real Docker run**, not an audit (PITFALLS P6).
- [ ] **No behavior change in the S0 move (Task 2).** Simulation timing tests + golden-replay stay green WITHOUT re-baselining after the geography-helper move — the re-import is byte-identical; any sim-output shift in Task 2 is a regression to fix, not to baseline.
- [ ] **Strict TS clean.** `pnpm -w build` zero errors; no `any`, no unsafe assertions, `noUncheckedIndexedAccess` respected, `import type`/`export type` for type-only imports.

---

## 4. Sequencing & commit discipline

1. Task 1 (domain move) — commit `feat(07): move geography→transit derivation into @mm/domain (S0)`.
2. Task 2 (sim re-import) — commit `refactor(07): re-import shared transit helpers in @mm/simulation (keystone unchanged)`. Prove no sim-output drift.
3. Task 3 (twin role field) — folded into Task 4 commit (types-only).
4. Task 4 (expected transit at twin source) — commit `feat(07): populate expected per-leg transit in buildTwinSnapshot (OPT-09 S1)`.
5. Task 5 (role-based dwell serviceMin) — commit `feat(07): role-based expected dwell as VRPTW serviceMin, no double-count (OPT-09 S2)`.
6. Task 6 (explained re-baseline + Docker run) — commit `test(07): re-baseline scenario-reopt for expected timing — each delta explained` + `chore(07): verify optimizer-timing integration under Docker`.

Keep the keystone re-baseline isolated to its own commit so the regression surface is attributable (PITFALLS cross-cutting rule). Each commit message ends with the mandated Co-Authored-By / Claude-Session trailers.
