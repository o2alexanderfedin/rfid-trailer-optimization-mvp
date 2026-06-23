# Phase 16: Optimizer HOS-enforced — PLAN

**Requirements:** OPT-HOS-02, OPT-HOS-03
**Depends on:** Phase 15 (`TwinDriver` soft awareness), Phase 10 (shared HOS engine in `@mm/domain`), Phase 2 (LIFO validation gate in `@mm/load-planner`)
**Risk:** HIGHEST — hard optimizer enforcement. The pure/deterministic optimizer + the glpk LP oracle + the planner-vs-validator property test MUST stay green unchanged.

## Goal

Make the optimizer **hard-enforce** driver Hours-of-Service:
1. Rest folds into service time (rest-as-time, no new graph edge kind).
2. A driving leg the assigned driver cannot legally complete is **infeasible** (a SEPARATE hard verdict, mirroring the Phase-2 LIFO gate — never folded into the cost objective).
3. An HOS-infeasible assignment surfaces an explainable `insertRest`/`relay` recommendation through the existing `localRepair → EpochRecommendation` path — without crashing the epoch.

Reuse the SAME Phase-10 `applyDrivingLeg`/`remainingLegalDriveMinutes` engine (DRY). Keep the optimizer pure & deterministic (integer minutes, sorted-by-id, no RNG, no `Date.now()`).

## TDD task breakdown

### Task 1 — OPT-HOS-02a: rest-as-time (`restMin` → `serviceMin`)
- **RED** `vrptw/feasibility.test.ts` (new): a stop's optional `restMin` adds to its departure; omitting it is byte-identical to `restMin: 0`; rest never changes when service may BEGIN (window checked on arrival only); deterministic.
- **GREEN** `vrptw/types.ts` — add optional `restMin?: number` to `Stop`. `vrptw/feasibility.ts` — `departure = serviceStart + serviceMin + (restMin ?? 0)`. No new edge kind.

### Task 2 — OPT-HOS-02b: hard HOS feasibility gate
- **RED** `vrptw/route-trailers.test.ts`: with a `DriverHosContext` (driverId + full `HosClock` + config), a fresh driver on a short leg is HOS-feasible; a driver whose drive/window clock is exhausted on a long leg is HOS-INFEASIBLE (`hosFeasible:false`, `feasible:false`); HOS infeasibility is SEPARATE from window/LIFO; deterministic; NO driver context ⇒ `hosFeasible` undefined (gate inactive, back-compat).
- **GREEN** `vrptw/types.ts` — `DriverHosContext` interface; `hosFeasible?: boolean` on `TrailerRoute`. `vrptw/route-trailers.ts` — `hosLegsFeasible(...)` walks each driving leg through `applyDrivingLeg`; a leg requiring an inserted `rest`/`sleeper` segment fails (a 30-min `break` is allowed — rest-as-time). Gate runs only when `input.driver` is present; `feasible = windowOk && loadFeasible && hosFeasible !== false`.

### Task 3 — OPT-HOS-03: insertRest / relay recommendation
- **RED** `repair/local-repair.test.ts`: given a `hosInfeasible` leg on the scope (load layout LIFO-feasible), `localRepair` surfaces `insertRest` AND `relay`; both feasible (layout unchanged); rationale names the driver + leg + why; no crash; deterministic.
- **GREEN** `repair/local-repair.ts` — extend `RepairKind` with `insertRest | relay`; add `HosInfeasibleLeg` + optional `hosInfeasible` on `RepairScope`; `hosVariants(scope)` emits the two recommendations (layout unchanged → passes the reused Phase-2 gate); prepend them and skip LIFO repair when the layout is already feasible.

### Task 4 — wire the live epoch (OPT-HOS-02/03 end-to-end)
- **RED** `rolling/epoch.test.ts`: a trailer whose `driver.hosClock` shows a depleted driver is HOS-infeasible; `repairRecommendations` carries an `insertRest`/`relay` naming the driver; a soft-only driver (no `hosClock`) keeps its prior verdict; deterministic.
- **GREEN** `rolling/types.ts` — optional `hosClock`/`hosConfig` on `TwinDriver`. `rolling/epoch.ts` — `driverHosContextFor` (activates the gate only with a full clock); pass `driver` to `routeTrailers`; `firstHosInfeasibleLeg` (same Phase-10 walk) builds the `hosInfeasible` leg for `localRepair`.

## Regression invariants (must hold)
- Gate fires ONLY with a `TwinDriver`/`DriverHosContext` carrying a full `hosClock`. Existing optimizer instances + the **glpk LP oracle** (`graph/`, `flow/` glpk-oracle.test.ts) + the **planner-vs-validator** property test have no driver context → MUST stay green UNCHANGED.
- Pure & deterministic: integer math, sorted-by-id, no RNG, no `Date.now()`.
- Tight-HOS infeasibility handled GRACEFULLY via the recommendation path — never throw/hang the epoch.

## Gate
`pnpm build` (turbo) · `pnpm typecheck` · `pnpm lint` · `pnpm test:all` — all green, glpk oracle + planner-vs-validator unchanged.
