# Plan 19-02 Summary — Open-ended run loop + streaming onEvent

**Status:** complete · **Wave:** 1 · **Requirements:** CONT-01/02, DET-01

## What landed (`packages/simulation/src/engine.ts`)
Four surgical edits to `SimulateOptions` + `generate()`:
1. Added `runUntilStopped?: boolean`, `onEvent?: (e) => void`, `stop?: () => boolean`.
2. `emit()` closure delivers via `onEvent` when present (else `out.push` — unchanged).
3. `createPackageBatch` + `arriveTrailer` self-reschedule past `durationTicks` when `runUntilStopped` (finite-path guards preserved exactly).
4. Main loop ignores the `durationTicks` ceiling and polls `stop()` when open-ended; finite path unchanged.

`simulate()`/`runSimulation()` wrappers, `EventQueue`, and the 5 salts are untouched.

## DET-01 keystone verified
seed-1234/6000 → `0f11c75f…` and seed-42/10000 → `3920accc…` BYTE-IDENTICAL to pre-change; `runUntilStopped:false` == absent. Open-ended unit tests GREEN; only the DET-02 placeholder remained RED (filled by 19-03).
