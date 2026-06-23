---
status: passed
---

# Phase 10 — Pure forward-labeling HOS engine — VERIFICATION

**Verdict: PASSED.** All four phase success criteria are met and the full gate is green.

## Gate (all four GREEN)

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` (turbo) | 10/10 tasks successful |
| Typecheck | `pnpm typecheck` (`tsc -p tsconfig.eslint.json --noEmit`) | exit 0 |
| Lint | `pnpm lint` (eslint) | exit 0 (no `any`, strict TS, `noUncheckedIndexedAccess`) |
| Tests | `pnpm test:all` (vitest unit+integration+ui) | **1303 passed / 126 files, exit 0** |

## Success-criteria checklist

- [x] **SC1 — Pure forward-labeling engine (HOS-02).** `applyDrivingLeg(clock, config, legMinutes, occurredAt) → { segments: DutySegment[]; clock }` in `packages/domain/src/hos.ts`. Inserts a 30-min `break` when cumulative drive-since-break would exceed `breakAfterDriveMin` (480), a 10h off-duty `rest` at the 11h `maxDriveMin` (660) or the 14h ABSOLUTE window deadline, and a 34h `rest` restart at the 70h/8-day cap. Builds on the Phase-9 `HosClock`/`HosConfig` (not redefined). *Evidence:* `hos.ts` `applyDrivingLeg`; tests "30-min break after 8h driving", "10h off-duty rest", "weekly cap + 34h restart", "leg shorter than every limit" — all green.
- [x] **SC2 — Determinism (identical inputs → identical output).** Property test deep-equals repeated `applyDrivingLeg` / `applySleeperBerthPeriod` calls over legs that force breaks + rests; plus no-mutation of the input clock and `hosClockSchema`-valid output. No RNG, no `Date.now()` — ISO is parsed only from the *argument* (`isoToEpochMinutes`). *Evidence:* tests "applyDrivingLeg determinism (HOS-02 property)", "is deterministic — identical inputs yield identical output".
- [x] **SC3 — `remainingLegalDriveMinutes` / `mayDriveNow` (HOS-03).** `remainingLegalDriveMinutes = clamp≥0( min(maxDriveMin−driveTodayMin, dutyWindowDeadline−now, breakAfterDriveMin−sinceLastBreakMin) )` with `dutyWindowDeadline = dutyWindowStartAt + dutyWindowMin`; `mayDriveNow = remaining>0 AND weeklyOnDutyMin < weeklyCapMin`. *Evidence:* tests "remainingLegalDriveMinutes (HOS-03)" (drive/break/window/clamp bindings) + "mayDriveNow (HOS-03 predicate)" (weekly-cap gate).
- [x] **SC4 — Full-FMCSA: 70h/8-day cap + 34h restart, and sleeper-berth 7/3 & 8/2 splits.** Weekly cap gates driving and triggers a 34h restart that zeroes the weekly counter. `applySleeperBerthPeriod` implements both splits: a qualifying period advances the window start (does NOT count against the 14h window → non-monotonic), and a completed LONG(≥7h)+SHORT(≥2h)≥10h pair resets the per-shift clocks. *Evidence:* tests "weekly 70h/8-day cap + 34h restart", "7/3 split", "8/2 split", "the SECOND (qualifying-sleeper) period does NOT count against the 14h window".

## Requirement coverage

| Req | Where | Evidence |
|---|---|---|
| **HOS-02** | `hos.ts` `applyDrivingLeg` (+ `applySleeperBerthPeriod`), exported from `index.ts` | `test/hos-engine.unit.test.ts` break/rest/restart/sleeper/short-leg + determinism + no-mutation + schema-valid (31 tests, all green) |
| **HOS-03** | `hos.ts` `remainingLegalDriveMinutes`, `mayDriveNow` | `test/hos-engine.unit.test.ts` "remainingLegalDriveMinutes (HOS-03)", "mayDriveNow (HOS-03 predicate)" |

## Keystone-trap verification (the 14h window is elapsed wall-clock)

Explicit, dedicated tests prove the prime correctness trap:
- "a 30-min break does NOT extend the 14h window deadline" — after a break is inserted at the 8h boundary, `dutyWindowStartAt` is unchanged and the deadline stays at `comeOnDuty + 840`.
- "driving + a break consumes elapsed wall-clock so the window can bind before 11h" — starting 13h40m into the window forces a 10h rest with the 11h budget still large.
The window is modeled as an ABSOLUTE deadline (`dutyWindowStartAt + dutyWindowMin`), never a pausing counter. Only a 10h rest / 34h restart / completed sleeper split moves the window start.

## Determinism keystone (no golden regression)

Phase 10 adds a PURE function with no event emission and no change to the simulator or optimizer, so the existing byte-identical seeded golden-replay invariant is untouched:
- `simulation/test/determinism.unit.test.ts` + `simulation/test/rfid-determinism.unit.test.ts` — **13/13 passed**.
- `api/test/projections-golden-replay.int.test.ts` — passed in the green `test:all` integration lane.

## Scope honored

No sim accrual / event emission / 5th RNG substream / golden regeneration (deferred Phase 11). No optimizer `restMin`/`serviceMin` fold or hard feasibility gate (deferred Phase 16). The engine signature is the DRY source both will reuse unchanged — `applyDrivingLeg` doubles as the optimizer's "rest-as-time" feasibility check (a leg is no-relay-legal iff its `segments` contain no `rest`/`sleeper`).
