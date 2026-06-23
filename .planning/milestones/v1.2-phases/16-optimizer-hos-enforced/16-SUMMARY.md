# Phase 16: Optimizer HOS-enforced — SUMMARY

**Status:** Complete. All 4 success criteria met; full gate green.
**Requirements delivered:** OPT-HOS-02, OPT-HOS-03.
**Commit:** `675de24` feat(optimizer): Phase 16 — hard-enforce driver HOS (OPT-HOS-02/03)

## What was built

### OPT-HOS-02 — rest-as-time + the hard HOS feasibility gate
- **`restMin` on `Stop`** (`vrptw/types.ts`) — optional driver-rest minutes, folded into the existing service computation in `vrptw/feasibility.ts`: `departure = max(arrival, windowStart) + serviceMin + (restMin ?? 0)`. **No new graph edge kind** (KISS). Omitting it is byte-identical to `restMin: 0`. The window is still checked on ARRIVAL only, so rest never shifts when service may begin.
- **`DriverHosContext`** (`vrptw/types.ts`) — `{ driverId, hosClock, config? }`. Supplying it on `RouteTrailersInput.driver` (and ONLY then) activates the gate.
- **Hard gate** (`vrptw/route-trailers.ts`, `hosLegsFeasible`) — walks each ordered driving leg through the SHARED Phase-10 `applyDrivingLeg` engine (DRY — the optimizer owns no HOS arithmetic). A leg the driver cannot legally complete (the engine had to insert a `rest`/`sleeper` segment) fails. A 30-min `break` is allowed (folds in as time, not an infeasibility). The verdict is a SEPARATE `hosFeasible?: boolean` on `TrailerRoute`, ANDed into `feasible` (`feasible = windowOk && loadFeasible && hosFeasible !== false`) but never folded into any cost — mirroring the proven Phase-2 LIFO HARD/SOFT gate.

### OPT-HOS-03 — insertRest / driver-relay recommendation
- **`RepairKind` extended** with `insertRest | relay` and a `HosInfeasibleLeg` + optional `hosInfeasible` on `RepairScope` (`repair/local-repair.ts`).
- **`hosVariants`** emits an `insertRest` (mandatory 10h rest before the leg, same driver) and a `relay` (fresh-driver swap at the hub) recommendation. The load layout is unchanged (LIFO-feasible), so both pass the REUSED Phase-2 `validatePlan` gate. Each rationale names the driver, the leg (`from→to`), and the why (`N legal drive minutes left but leg needs M`) — explainable / anti-repudiation. When the layout is already feasible, the LIFO repairs are skipped so only the HOS recommendations surface.

### Live epoch wiring (end-to-end)
- **`TwinDriver`** (`rolling/types.ts`) gains optional `hosClock`/`hosConfig`. Present ⇒ the epoch runs the hard gate; absent ⇒ the Phase-15 soft-only behavior (byte-identical prior verdicts).
- **`rolling/epoch.ts`** — `driverHosContextFor` builds the gate context (only with a full clock); the `routeTrailers` call receives it; `firstHosInfeasibleLeg` (the same Phase-10 walk) locates the offending leg and feeds `localRepair`, surfacing `insertRest`/`relay` through the existing `localRepair → EpochRecommendation` path. The epoch never crashes on tight-HOS infeasibility.

## Key decisions
- **Rest-as-time, no new edge kind** — verified sound by the grounding (`v1.2-DRIVER-HOS-GROUNDING.md`, verdict 4); `feasibility.ts` already computes `departure = serviceStart + serviceMin`, so `restMin` folds in with one term.
- **Separate HOS feasibility from score** — the Phase-2 LIFO gate pattern; `hosFeasible` is its own field, never in the objective.
- **Gate gated on driver context** — the regression keystone. No driver context ⇒ `hosFeasible` undefined ⇒ the glpk LP oracle (a separate min-cost-flow subproblem) and the planner-vs-validator property test are untouched.
- **Reuse the SAME engine** — `applyDrivingLeg` / `remainingLegalDriveMinutes` from `@mm/domain`, not a reimplementation.

## Files changed
- `packages/optimizer/src/vrptw/types.ts` — `Stop.restMin`, `DriverHosContext`, `TrailerRoute.hosFeasible`.
- `packages/optimizer/src/vrptw/feasibility.ts` — fold `restMin` into departure.
- `packages/optimizer/src/vrptw/feasibility.test.ts` — NEW (rest-as-time).
- `packages/optimizer/src/vrptw/route-trailers.ts` — `hosLegsFeasible` hard gate.
- `packages/optimizer/src/vrptw/route-trailers.test.ts` — hard-gate + back-compat tests.
- `packages/optimizer/src/repair/local-repair.ts` — `insertRest`/`relay` variants.
- `packages/optimizer/src/repair/local-repair.test.ts` — OPT-HOS-03 tests.
- `packages/optimizer/src/rolling/types.ts` — `TwinDriver.hosClock`/`hosConfig`.
- `packages/optimizer/src/rolling/epoch.ts` — gate wiring + `firstHosInfeasibleLeg`.
- `packages/optimizer/src/rolling/epoch.test.ts` — end-to-end HOS enforcement tests.

## Gate result
`pnpm build` 10/10 · `pnpm typecheck` clean · `pnpm lint` clean · `pnpm test:all` **1416 passed** (133 files; +18 new HOS tests over the ~1398 baseline). glpk oracle (`graph/`+`flow/` glpk-oracle.test.ts) + planner-vs-validator property test green & unchanged. Optimizer stays pure/deterministic.
