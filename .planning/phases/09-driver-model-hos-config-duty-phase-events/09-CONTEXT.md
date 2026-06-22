# Phase 9: Driver model + HOS config + duty/phase events - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — domain types + events only; grounding-enriched)

<domain>
## Phase Boundary

This phase introduces **only the domain primitives** for driver Hours-of-Service: the `Driver` entity, the `HosClock` value-object, the full-FMCSA `HosConfig`, and the new closed-union events (driver lifecycle + authoritative load/unload phase events) — all as zod schemas with the closed-union contract test green.

**In scope:** zod schemas + inferred types in `@mm/domain`; adding events to the closed discriminated union; `contract.assert.ts` exhaustiveness; per-event validation tests; extending `Trip` with optional `driverId` (back-compat).

**Explicitly OUT of scope (later phases):** the HOS forward-labeling engine (Phase 10), the sim emitting/accruing these events (Phase 11), driver relay (Phase 12), the driver-status projection (Phase 13), the hub-detail endpoint (Phase 14), optimizer awareness/enforcement (Phases 15–16), UI (Phase 17). This phase **defines** the types/events; later phases **use** them.
</domain>

<decisions>
## Implementation Decisions

### Driver entity & HosClock (DRV-01, DRV-02)
- `Driver` zod schema: `driverId`, optional `name`/`licenseClass`, `dutyStatus` ∈ {`driving`, `on_break`, `resting`, `off_duty`}. Inferred TS type is the single source of truth (DRY with event payloads).
- `HosClock` value-object (integer-minute fields): `driveTodayMin`, `dutyWindowStartAt` (ISO), `sinceLastBreakMin`, `weeklyOnDutyMin`, `comeOnDutyAt` (ISO), plus sleeper-berth split accumulators (for the 7/3 & 8/2 provisions consumed by the Phase-10 engine).
- Live beside the existing entities in `@mm/domain` `entities/index.ts`, following the existing zod-schema-then-`z.infer` pattern.

### HosConfig (HOS-01)
- Full-FMCSA constants, placed beside `TimingConfig` in `@mm/domain` `timing.ts` (or a sibling `hos.ts`): `maxDriveMin=660` (11h), `dutyWindowMin=840` (14h), `breakAfterDriveMin=480` (8h), `minBreakMin=30`, `resetOffDutyMin=600` (10h), `weeklyCapMin=4200` (70h/8-day), `restartMin=2040` (34h), and sleeper-berth split parameters (7/3 and 8/2). Provide a `DEFAULT_HOS_CONFIG` mirroring the `DEFAULT_TIMING_CONFIG` convention.

### Events (EVT-01, EVT-02)
- Add to the **closed** domain-event discriminated union with per-event zod schemas in `events/schemas.ts`, wired into `events/domain-event.ts`, with `contract.assert.ts` type-equality + the exhaustive reducer switch (`assertNeverEvent`) still compiling:
  - Driver lifecycle: `DriverRegistered`, `DriverAssignedToTrip`, `DriverDutyStateChanged` (carries `reason` + an HosClock snapshot), `DriverSwappedAtHub`.
  - Phase events: `UnloadStarted`, `LoadStarted`, `UnloadCompleted` (carry `trailerId`, `hubId`, `tripId`, `occurredAt` only).
- **Determinism rule:** event payloads carry only virtual-clock timestamps (`occurredAt`) and identifiers — **no RNG values**. Reducers (added in later phases) must key off `occurredAt`, never wall-clock.

### Trip back-compat (DRV-03)
- Extend `Trip` with an **optional** `driverId`. Existing fixtures/tests with no `driverId` must remain valid (no required-field break).

### Determinism note (keystone)
- This phase adds **no behavior** — only types + event definitions. No new event is emitted yet, so the pre-v1.2 seeded golden stream is trivially unchanged. The 5th RNG substream + golden work lands in Phase 11.

### Claude's Discretion
File placement (single `hos.ts` vs additions to existing files), exact zod refinements, and test granularity are at Claude's discretion — follow existing `@mm/domain` conventions. Use TDD (project mandate): write the contract/validation tests first.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets / Integration Points (from v1.2-DRIVER-HOS-GROUNDING.md)
- `@mm/domain/src/entities/index.ts` — existing zod entity schemas (Hub, Trailer, Package, Trip, Route, DockDoor, LoadBlock, TrailerSlice); `Trip` is currently `{tripId, trailerId, fromHubId, toHubId}`.
- `@mm/domain/src/events/schemas.ts` — per-event zod payload schemas.
- `@mm/domain/src/events/domain-event.ts` — the closed discriminated union (13 events today: HubRegistered, RouteRegistered, PackageCreated, PackageScanned, PackageArrivedAtHub, TrailerDeparted, TrailerArrivedAtHub, TrailerDocked, RfidObserved, WrongTrailerDetected, MissedUnloadDetected, PlanGenerated, PlanAccepted).
- `@mm/domain/src/events/contract.assert.ts` — compile-time type-equality test guarding the union; **must pass after additions**.
- `@mm/domain/src/timing.ts` — `TimingConfig` / `DEFAULT_TIMING_CONFIG` pattern to mirror for `HosConfig`.
- Every exhaustive reducer `switch` over the event union (`assertNeverEvent`) is a compile-time consumer — adding events touches them; in this phase only the domain contract + tests are required (reducers handled in later phases, but the union must still compile project-wide).

### Established Patterns
- zod-schema-first, `z.infer` for types, no `any`, strict TS (`noUncheckedIndexedAccess`).
- Closed event union with exhaustiveness assertions (TDD-guarded).
</code_context>

<specifics>
## Specific Ideas

Full grounding (FMCSA rule numbers, integration points per layer, determinism keystone, verification verdicts): `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md`. Requirement IDs for this phase: **DRV-01, DRV-02, DRV-03, HOS-01, EVT-01, EVT-02** (see `.planning/REQUIREMENTS.md`).
</specifics>

<deferred>
## Deferred Ideas

- HOS forward-labeling engine → Phase 10.
- Sim emission + HOS accrual + 5th RNG substream + golden → Phase 11.
- Driver relay/swap runtime → Phase 12.
- Driver-status projection + tables → Phase 13.
- Hub-detail endpoint, optimizer, UI → Phases 14–17.
</deferred>
