# Plan 01-02 Summary — Domain contract (FND-01, FND-03)

Integrated rival #1 (`wt/p1-02-r1`, source sha `75406b632c2e9ad93b3ae4d28393eb1587f91cad`)
into `feature/phase-1-operational-data-foundation-live-map-spike` via `--no-ff`
merge. Clean merge, no conflicts (phase branch HEAD was an ancestor of the
winner).

## What shipped
`@mm/domain` now defines the full Phase-1 operational vocabulary, replacing the
walking skeleton's single-event module behind the package entry point without
breaking any existing import (`HubRegistered` stays valid).

- `packages/domain/src/entities/index.ts` — entity types as zod schemas:
  `Hub`, `Package`, `Trailer`, `DockDoor`, `Route`, `Trip`, plus Phase-2 stubs
  `LoadBlock`, `TrailerSlice`; shared `LonLat` / `SizeClass`.
- `packages/domain/src/events/schemas.ts` — one `.strict()` `z.object` per event
  + `z.discriminatedUnion("type", [...])`; each event pins
  `schemaVersion: z.literal(1)` (P11). 8 Phase-1 events: `HubRegistered`,
  `RouteRegistered`, `PackageCreated`, `PackageScanned`, `PackageArrivedAtHub`,
  `TrailerDeparted`, `TrailerArrivedAtHub`, `TrailerDocked`.
- `packages/domain/src/events/domain-event.ts` — the closed, versioned
  `DomainEvent` union (each member inferred from its zod schema);
  `EventEnvelope<TType, TPayload>` generic; `assertNever` helper.
- `packages/domain/src/events/contract.assert.ts` — **build-gated** compile-time
  fixture proving (1) union exhaustiveness and (2) zod/union type-equality.
  Lives in `src/` so `tsc -b` (the build gate) fails on any drift.
- `packages/domain/src/ingestion/validate.ts` — `validateEvent(unknown):
  DomainEvent` + `ValidationError` (field-pathed messages).
- `packages/domain/src/index.ts` — barrel: entities, union, schemas,
  `validateEvent`/`ValidationError`, and `parseDomainEvent` (back-compat alias).
- `packages/domain/test/events.unit.test.ts`, `.../ingestion.unit.test.ts` —
  32 unit tests (TDD, RED-first).
- Removed orphaned skeleton files: `src/events.ts`, `src/hub.ts`,
  `src/events.test.ts` (subsumed by the new structure).

## Contract decision (regression safety)
The walking skeleton fixed the envelope as `{ type, schemaVersion, payload }`
with `parseDomainEvent`, and five packages already depend on it. The plan's
interfaces sketch proposed `{ eventType, data, occurredAt }` / `validateEvent`.
The overriding mandate — replace behind the entry point without breaking
existing imports — wins: the skeleton envelope shape stays authoritative,
`validateEvent` is added as the named FND-03 boundary, and `parseDomainEvent`
remains its alias. `occurredAt` stays a persistence-boundary concern, keeping
`@mm/domain` a pure, deterministic, zero-dep leaf.

## Requirements
- **FND-01** (typing side): the closed `DomainEvent` union is the single source
  of truth other packages import; exhaustiveness + type-equality are
  build-gated via `contract.assert.ts`.
- **FND-03**: `validateEvent` rejects malformed / wrong-typed / extra-field /
  unknown-type / unsupported-`schemaVersion` payloads with descriptive errors;
  valid payloads yield typed `DomainEvent`s.

## Gate results (all green, re-verified post-merge from main repo)
- `pnpm install` — lockfile up to date.
- `pnpm -r build` — 6 packages built (`tsc -b` + `vite build`). The build gate
  also enforces `contract.assert.ts`.
- `pnpm lint` — eslint clean, zero errors/warnings (no `any`).
- `pnpm test:all` — 43 tests / 5 files green, incl. the real Postgres
  integration test (Testcontainers on the OrbStack docker context): 4 spine
  cases (append → inline projection → GET /hubs, read-your-writes, optimistic
  concurrency, projection idempotency) all pass. No regression.

Pushed to `origin/feature/phase-1-operational-data-foundation-live-map-spike`.

## Carried risks (from judge; not merge-blocking)
1. **Enum casing is pinned by R1, not the plan.** `scanType` =
   `inbound | outbound | load | unload`; `sizeClass` = `small | medium | large`
   (lowercase). The losing rival used `INBOUND/OUTBOUND/SORT` and `S/M/L/XL`.
   Downstream Phase-1 consumers (simulation, projections) must align to R1's
   lowercase casing, or normalize at their boundary when they land.
2. **8-event set, no separate pre-dock `TrailerArrived`.** R1 keeps the plan's
   specified events (it has `TrailerArrivedAtHub` + `TrailerDocked`, not a
   distinct pre-dock arrival). If a later plan needs a 9th event, it must be
   added to BOTH the union and `schemas.ts`; `contract.assert.ts` is build-gated
   and will force both — a guided, safe extension.
3. **Wide public surface (minor YAGNI).** `index.ts` re-exports many internal
   entity/event zod schemas. Harmless; trim if API minimalism matters later.
4. **Pre-existing web build warning** — OpenLayers chunk >500 kB. Cosmetic,
   pre-dates this plan, untouched by either rival. Web bundle hash was identical
   across both worktrees (neither touched the spine build output).
