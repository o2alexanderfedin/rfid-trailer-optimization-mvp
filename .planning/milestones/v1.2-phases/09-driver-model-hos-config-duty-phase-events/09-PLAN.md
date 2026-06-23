# Phase 9 Plan: Driver model + HOS config + duty/phase events

**Milestone:** v1.2 — Driver HOS & Hub Detail
**Branch:** `feature/phase-9-driver-model-hos-config-duty-phase-events`
**Scope:** Domain types + events ONLY. No behavior (no sim/optimizer/projection/UI logic).
**Method:** TDD (RED → GREEN → refactor). Closed-union contract preserved; determinism keystone honored.

## Requirements covered

| ID | Requirement | Where |
|----|-------------|-------|
| DRV-01 | `Driver` entity (`driverId`, optional `name`/`licenseClass`, `dutyStatus`) zod schema | `packages/domain/src/entities/index.ts` |
| DRV-02 | `HosClock` value-object (integer-minute fields + sleeper-berth split accumulators) | `packages/domain/src/entities/index.ts` |
| DRV-03 | `Trip.driverId` optional (back-compat) | `packages/domain/src/entities/index.ts` |
| HOS-01 | `HosConfig` + `DEFAULT_HOS_CONFIG` (full-FMCSA constants + 7/3 & 8/2 split params) | `packages/domain/src/hos.ts` (new) |
| EVT-01 | `DriverRegistered`, `DriverAssignedToTrip`, `DriverDutyStateChanged` (reason + clock snapshot), `DriverSwappedAtHub` join the closed union | `packages/domain/src/events/*` |
| EVT-02 | `UnloadStarted`, `LoadStarted`, `UnloadCompleted` phase events (`trailerId,hubId,tripId,occurredAt` only) | `packages/domain/src/events/*` |

## Tasks (as executed)

### Task 1 — RED: write the tests first
- `packages/domain/test/driver-hos.unit.test.ts` (new): `Driver`/`DutyStatus` (DRV-01), `HosClock` (DRV-02), `Trip.driverId` back-compat (DRV-03), `HosConfig`/`DEFAULT_HOS_CONFIG` (HOS-01). Validation (zod parse/reject) + inferred-type assertions, matching the existing `entities-phase2`/`events` test conventions.
- `packages/domain/test/events-phase9.unit.test.ts` (new): all 7 new events validate + round-trip through `validateEvent`; `.strict()` extra-field rejection; `DriverDutyStateChanged` carries `reason` + `HosClock` snapshot; phase events carry ONLY the four `{trailerId,hubId,tripId,occurredAt}` keys (no-RNG keystone); exhaustive switch dispatch. Patterned on `events-phase3.unit.test.ts`.
- `packages/domain/test/events.unit.test.ts` (edit): extend the exhaustive `describeEvent` switch, update the base-13 count test wording, grow the `DomainEventType` exact-union assertion to 20.

### Task 2 — GREEN: implement the domain primitives
- `entities/index.ts`: add `dutyStatusSchema`/`DutyStatus`, `driverSchema`/`Driver`, `hosClockSchema`/`HosClock`; add optional `driverId` to `tripSchema`.
- `hos.ts` (new): `HosConfig` interface (readonly integer-minute contract), `hosConfigSchema` (strict, positive-int), `DEFAULT_HOS_CONFIG` (660/840/480/30/600/4200/2040 + 420/180/480/120 sleeper-berth). Mirrors `timing.ts`.
- `events/schemas.ts`: 7 new per-event payload schemas via the existing `eventSchema(...)` helper (`.strict()`, `schemaVersion` literal); shared `phaseEventPayload` for the 3 phase events; wire all 7 into `domainEventSchema` discriminated union.
- `events/domain-event.ts`: import the new schemas, add 7 `z.infer` type aliases, add 7 arms to the `DomainEvent` union.
- `events/contract.assert.ts`: add the 7 cases to the compile-time exhaustive switch.
- `events/index.ts` + package `index.ts`: re-export the new types + schemas + `HosConfig`/`DEFAULT_HOS_CONFIG`/`hosConfigSchema`/driver entity schemas.

### Task 3 — Keep the closed union compiling project-wide (no behavior)
Adding events to the CLOSED union breaks every exhaustive `assertNeverEvent` switch until each gets a case. Add minimal no-op cases (no Phase-10+ behavior):
- 8 projection reducers (`package-location`, `trailer-state`, `exceptions`, `hub-inventory`, `zone-estimate`, `tag-registry`, `geo-track`, `audit-timeline`) — new events no-op (return current state / empty keyframes / `null` row).
- Optimizer `rolling/scope.ts` `hubsOf` exhaustive switch — new events are scope-neutral (`return []`) in this phase.
- ESLint `no-fallthrough`: keep new empty `case` labels contiguous with the existing no-op group (no inter-case comments); document the no-op in each group's leading comment.

### Task 4 — Gate + artifacts
- Run the full gate: `pnpm build` (turbo), `pnpm typecheck`, `pnpm lint`, `pnpm test:all`.
- Confirm the seeded golden-replay determinism test is byte-identical (no new event emitted → stream unchanged).
- Write `09-PLAN.md`, `09-SUMMARY.md`, `09-VERIFICATION.md`.

## Determinism keystone

This phase adds NO behavior and emits NO new event, so the pre-v1.2 seeded golden stream is trivially unchanged. Every new event payload carries only `occurredAt` (virtual clock) + identifiers — no RNG values. The fifth `hosRng` substream + the HOS-on golden land in Phase 11.

## Out of scope (later phases)

HOS forward-labeling engine (10) · sim emission/accrual + 5th RNG substream + golden (11) · driver relay runtime (12) · driver-status projection + tables (13) · hub-detail endpoint (14) · optimizer awareness/enforcement (15–16) · UI (17).
