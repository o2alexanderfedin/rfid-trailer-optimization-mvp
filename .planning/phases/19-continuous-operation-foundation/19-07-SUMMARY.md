# Plan 19-07 Summary — Sort-wave cadence (P2)

**Status:** complete · **Wave:** 3 · **Requirements:** CONT-05 (P2)

## What landed (`packages/simulation/src/engine.ts`)
- `SortWaveConfig` interface (`burstWindowTicks`, `quietWindowTicks`, `burstPackagesPerBatch`) + `sortWave?: SortWaveConfig` on `SimulateOptions`; both re-exported from the simulation index.
- Burst-gate at the top of `createPackageBatch` — ENTERED ONLY when `sortWave` is present, so an absent config leaves the original code path and RNG draw EXACTLY as before (byte-identical goldens). When present: `cycle = tick % (burst+quiet)`; quiet window (`cycle >= burstWindowTicks`) emits nothing but keeps self-scheduling; burst window creates `burstPackagesPerBatch`. Pure tick modular arithmetic — no RNG salt.
- `open-ended.unit.test.ts`: CONT-05 smoke tests — off byte-identical; ON differs + non-empty; PackageCreated falls only inside burst windows; ON deterministic.

## DET-01/DET-02 keystone verified
seed-1234/6000 + seed-42/10000 goldens BYTE-IDENTICAL with `sortWave` absent. sim unit 19/19 GREEN. build/typecheck/lint clean.
