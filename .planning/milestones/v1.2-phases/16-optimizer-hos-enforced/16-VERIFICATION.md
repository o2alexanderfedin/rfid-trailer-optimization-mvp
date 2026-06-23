---
status: passed
---

# Phase 16: Optimizer HOS-enforced — VERIFICATION

**Verified:** 2026-06-22
**Requirements:** OPT-HOS-02, OPT-HOS-03
**Commit:** `675de24`

## Gate (all four green)

| Gate | Command | Result |
|------|---------|--------|
| Build | `pnpm build` | ✅ 10/10 packages |
| Typecheck | `pnpm typecheck` (`tsc --noEmit`, strict, no `any`) | ✅ clean |
| Lint | `pnpm lint` (eslint 9) | ✅ clean |
| Tests | `pnpm test:all` | ✅ **1416 passed** (133 files); +18 new HOS tests over the ~1398 baseline |

## Regression guards (must stay green UNCHANGED)

| Guard | Result |
|-------|--------|
| glpk LP oracle — `packages/optimizer/src/graph/glpk-oracle.test.ts` | ✅ green, source unchanged |
| glpk LP oracle — `packages/optimizer/src/flow/glpk-oracle.test.ts` | ✅ green, source unchanged |
| planner-vs-validator property — `packages/load-planner/test/planner-vs-validator.property.test.ts` | ✅ green, source unchanged |

These have NO driver context, so the HOS hard gate never fires for them (`hosFeasible` stays `undefined`). The min-cost-flow LP subproblem the glpk oracle checks is separate from VRPTW route feasibility and is untouched. Verified by a direct run: 3 files, 8 tests passed.

## Success criteria → evidence

### Criterion 1 — `restMin` folds into `serviceMin` in `feasibility.ts`, no new graph edge kind (OPT-HOS-02)
- `vrptw/types.ts`: optional `Stop.restMin`.
- `vrptw/feasibility.ts`: `departure = serviceStart + serviceMin + (restMin ?? 0)` — no edge kind added (`time-expanded.ts` edge kinds unchanged).
- **Tests:** `vrptw/feasibility.test.ts` — "adds restMin to the departure", "omitting restMin is byte-identical to restMin: 0", "restMin does NOT change when service may BEGIN", "deterministic". ✅

### Criterion 2 — hard gate rejects any leg the assigned driver cannot legally complete, reusing the same HOS engine (OPT-HOS-02)
- `vrptw/route-trailers.ts`: `hosLegsFeasible` walks each driving leg through the SHARED `applyDrivingLeg` (`@mm/domain`, Phase-10) — no reimplementation. A leg requiring an inserted `rest`/`sleeper` fails; verdict on a SEPARATE `TrailerRoute.hosFeasible`, ANDed into `feasible` (anti-P2, mirrors the Phase-2 LIFO gate).
- **Tests:** `vrptw/route-trailers.test.ts` — "a fresh driver completing a short leg is HOS-feasible", "a leg the driver cannot legally finish … is HOS-INFEASIBLE", "HOS infeasibility is SEPARATE from window/LIFO feasibility", "deterministic with a driver"; plus "NO driver context ⇒ HOS gate inactive" (back-compat). ✅

### Criterion 3 — `localRepair` surfaces an `insertRestStop` / driver-relay recommendation via `EpochRecommendation` when HOS makes an assignment infeasible (OPT-HOS-03)
- `repair/local-repair.ts`: `RepairKind` += `insertRest | relay`; `hosVariants` emits both (load layout unchanged → passes the reused Phase-2 gate); rationale names driver + leg + why.
- `rolling/epoch.ts`: `firstHosInfeasibleLeg` builds the `hosInfeasible` leg from the same Phase-10 walk; surfaced through the existing `localRepair → EpochRecommendation.repairRecommendations` path. Never crashes the epoch.
- **Tests:** `repair/local-repair.test.ts` — "surfaces an insertRest AND a relay recommendation", "every HOS recommendation is FEASIBLE", "rationale NAMES the driver, the leg, and why", "does NOT crash … even when the load layout is feasible", "deterministic"; `rolling/epoch.test.ts` — "a depleted driver makes the trailer HOS-INFEASIBLE", "surfaces an insertRest OR relay recommendation … without crashing", "a trailer WITHOUT a full hosClock keeps its prior verdict". ✅

### Criterion 4 — determinism + glpk oracle tests green; integer arithmetic preserved
- Determinism tests in all four suites assert identical / byte-identical (`JSON.stringify`) output for identical inputs. No RNG, no `Date.now()` introduced — the leg-start instant derives purely from `startMin`/`departureMin` + integer travel minutes via `epochMinutesToIso`.
- glpk oracle + planner-vs-validator green & unchanged (see Regression guards).
- **Tests:** "is deterministic with a driver", epoch "PURITY: identical HOS-enforced inputs ⇒ byte-identical result", feasibility "deterministic with restMin". ✅

## Requirement checklist

| Requirement | Met | Evidence |
|-------------|-----|----------|
| OPT-HOS-02 (rest-as-`serviceMin` + hard gate, reuse HOS-02 engine, Phase-2 LIFO-gate pattern) | ✅ | Criteria 1 + 2 |
| OPT-HOS-03 (insertRest/relay via `localRepair → EpochRecommendation`) | ✅ | Criterion 3 |

## Tight-HOS infeasibility handling
A leg no driver context can legally complete (drive/window/weekly clock exhausted) is reported as `hosFeasible: false` and recovered via an `insertRest`/`relay` recommendation — **not** an exception or a hang. Proven by `rolling/epoch.test.ts` "surfaces an insertRest OR relay recommendation … without crashing" and `repair/local-repair.test.ts` "does NOT crash".

## Verdict
**PASSED** — all 4 success criteria met, OPT-HOS-02/03 delivered, full `test:all` green (1416), glpk oracle + planner-vs-validator green and unchanged, optimizer pure & deterministic.
