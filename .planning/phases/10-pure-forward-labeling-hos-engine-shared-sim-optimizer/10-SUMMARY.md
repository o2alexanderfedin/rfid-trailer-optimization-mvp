# Phase 10 — Pure forward-labeling HOS engine — SUMMARY

**One-liner:** Shipped the pure, deterministic forward-labeling HOS engine in `@mm/domain` (HOS-02/HOS-03) — `applyDrivingLeg`, `remainingLegalDriveMinutes`/`mayDriveNow`, and the 7/3 & 8/2 sleeper-berth split — the single DRY source the simulator (Phase 11) and optimizer (Phase 16) will both call unchanged.

## Built

Extended `packages/domain/src/hos.ts` (Phase-9 config module → now config + engine), exported from `packages/domain/src/index.ts`:

- **`isoToEpochMinutes` / `epochMinutesToIso`** — pure ISO↔integer-epoch-minute helpers (`Date.parse` on the *argument*, never the wall clock; patterned after `VirtualClock`).
- **`remainingLegalDriveMinutes(clock, config, now)`** (HOS-03) — `clamp≥0( min(maxDriveMin−driveTodayMin, dutyWindowDeadline−now, breakAfterDriveMin−sinceLastBreakMin) )`, `dutyWindowDeadline = dutyWindowStartAt + dutyWindowMin` (ABSOLUTE elapsed wall-clock).
- **`mayDriveNow(clock, config, now)`** (HOS-03) — `remaining>0 AND weeklyOnDutyMin < weeklyCapMin`.
- **`applyDrivingLeg(clock, config, legMinutes, occurredAt)`** (HOS-02) — forward-labeling sweep returning `{ segments: DutySegment[]; clock }`. Inserts a 30-min `break` at the 8h cumulative-drive boundary, a 10h off-duty `rest` at the 11h limit or the 14h ABSOLUTE deadline, and a 34h `rest` restart at the 70h/8-day cap. Never mutates the input clock.
- **`applySleeperBerthPeriod(clock, config, periodMinutes, occurredAt)`** — the 7/3 (420+180) & 8/2 (480+120) sleeper-berth splits; a qualifying period advances the window start (does NOT count against the 14h window → non-monotonic) and a completed LONG+SHORT≥10h pair resets the per-shift clocks.
- Types: **`DutySegment`** (`'drive'|'break'|'rest'|'sleeper'` + minutes), **`DrivingLegResult`**, **`SleeperBerthResult`**.

Built ON Phase-9 `HosClock`/`HosConfig`/`DEFAULT_HOS_CONFIG` (not redefined). Mirrors the `expectedMinutes` pure-function convention in `timing.ts`. No RNG, no I/O, no `Date.now()` — fully deterministic. ~345 LOC added to `hos.ts` (446 total).

## Tests

`packages/domain/test/hos-engine.unit.test.ts` — **31 tests** (written FIRST, RED before GREEN): determinism property + no-mutation + schema-valid output; boundary per limit (8h-break @480, 11h @660, 14h ABSOLUTE deadline, 70h cap → 34h restart, total-drive-equals-leg); the 14h-window-no-pause keystone (a break does NOT extend the deadline); sleeper-berth 7/3 + 8/2 completion + second-period-excluded-from-window + too-short non-qualifying; HOS-03 clock arithmetic + weekly-cap predicate gate.

## Gate (all four GREEN)

- `pnpm build` (turbo): **10/10 successful**
- `pnpm typecheck` (tsc): **exit 0**
- `pnpm lint` (eslint): **exit 0** (no `any`, strict TS, `noUncheckedIndexedAccess`)
- `pnpm test:all` (vitest unit+integration+ui): **1303 passed (126 files), exit 0** — the seeded golden-replay / determinism tests (`simulation/determinism.unit`, `simulation/rfid-determinism.unit` = 13/13; `api/projections-golden-replay.int` in the integration lane) stay byte-identical (Phase 10 is a pure function; no event emission, no sim/optimizer change). The 31 new engine tests are included.

## Scope honored

Pure engine ONLY. No sim accrual / event emission / 5th RNG substream / golden regeneration (Phase 11). No optimizer `restMin`/`serviceMin` fold or hard gate (Phase 16). The engine signature is designed so both downstream callers reuse it unchanged — `applyDrivingLeg` doubles as the optimizer's "rest-as-time" feasibility check (a leg is no-relay-legal iff its segments contain no `rest`/`sleeper`).
