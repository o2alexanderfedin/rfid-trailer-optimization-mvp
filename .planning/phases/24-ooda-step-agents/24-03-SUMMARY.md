---
phase: 24-ooda-step-agents
plan: 03
subsystem: simulation
tags: [ooda, feasibility, hos, fuel, dock, determinism, reuse, dry, tdd]

# Dependency graph
requires:
  - phase: 24-01-ooda-scaffolding
    provides: "decideTruck + AgentObservation (carrying the frozen ObservedHosClock + odometer) gated here"
  - phase: 24-02-ooda-engine-wiring
    provides: "decideHub + the stepAgents pass (where the binding feasibility context is now passed) + the centralized refuel/consolidation bypass the agent gate mirrors"
  - phase: 10-hos-engine
    provides: "@mm/domain mayDriveNow / remainingLegalDriveMinutes / applyDrivingLeg — the shared HOS engine the gate REUSES"
  - phase: SP2-rest-fuel-stops
    provides: "FuelConfig.refuelThresholdMiles — the SAME odometer-threshold rule the gate REUSES"
provides:
  - "ooda/feasibility.ts: truckLegFeasibility + hubDockFeasibility — pure binding-feasibility predicates that DELEGATE to the domain HOS engine + the fuel-threshold + the dock rule (REUSE, not rebuilt)"
  - "decideTruck binding-feasibility gate (first ladder step): infeasible proceed/divert is structurally UNREACHABLE (the un-overridable contract a P25 coordinator cannot override)"
  - "decideHub binding dock-feasibility gate: an infeasible dispatch/consolidate (no dock) is unreachable"
  - "engine stepAgents passes the SHARED HosConfig + fuel threshold + virtual-clock now into decideTruck (the real OODA-03 binding contract on the engine path)"
affects: [24-04-determinism-guard, 24-05-agent-serialization, 25-coordinators]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Binding-feasibility GATE as the FIRST Decide ladder step (verdict short-circuits to rest/refuel/hold before any proceed/divert/dispatch can be constructed) — infeasibility made structurally unreachable, not merely discouraged"
    - "Feasibility predicate as a THIN ADAPTER delegating to the already-tested shared engine (DRY: one HOS engine, no second copy that could drift at the clock/1-ULP boundary)"
    - "REUSE-WITNESS test: assert the predicate's HOS verdict EQUALS a direct mayDriveNow/applyDrivingLeg call at the 11h/8h boundary (anti-drift proof)"
    - "Property test across the full observation space proving no Decide path emits an infeasible outcome (the OODA-03 contract witness)"

key-files:
  created:
    - packages/simulation/src/ooda/feasibility.ts
    - packages/simulation/src/ooda/feasibility.unit.test.ts
  modified:
    - packages/simulation/src/ooda/truck.ts
    - packages/simulation/src/ooda/hub.ts
    - packages/simulation/src/ooda/index.ts
    - packages/simulation/src/engine.ts

key-decisions:
  - "truckLegFeasibility DELEGATES: canDrive = mayDriveNow(clock, hosConfig, now); remainingDriveMinutes = remainingLegalDriveMinutes(...); restReason read off applyDrivingLeg's first inserted break/rest segment — NO FMCSA math reimplemented (T-24-09)"
  - "mustRefuel = odometerMiles >= fuelConfig.refuelThresholdMiles — the EXACT rule departTrailer applies (accrued >= refuelThresholdMiles), over the domain FuelConfig type (no new config shape)"
  - "hubDockFeasibility reuses the frozen dockDoorsAvailable field (the engine's observeHub dock rule); no free door ⇒ canDispatch=canConsolidate=false ⇒ hub bound to hold"
  - "Gate is the FIRST ladder step (priority 0): HOS mustRest OUTRANKS mustRefuel (HOS is the hard legal constraint); a legal+fueled verdict falls through to the now-feasible divert/hold/proceed ladder"
  - "decideTruck's feasibility context is OPTIONAL: the engine passes it (the real binding contract); the standalone 24-01 fallback (observation-derived integer thresholds) is kept so the pure leaf is testable without a config"
  - "Engine passes refuelThresholdMiles=MAX_SAFE_INTEGER when fuel is OFF, so a fuel-off run emits NO fuel events (preserves flag-on-fuel-off behavior + the golden)"
  - "now is the frozen observation's virtual-clock epoch-minute (isoToEpochMinutes(clock.nowIso())) — never Date.now (DET-03)"

