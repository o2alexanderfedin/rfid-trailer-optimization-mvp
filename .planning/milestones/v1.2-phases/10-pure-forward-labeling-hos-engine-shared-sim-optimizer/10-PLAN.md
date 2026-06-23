# Phase 10 — Pure forward-labeling HOS engine — PLAN

**Branch:** `feature/phase-10-pure-forward-labeling-hos-engine-shared-sim-optimizer`
**Reqs:** HOS-02, HOS-03
**Mode:** TDD (RED → GREEN → artifacts). Pure logic module + tests only — NO sim/optimizer integration (deferred to Phases 11 / 16).

## Goal

Deliver the single, pure, deterministic **forward-labeling HOS engine** in `@mm/domain` — the DRY source both the simulator (Phase 11) and the optimizer (Phase 16) will call unchanged. Pure integer-minute math: no RNG, no I/O, no `Date.now()`. Build ON Phase-9 `HosClock` / `HosConfig` / `DEFAULT_HOS_CONFIG`; do not redefine them. Mirror the `expectedMinutes` pure-function convention in `timing.ts`.

## Design (executed)

- **Module:** extend `packages/domain/src/hos.ts` (the Phase-9 config module), exported via `packages/domain/src/index.ts`. Patterned after `timing.ts` (pure helpers beside their config) and `VirtualClock` (ISO↔epoch via `Date.parse` on the *argument*, never the wall clock).
- **Time representation:** the persisted `HosClock` carries `dutyWindowStartAt`/`comeOnDutyAt` as ISO stamps (Phase-9 contract). The engine reduces ISO → integer epoch-minutes internally via pure `isoToEpochMinutes` / `epochMinutesToIso` (1 tick = 1 min). `remainingLegalDriveMinutes`/`mayDriveNow` take `now` as epoch-minutes; `applyDrivingLeg`/`applySleeperBerthPeriod` take `occurredAt` as an ISO instant (matching the event `occurredAt` convention).
- **`DutySegment`** = `{ kind: 'drive'|'break'|'rest'|'sleeper'; minutes }` — closed FMCSA taxonomy, positive integer minutes.

### HOS-03 — clock arithmetic
- `remainingLegalDriveMinutes(clock, config, now) = clamp≥0( min(maxDriveMin−driveTodayMin, dutyWindowDeadline−now, breakAfterDriveMin−sinceLastBreakMin) )` where `dutyWindowDeadline = isoToEpochMinutes(dutyWindowStartAt) + dutyWindowMin` (ABSOLUTE elapsed wall-clock, never a counter).
- `mayDriveNow = remaining>0 AND weeklyOnDutyMin < weeklyCapMin`.

### HOS-02 — forward-labeling engine (`applyDrivingLeg`)
Walk the leg minute-budget forward; before each driving chunk insert the SMALLEST legal rest:
1. **Weekly 70h cap binds** (`weeklyOnDutyMin >= weeklyCapMin`) → `rest` of `restartMin` (34h), zeroes the weekly counter. Checked first (HOS-03's `remaining` formula deliberately excludes the weekly cap). Drive chunks are also bounded by `weeklyCapMin − weeklyOnDutyMin` so the cap binds exactly, never overshoots.
2. **8h-break clock binds** (`breakAfterDriveMin − sinceLastBreakMin <= 0`) → `break` of `minBreakMin` (30), resets the 8h clock ONLY. The 14h window does NOT pause.
3. **11h limit OR 14h window binds** → `rest` of `resetOffDutyMin` (10h): resets per-shift clocks and moves `dutyWindowStartAt`/`comeOnDutyAt` forward.
Returns `{ segments, clock }`; never mutates the input clock.

### Full-FMCSA — sleeper-berth 7/3 & 8/2 (`applySleeperBerthPeriod`)
A qualifying period (`>= 2h`) advances `dutyWindowStartAt` by its own duration (the period does NOT count against the 14h window → non-monotonic). A `>=7h` period fills the LONG (berth) accumulator; a 2–<7h period fills SHORT. When LONG (`>=7h`) + SHORT (`>=2h`) are both present and total `>= 10h`, the split COMPLETES: per-shift clocks reset, accumulators clear, `reset: true`. Handles both 7/3 (420+180) and 8/2 (480+120).

## Test plan (written FIRST — `packages/domain/test/hos-engine.unit.test.ts`)
- Determinism property: identical inputs ⇒ deep-equal output (incl. legs forcing breaks + rests); no-mutation; returned clock validates against `hosClockSchema`.
- Boundary per limit: 8h-break @480, 11h @660, 14h ABSOLUTE deadline, 70h cap → 34h restart, total-drive-equals-leg invariant.
- **14h-no-pause keystone:** an inserted break does NOT extend the window deadline; elapsed window can force a 10h rest before the 11h limit.
- Sleeper-berth 7/3 + 8/2 completion, second-period-excluded-from-window (non-monotonic), too-short non-qualifying.
- HOS-03 `remainingLegalDriveMinutes` + `mayDriveNow` cases incl. weekly-cap gate.

## Gate (all four must be green)
`pnpm build` (turbo) · `pnpm typecheck` (tsc exit 0) · `pnpm lint` (eslint 0) · `pnpm test:all` (vitest unit+integration+ui). The existing seeded golden-replay determinism tests MUST remain byte-identical (pure function, no event emission, no sim change).

## Out of scope (deferred)
Sim accrual / event emission / 5th RNG substream / golden regeneration → Phase 11. Optimizer `restMin`-as-`serviceMin` fold + hard gate → Phase 16.
