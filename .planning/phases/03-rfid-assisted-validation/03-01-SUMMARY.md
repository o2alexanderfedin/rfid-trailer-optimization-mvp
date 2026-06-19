# 03-01 Summary — Domain events (SNS-01, SNS-02)

The CLOSED, versioned `DomainEvent` union grew from 8 to **11** members. The build
gate (`packages/domain/src/events/contract.assert.ts`) enforces exhaustive
handling of all 11; `pnpm build` (turbo) is green with no workspace cycles.

## New event types (exported from `@mm/domain`)

| Type | Payload fields (schemaVersion 1) | Req |
|------|----------------------------------|-----|
| `RfidObserved` | `tagId, readerId, antennaId, rssi (finite), trailerId, hubId, confidence ∈ [0,1]` | SNS-01 |
| `WrongTrailerDetected` | `packageId, observedTrailerId, plannedTrailerId, confidence ∈ [0,1], severity, recommendedAction` | SNS-04 |
| `MissedUnloadDetected` | `packageId, trailerId, hubId, confidence ∈ [0,1], severity, recommendedAction` | SNS-05 |

All payloads are `.strict()`; envelope is `{ type, schemaVersion, payload }`
(no `occurredAt` in payload — that stays at the persistence boundary, per the
established Phase-1 convention). `occurredAt` is supplied by the store via the
caller's domain clock, never `Date.now()`.

## New zod schemas (exported from `@mm/domain`)

- `rfidObservedSchema`
- `wrongTrailerDetectedSchema`
- `missedUnloadDetectedSchema`
- `severitySchema` = `z.enum(["info", "warning", "critical"])` — shared by both
  detection events; the single ranking vocabulary for the exception feed.

`domainEventSchema` (the `z.discriminatedUnion`) now lists all 11 members and is
the runtime mirror of the hand-written union (proven by the `Exact<Inferred,
DomainEvent>` type-equality fixture in `contract.assert.ts`).

## SNS-02 tag→package mapping source

`rfidTagId: id.optional()` was added (additive) in two places:

- **`PackageCreated.payload.rfidTagId`** (event) — `packages/domain/src/events/schemas.ts`.
- **`Package.rfidTagId`** (entity) — `packages/domain/src/entities/index.ts`.

Optional + additive: Phase-1/2 streams that omit it stay valid. When present it
is the key the (later-plan) tag-registry projection maps `RfidObserved.tagId`
back through to a `packageId`.

## Type → schema linkage (single source of truth)

Each union member is `z.infer<typeof xSchema>` in
`packages/domain/src/events/domain-event.ts`:
`RfidObserved`, `WrongTrailerDetected`, `MissedUnloadDetected`.

## Downstream no-op handling (anti-P6, detection separated from fusion)

The five `@mm/projections` reducers (`audit-timeline`, `geo-track`,
`hub-inventory`, `package-location`, `trailer-state`) now list the 3 new events
in their ignored-event groups as explicit **no-ops** (`return state` / `null` /
empty writes). The build gate forced this — observed RFID/detection evidence is
intentionally NOT folded into the planned read models here; dedicated
zone-estimate / exception projections (later Phase-3 plans) own that. Absence of
an RFID read never changes a package's known location.

## Validation guarantees (T-03-01 ingestion boundary)

`validateEvent` rejects: `confidence` outside `[0,1]`, non-finite `rssi`
(NaN/±Inf), `severity` outside the enum, empty ids/actions, and any extra field
(strict). There is no `(x, y)` coordinate field on `RfidObserved`, so
"RFID ≠ coordinates" is structural (T-03-03).

## Gates (run from the worktree)

`pnpm install` ✓ · turbo `pnpm build` ✓ (8/8) · `pnpm -r build` ✓ · `pnpm lint`
✓ (0 errors) · `pnpm test:all` ✓ **344 passed** (323 prior + 21 new; real
Postgres via Testcontainers/orbstack).