patterns-established:
  - "Pattern: binding feasibility computed by an adapter that delegates to the shared engine, then ASSEMBLES the result into a closed verdict the Decide gates on"
  - "Pattern: the un-overridable contract — gate inside Decide as step 0 so an infeasible outcome can never be constructed (no caller, incl. a future coordinator, can force it)"
  - "Pattern: REUSE-witness boundary test (predicate verdict == direct domain-engine call) as the anti-drift guarantee"

requirements-completed: [OODA-03]

# Metrics
duration: 9min
completed: 2026-06-26
---

# Phase 24 Plan 03: Agent-Owned Binding Local Feasibility Summary

**Made trucks/hubs own their BINDING local feasibility (fuel, HOS/rest, dock) by REUSING the existing shared engines — `ooda/feasibility.ts` is a PURE adapter that delegates `truckLegFeasibility` to `@mm/domain`'s `mayDriveNow`/`remainingLegalDriveMinutes`/`applyDrivingLeg` (HOS) + the engine fuel-threshold rule, and `hubDockFeasibility` to the dock-availability rule — then gated every `decideTruck`/`decideHub` outcome through that verdict as the FIRST ladder step, so an infeasible action (drive-while-illegal, refuel-skipped-low-fuel, dispatch-without-dock) is structurally UNREACHABLE: the contract a P25 coordinator cannot override. Flag-off seed-42 golden stays byte-identical (`3920accc…`).**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-06-26T22:41:50Z
- **Completed:** 2026-06-26T22:50:13Z
- **Tasks:** 2 (each committed atomically; RED→GREEN per `type: tdd`)
- **Files modified:** 6 (2 created, 4 modified) across 2 atomic commits

## Accomplishments

