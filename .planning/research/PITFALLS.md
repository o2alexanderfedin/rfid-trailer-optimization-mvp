# Pitfalls Research — Milestone v1.1 "Realistic Time Model + Hardening"

**Researched:** 2026-06-21 (inline, codebase-grounded)
**Confidence:** HIGH — pitfalls cite real files/symbols in this repo.

Each pitfall → warning signs → prevention → owning phase (build-order index from ARCHITECTURE.md).

## P1 — Determinism breakage (owner: Phase road-routing #2)
- **Risk:** A live ORS call at sim/plan time, or non-byte-identical geometry, breaks the determinism contract (threat T-01-15) and the golden-replay keystone (FND-04).
- **Signs:** tests pass locally, fail in CI; replay hash drift; network in the hot path.
- **Prevention:** ORS is **precompute-only** → committed static GeoJSON. Round coordinates to a fixed precision when serializing. No `fetch`/`Date.now()`/`Math.random()` outside the dev precompute script. Keep the `greatCircle` purity discipline.

## P2 — Log-normal mean-vs-median bias (owner: optimizer #4)
- **Risk:** Using the **median** (`exp(μ)`) as the planner's estimate ignores the right tail → systematically **optimistic** plans (under-budgeted transit/dwell → missed connections the planner didn't foresee). Using a high percentile → over-conservative slack. Double-applying `exp(σ²/2)` → inflation.
- **Signs:** planner consistently under/over-estimates vs simulated realized times; KPI before/after looks "too good".
- **Prevention:** Use the **mean** `median·exp(σ²/2)` (clamped) as the canonical deterministic estimate (FEATURES.md). One shared `expectedMinutes()` in `@mm/domain` — compute it in exactly one place; unit-test it against the formula. Document the choice in the function docstring + a Key Decision.

## P3 — Unit / epoch mismatches (owner: optimizer #4, sim #3)
- **Risk:** Mixing minutes (timing config + graph `timeMin`/`travelMin` are minutes; 1 tick = 1 minute per `timing.ts`), simulation ticks, the optimizer's 15-min `timeStepMin` grid, ms (`simMs` on the ws envelope), and the 120× time-compression / `simSpeed`.
- **Signs:** transit off by 60× or 1000×; trips arriving instantly or never; `ceilToStep` snapping everything to one node.
- **Prevention:** Keep ONE unit (minutes) through the time model; convert only at I/O boundaries. Note that `expectedMinutes` may be < `timeStepMin` (15) → `ceilToStep` rounds a short leg up to one step; ensure that's intended (short legs still cost ≥1 step). Add an assertion/test that travel/dwell are minutes.

## P4 — Double-counting dwell (owner: optimizer #4, sim #3)
- **Risk:** Dwell counted twice — e.g. sim adds dwell to the trailer's departure AND the optimizer adds a `serviceMin` offset on top; or center re-dispatch dwell (TIME-02) applied in addition to a spoke dwell at the same stop. The graph already has flat `waitCost`/`hold` self-edges — adding a `serviceMin` offset must not duplicate what `wait` already represents.
- **Signs:** end-to-end leg time ≈ 2× expected; trailers idle far longer than `dwellCenter`.
- **Prevention:** Define dwell ownership explicitly — sim owns realized dwell (departure timing), optimizer owns the *planning estimate* of that same dwell (not an additional one). For TIME-02, apply `dwellCenter` only at the center hub's re-dispatch site, `dwellSpoke` only at spokes — one dwell per stop, keyed by hub role. Add a test asserting a center pass-through incurs exactly one `dwellCenter`.

## P5 — Stale precomputed GeoJSON (owner: road-routing #2)
- **Risk:** Road polylines drift from hub coordinates in `hubs.ts` (a hub moves, geometry doesn't regenerate); WGS84 lon/lat axis-order mistakes (ORS GeoJSON is `[lon,lat]`, matching the project's `LonLat` — but easy to flip); ORS free-tier rate limits/quota during precompute.
- **Signs:** trailers fly off-road or to the wrong city; endpoints don't anchor at hubs.
- **Prevention:** A checksum guard: store a hash of the hub coordinates alongside the generated GeoJSON; a test fails if hubs changed but geometry wasn't regenerated. Assert `[lon,lat]` order. Endpoints snap exactly to hub coords (as `greatCircle` does today). Throttle/retry the precompute script for rate limits.

## P6 — Keystone & golden-fixture regression (owner: optimizer #4 — highest risk)
- **Risk:** Changing `travelMin` / adding `serviceMin` shifts optimizer output, breaking the **re-baselined scenario-reopt keystone** and other golden fixtures. The danger is **masking a real regression** by lazily re-baselining (`-u` snapshot update without inspection).
- **Signs:** many fixtures change at once; objective costs move in an unexplained direction.
- **Prevention:** Treat fixture changes as a review gate — diff the OLD vs NEW plan and *explain* the delta (e.g. "longer expected transit on coast legs → 2 more over-carries, expected"). Re-baseline only after the change is understood and intended. Keep the planner-vs-validator property test and the glpk.js oracle cross-check green (they catch correctness regressions independent of fixtures).

## P7 — parseEnvelope fallback masking real errors (owner: hardening #5)
- **Risk:** The HRD-01 `DEFAULT_SPEED` fallback becomes over-permissive and swallows a genuinely broken/incompatible server build (silent wrong behavior — the opposite failure of today's blank-map).
- **Signs:** map animates but speed/pacing is wrong and nobody noticed; no signal that the server is mis-versioned.
- **Prevention:** Fallback ONLY for a *missing* `speed` (back-compat with a speed-less envelope); still reject malformed `v`/`type`/`seq`/`simMs`/`payload`. Emit a **one-time** `console.warn("envelope missing speed; using DEFAULT_SPEED")` so the degradation is observable, not silent. Test both paths.

## P8 — Coverage gaming (owner: QA #5)
- **Risk:** QA-01 "top-up" hits the line/branch number by executing code without asserting behavior (e.g. calling the socket path but not checking reconnect/seq-gap/resync).
- **Signs:** coverage % up, but mutation/behavior untested; tests with no meaningful `expect`.
- **Prevention:** Cover the `useWsEnvelope` socket path with behavior assertions — open-once, seq-gap → resync request, snapshot-replaces-maps, tick-applies-delta. Assert outcomes, not just execution.

## Cross-cutting prevention
- Land the shared `expectedMinutes` (#1 build step) FIRST with NO behavior change, so the keystone stays green and later phases have a single tested estimator to build on.
- Keep each phase's fixture re-baseline isolated to that phase's commit so regressions are attributable.

## Sources
- `packages/simulation/src/{timing.ts,network/routes.ts,network/hubs.ts}`, `packages/optimizer/src/graph/{time-expanded,types}.ts`, `packages/optimizer/src/rolling/epoch.ts`, `packages/web/src/map/wsClient.ts`, PROJECT.md (Key Decisions, known tech debt), `milestones/v1.0-MILESTONE-AUDIT.md` (referenced).
