# Plan 19-04 Summary — driveSimulationOpenEnded() chunked driver

**Status:** complete · **Wave:** 2 · **Requirements:** CONT-01/02

## What landed (`packages/api/src/sim/driver.ts`)
- `DriveSimulationOpenEndedOptions extends DriveSimulationPacedOptions` (+`stopped?: () => boolean`, +`chunkTicks?: number`, default 500).
- `driveSimulationOpenEnded()` — generates the deterministic stream in finite CHUNKS on demand (NOT pre-baked — Pitfall 1): `ensureHorizon()` extends `horizonTick` by `chunkTicks` as the paced `simClock` nears the end of the generated window, regenerating up to the new horizon and driving only the newly-revealed ticks. Reuses `appendTick`/`foldFrame`/coalesced optimizer/broadcast + `computeSimAdvanceMs`/`selectDrain` unchanged. Terminates on `stopped()`.
- `destHubIndexFromTicks` helper mirrors `destHubIndex` over grouped ticks.
- Both function + interface re-exported from `packages/api/src/index.ts`.
- `driveSimulation`/`driveSimulationPaced`/`driveSimulationWithScenario` untouched.

## Result
New `packages/api/test/open-ended-driver.int.test.ts` (real Postgres): run continues past the initial 40-tick horizon to 160+, stops cleanly, monotone simMs — PASS. `paced-soak.int` (2/2) unchanged. build/typecheck clean.