- **OODA-03 binding-feasibility predicates** (`ooda/feasibility.ts`) — pure, deterministic THIN ADAPTERS that REUSE (do not rebuild) the shared logic:
  - `truckLegFeasibility(obs, hosConfig, fuelConfig, now)` → `{ canDrive, mustRest, mustRefuel, remainingDriveMinutes, restReason }`. HOS verdict is `mayDriveNow(clock, hosConfig, now)`; the remaining budget is `remainingLegalDriveMinutes(...)` (the SAME headline number the engine/optimizer read, surfaced for a coordinator's reject-with-reason); `restReason` is read straight off `applyDrivingLeg`'s first inserted `break`/`rest` segment (the SAME engine the optimizer uses as a rest-as-time feasibility check). Fuel verdict is `odometerMiles >= fuelConfig.refuelThresholdMiles` — the EXACT rule `departTrailer` applies. NO FMCSA/fuel math is duplicated; the predicate only ASSEMBLES the engine outputs.
  - `hubDockFeasibility(obs)` → `{ canDispatch, canConsolidate }` from the frozen `dockDoorsAvailable` field (the engine's `observeHub` dock rule).
- **The un-overridable gate (T-24-08):** `decideTruck` and `decideHub` now consult the feasibility verdict as the FIRST ladder step (priority 0) and short-circuit to the binding outcome (rest/refuel/hold) BEFORE any proceed/divert/dispatch/consolidate branch can be constructed. There is no code path for any caller — including a future P25 coordinator's `ActionSuggested` — to force an infeasible action through the agent.
- **Engine binding contract:** `stepAgents` passes the SHARED `hosLimits` + the fuel threshold (`MAX_SAFE_INTEGER` when fuel is off, so a fuel-off run stays event-identical) + the virtual-clock epoch-minute into `decideTruck`, so the engine path uses the real domain-engine verdict (not just the pre-rounded observation fields).
- **Anti-drift + contract proof (the test set):** a REUSE-WITNESS boundary test (5 boundary clocks at the 11h/8h edges) asserts the predicate's `canDrive`/`restReason` AGREE with a direct `mayDriveNow`/`applyDrivingLeg` call (T-24-09 — proves delegation, not reimplementation); a property test over the full truck (HOS × fuel × congestion × dock = 144 observations) and hub (dock × outbound × pending × fill = 16) observation spaces proves no Decide path emits an infeasible outcome (the OODA-03 witness).

## Domain Functions REUSED (not rebuilt)

| Feasibility dimension | Shared function REUSED | Source |
|-----------------------|------------------------|--------|
| HOS — may drive now?  | `mayDriveNow(clock, config, now)` | `@mm/domain` hos.ts:230 |
| HOS — remaining budget | `remainingLegalDriveMinutes(clock, config, now)` | `@mm/domain` hos.ts:212 |
| HOS — which rest binds | `applyDrivingLeg(clock, config, 1, occurredAt)` → first inserted `break`/`rest` segment | `@mm/domain` hos.ts:285 |
| Fuel — must refuel?   | `odometerMiles >= fuelConfig.refuelThresholdMiles` (over the domain `FuelConfig` type) | engine departTrailer:2044 / fuel.ts:37 |
| Dock — may dispatch/consolidate? | the frozen `dockDoorsAvailable` (the engine `observeHub` dock rule) | engine:1547,1616 |

## Verdict Shapes + Gate Position

- **`TruckLegFeasibility`** = `{ canDrive, mustRest, mustRefuel, remainingDriveMinutes, restReason: "rest-10h"|"break-30min"|null }`.
- **`HubDockFeasibility`** = `{ canDispatch, canConsolidate }`.
- **Priority-ladder position:** the gate is **step 0** in both Decide functions — before DISPATCH/CONSOLIDATE (hub) and before DIVERT/HOLD/PROCEED (truck). Truck order within the gate: `mustRest` (HOS, the hard legal constraint) OUTRANKS `mustRefuel`; a legal+fueled verdict falls through to the (now-feasible) divert/hold/proceed ladder.

## Property-Test Coverage (infeasible outcomes unreachable)

- **Truck:** across the 144-observation space (3 HOS clocks × 4 odometers × 3 queue depths × 2 dock states), assert: `!canDrive ⇒ decision is `rest` (never proceed/divert)`; `canDrive && mustRefuel ⇒ decision is `refuel``; and `decision ∈ {proceed, divert} ⇒ canDrive && !mustRefuel` (feasibility-consistent).
- **Hub:** across the 16-observation space (dock × outbound × pending × fill), assert: `no free dock ⇒ decision is `hold` (never dispatch/consolidate)`; and `decision ∈ {dispatch, consolidate} ⇒ canDispatch`.
- **REUSE witness:** at 5 boundary clocks (fully-legal, at-11h, at-8h-break, one-under-11h, one-over-8h), `canDrive == mayDriveNow(...)` and `restReason ==` the engine's `applyDrivingLeg` segment plan.

## Task Commits

1. **Task 1: Pure binding-feasibility predicates reusing the domain HOS + fuel-threshold + dock logic** — `f04aca8` (feat)
2. **Task 2: Gate every Decide outcome through feasibility — infeasible outcomes unreachable** — `5ccecf3` (feat)

**Plan metadata:** _(this SUMMARY + STATE/ROADMAP)_ — committed separately.

## Files Created/Modified

- `packages/simulation/src/ooda/feasibility.ts` — NEW: `truckLegFeasibility` + `hubDockFeasibility` pure adapters delegating to the shared engines + their verdict types.
- `packages/simulation/src/ooda/feasibility.unit.test.ts` — NEW: Task-1 verdict + REUSE-witness boundary tests; Task-2 unreachable-infeasible property tests across the observation space.
- `packages/simulation/src/ooda/truck.ts` — `decideTruck` gains the optional binding-feasibility context + the step-0 gate; the refuel construction is factored into a shared `refuelDecision` helper (DRY).
- `packages/simulation/src/ooda/hub.ts` — `decideHub` gains the step-0 dock-feasibility gate (no free dock ⇒ hold; dispatch/consolidate guarded by the verdict).
- `packages/simulation/src/ooda/index.ts` — export the predicates + verdict types.
- `packages/simulation/src/engine.ts` — `stepAgents` passes the SHARED HosConfig + fuel threshold (MAX_SAFE when fuel off) + the virtual-clock `now` into `decideTruck`.

## Determinism Results

- **Flag-off byte-identical:** the `determinism.unit.test.ts` golden suite (incl. the seed-42 10k `3920accc…` assertion) and the two-part `oodaAgentsEnabled` flags-off gate stay green — the gate adds ZERO behavior on the off path.
- **Flag-on reproducible:** the `ooda-engine.unit.test.ts` integration suite (same-seed byte-identity, agent-order-shuffle witness, agents-own-decisions counts) stays green — the gate's verdict is pure (frozen observation + injected config + virtual-clock `now`), so the OODA-on run is unchanged and reproducible.
- **Gates:** `pnpm typecheck` clean (exit 0); `pnpm exec eslint` clean on all touched files (no `any`); 90 OODA+determinism tests + 439 simulation unit + 247 domain unit all green.

## Decisions Made

- **Delegate, never reimplement** — the predicate calls the domain functions and reads `restReason` off `applyDrivingLeg`'s segment plan; the REUSE-witness test pins this so a future edit can't silently fork the FMCSA math (T-24-09).
- **Gate is step 0, optional on the pure leaf** — the engine always passes the context (the real binding contract); the standalone fallback keeps `decideTruck` testable and keeps the 24-01 unit tests valid without a config.
- **Fuel-off ⇒ unreachable threshold** — passing `MAX_SAFE_INTEGER` when fuel is off keeps the fuel-off run event-identical (no fuel events), so the golden and the flag-on-fuel-off behavior are preserved.
- **`remainingDriveMinutes` surfaced** — the verdict carries the third HOS reuse (`remainingLegalDriveMinutes`) as the binding budget a P25 coordinator can inspect for a reject-with-reason.

## Deviations from Plan

None - plan executed exactly as written. The two `must_haves.artifacts` exports (`truckLegFeasibility`, `hubDockFeasibility`) and the `key_links` reuse pattern (`mayDriveNow|remainingLegalDriveMinutes|applyDrivingLeg`) are all present and witnessed by tests.

## Issues Encountered

- The vitest workspace `include` globs are root-relative (`packages/*/src/**/*.test.ts`), so the plan's `pnpm --filter @mm/simulation test -- src/ooda/...` path filter reported "No test files found"; ran via `pnpm exec vitest run --project unit packages/simulation/src/ooda/feasibility.unit.test.ts` (root-relative path) instead. No code impact — purely the test-invocation incantation.
- Initial lint flagged an unused `remainingLegalDriveMinutes` import and an inline `import()` type annotation; resolved by surfacing `remainingDriveMinutes` in the verdict (a genuine third-function reuse) and switching to a named `FuelConfig` import. Both fixed before the Task-1 commit.

## Next Phase Readiness

- **24-04** (determinism guard) will add the DET-03 static `no-restricted-imports` guard for the OODA packages and capture the OODA-on golden — `feasibility.ts` is already a pure, synchronous, `Date.now`/`Math.random`-free leaf importing only `@mm/domain` + `./hub.js`/`./observe.js` types, so it satisfies the guard as-is.
- **25-coordinators** can now arbitrate against the established binding contract: `ActionSuggested` cannot override the agent's feasibility verdict (infeasible outcomes are structurally unreachable); the `remainingDriveMinutes`/`restReason`/`mustRefuel`/dock verdict fields give the coordinator the data for a reject-with-reason.
- No blockers. The flag-off seed-42 golden remains byte-identical (`3920accc…`).

## Self-Check: PASSED

Both created files exist on disk (`ooda/feasibility.ts`, `ooda/feasibility.unit.test.ts`); both task commits (`f04aca8`, `5ccecf3`) are present in the git log.

---
*Phase: 24-ooda-step-agents*
*Completed: 2026-06-26*
