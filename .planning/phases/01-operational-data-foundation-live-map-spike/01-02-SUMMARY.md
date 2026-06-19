# Plan 01-02 Summary — Domain contract (FND-01, FND-03)

## What shipped
`@mm/domain` now defines the full Phase-1 operational vocabulary, replacing the
skeleton's single-event module behind the package entry point without breaking
any existing import.

### Files
- `packages/domain/src/entities/index.ts` — entity types as zod schemas:
  `Hub`, `Package`, `Trailer`, `DockDoor`, `Route`, `Trip`, plus Phase-2 stubs
  `LoadBlock`, `TrailerSlice`; shared `LonLat` / `SizeClass`.
- `packages/domain/src/events/schemas.ts` — one `z.object` (`.strict()`) per
  event + `z.discriminatedUnion("type", [...])`; each event pins
  `schemaVersion: z.literal(1)` (P11).
- `packages/domain/src/events/domain-event.ts` — the closed, versioned
  `DomainEvent` union (8 Phase-1 events), each member inferred from its zod
  schema; `EventEnvelope<TType, TPayload>` generic; `assertNever` helper.
- `packages/domain/src/events/contract.assert.ts` — **build-gated** compile-time
  fixture proving (1) union exhaustiveness and (2) zod/union type-equality.
  Lives in `src/` so `tsc -b` (the build gate) fails on drift.
- `packages/domain/src/ingestion/validate.ts` — `validateEvent(unknown):
  DomainEvent` + `ValidationError` (field-pathed messages).
- `packages/domain/src/index.ts` — barrel: entities, union, schemas,
  `validateEvent`/`ValidationError`, and `parseDomainEvent` (back-compat alias).
- `packages/domain/test/events.unit.test.ts`, `.../ingestion.unit.test.ts` —
  32 unit tests (TDD: written RED first).
- Removed orphaned skeleton files: `src/events.ts`, `src/hub.ts`,
  `src/events.test.ts` (subsumed by the new structure).

## Key contract decision (regression safety)
The walking skeleton established the event envelope as
`{ type, schemaVersion, payload }` with `parseDomainEvent`, and five packages
already depend on it. The plan's `<interfaces>` sketch proposed
`{ eventType, data, occurredAt }` / `validateEvent`. The overriding mandate —
"replace behind the entry point **without breaking existing imports**
(HubRegistered must remain valid)" — wins. So the skeleton envelope shape is
kept authoritative; `validateEvent` is added as the named FND-03 boundary and
`parseDomainEvent` remains as its alias. `occurredAt` stays a persistence-
boundary concern (the event store records `occurred_at` from the caller's
domain clock), keeping `@mm/domain` a pure, deterministic, zero-dep leaf.

## Requirements
- **FND-01** (typing side): the closed `DomainEvent` union is the single source
  of truth other packages import; exhaustiveness + type-equality are
  build-gated.
- **FND-03**: `validateEvent` rejects malformed / wrong-typed / extra-field /
  unknown-type / unsupported-`schemaVersion` payloads with descriptive errors;
  valid payloads yield typed `DomainEvent`s.

## Gates (all green)
`pnpm install` · `pnpm -r build` (6 pkgs) · `pnpm lint` (no `any`) ·
`pnpm test:all` = 43 tests, 5 files, incl. the real Postgres integration test
(Testcontainers on OrbStack, 4 spine cases green — no regression).
