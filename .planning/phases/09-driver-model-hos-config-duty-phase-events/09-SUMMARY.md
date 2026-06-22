# Phase 9 Summary: Driver model + HOS config + duty/phase events

**One-liner:** Added the v1.2 driver/HOS domain primitives — `Driver`, `HosClock`, full-FMCSA `HosConfig`, optional `Trip.driverId`, and seven new closed-union events (four driver-lifecycle + three load/unload phase events) — as pure zod schemas with the closed-union contract green and the seeded golden-replay byte-identical (no behavior added).

## What was built

- **DRV-01** `driverSchema`/`Driver` + `dutyStatusSchema`/`DutyStatus` (`driving|on_break|resting|off_duty`); optional `name`/`licenseClass`.
- **DRV-02** `hosClockSchema`/`HosClock` value-object — integer-minute counters (`driveTodayMin`, `sinceLastBreakMin`, `weeklyOnDutyMin`), ISO stamps (`dutyWindowStartAt`, `comeOnDutyAt`), and the `sleeperBerthLongMin`/`sleeperBerthShortMin` 7/3 & 8/2 split accumulators.
- **DRV-03** `tripSchema` gains an optional `driverId` (back-compat — pre-v1.2 fixtures with no `driverId` stay valid).
- **HOS-01** new `hos.ts` (mirrors `timing.ts`): `HosConfig` + `hosConfigSchema` (strict, positive-int) + `DEFAULT_HOS_CONFIG` = `{maxDriveMin:660, dutyWindowMin:840, breakAfterDriveMin:480, minBreakMin:30, resetOffDutyMin:600, weeklyCapMin:4200, restartMin:2040, sleeperBerthLongMin:420, sleeperBerthShortMin:180, sleeperBerthAltLongMin:480, sleeperBerthAltShortMin:120}`.
- **EVT-01** `DriverRegistered`, `DriverAssignedToTrip`, `DriverDutyStateChanged` (carries `reason` + an `HosClock` snapshot via `clock`), `DriverSwappedAtHub` — added to the closed `DomainEvent` discriminated union.
- **EVT-02** `UnloadStarted`, `LoadStarted`, `UnloadCompleted` — shared `phaseEventPayload` of exactly `{trailerId, hubId, tripId, occurredAt}` (no RNG → determinism keystone honored).

The union grew **13 → 20** events. `contract.assert.ts` (compile-time exhaustive switch + zod/union type-equality) and every project-wide `assertNeverEvent` switch were extended with minimal no-op cases — **no Phase-10+ behavior**.

## Files

**New (3):**
- `packages/domain/src/hos.ts` — `HosConfig`, `hosConfigSchema`, `DEFAULT_HOS_CONFIG`.
- `packages/domain/test/driver-hos.unit.test.ts` — Driver/HosClock/HosConfig/Trip back-compat tests (RED-first).
- `packages/domain/test/events-phase9.unit.test.ts` — the 7 new events' validation + round-trip + no-RNG-keystone tests (RED-first).

**Modified — domain (6):**
- `entities/index.ts` (Driver/DutyStatus/HosClock + `Trip.driverId`), `events/schemas.ts` (7 payload schemas + union wiring), `events/domain-event.ts` (7 type aliases + union arms), `events/contract.assert.ts` (7 exhaustive cases), `events/index.ts` + `index.ts` (re-exports), `test/events.unit.test.ts` (exhaustive switch + 20-member union assertion).

**Modified — consumers kept compiling, no behavior (9):**
- 8 projection reducers (`package-location`, `trailer-state`, `exceptions`, `hub-inventory`, `zone-estimate`, `tag-registry`, `geo-track`, `audit-timeline`) — new events no-op.
- `optimizer/src/rolling/scope.ts` — new events scope-neutral (`return []`).

## Gate results

| Gate | Command | Result |
|------|---------|--------|
| Build | `pnpm build` (turbo, 10 packages) | PASS — 10/10 successful |
| Typecheck | `pnpm typecheck` (`tsc -p tsconfig.eslint.json --noEmit`) | PASS — exit 0 |
| Lint | `pnpm lint` (ESLint flat, no `any`/no-fallthrough) | PASS — 0 problems |
| Tests | `pnpm test:all` (unit + integration + ui) | PASS — see counts below |

- **Domain unit suite:** 175 passed / 10 files (includes the 2 new Phase-9 files + the updated `events.unit.test.ts`).
- **Determinism golden:** `simulation/test/determinism.unit.test.ts` 8/8 PASS, byte-identical (no new event emitted, stream unchanged); `rfid-determinism.unit.test.ts` PASS.
- **Full `test:all`:** PASS — **125 test files, 1272 tests, all passed** (unit + integration via testcontainers Postgres + ui), exit 0, no regressions.

## Determinism confirmation

This phase emits no new event and introduces no RNG draw, so the pre-v1.2 seeded golden-replay stream is byte-identical (verified). Phase-event payloads were asserted to carry exactly the four `{trailerId,hubId,tripId,occurredAt}` keys — no RNG value can leak in. The fifth `hosRng` substream + HOS-on golden are deferred to Phase 11 per the roadmap.
