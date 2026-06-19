# Plan 01-03 Summary — Event Store (append-only + optimistic concurrency)

**Requirements:** FND-01 (append-only JSONB events), FND-02 (optimistic concurrency + total ordering)
**Status:** COMPLETE — all gates green (install, build, lint, test:all incl. real Postgres on OrbStack).

## What was built

`@mm/event-store` now exposes the full plan contract while keeping the Plan-01
walking-skeleton spine green:

- **`src/schema.sql`** (canonical artifact) + byte-identical embedded `SCHEMA_SQL`:
  - `streams(stream_id pk, stream_type, version int default 0)` — the per-stream
    CAS guard.
  - `events(global_seq BIGINT GENERATED ALWAYS AS IDENTITY pk, stream_id FK,
    version int, event_type, data jsonb, metadata jsonb, occurred_at,
    recorded_at default now(), UNIQUE(stream_id, version))` — append-only log.
  - `projection_checkpoints(projection pk, last_seq bigint default 0)`.
  - indexes `(stream_id, version)` and `(event_type, global_seq)`.
  - inline `hubs` read-model (spine).
  - A unit test (`schema-sql.test.ts`) asserts `SCHEMA_SQL` === `schema.sql` so
    the reviewable artifact and the runtime string can never drift.
- **`src/migrate.ts`** — idempotent `migrate(db)` applying the schema.
- **`src/store.ts`**:
  - `appendToStream(db, streamId, expectedVersion, events[], occurredAt) ->
    { newVersion }` — ONE transaction, validates each event via the domain
    `validateEvent` boundary (defense in depth), then a structurally-tight
    **compare-and-set** (`UPDATE streams SET version = version + N WHERE
    stream_id = $1 AND version = expectedVersion`; 0 rows -> `ConcurrencyError`
    BEFORE any insert), with `UNIQUE(stream_id, version)` (Postgres `23505`) as
    the backstop. Conflicts roll back fully — zero partial inserts.
  - `appendWithRetry(db, streamId, build, occurredAt, { maxRetries, expectedVersion })`
    — reloads the current version, rebuilds, retries on `ConcurrencyError`.
  - `readStream(streamId)` ordered by `version`; `readAll(fromGlobalSeq: bigint)`
    ordered strictly by `global_seq` (never by timestamp). Both return typed
    `StoredEvent[]` (JSONB rehydrated + re-validated to `DomainEvent`).
  - Legacy `append` (inline hub projection) + `getHubs` retained on the same CAS
    guard so the spine (`@mm/api` seed + `GET /hubs`) is unchanged.
- **`src/errors.ts`** — `ConcurrencyError` (typed, retryable; `actualVersion`
  optional).

## TDD evidence

RED-first integration tests, then GREEN implementation against real Postgres
(Testcontainers / OrbStack `postgres:17`):

- `test/append-read.int.test.ts` (FND-01): 3-event round-trip in version order;
  contiguous re-append; `readAll` ordered by `global_seq` with deliberately
  out-of-order `occurred_at` (proves ordering is NOT by timestamp);
  `readAll(fromGlobalSeq)` strictly-after semantics; append-only (no
  update/delete on the public surface).
- `test/concurrency.int.test.ts` (FND-02): two concurrent same-`expectedVersion`
  appends -> exactly one wins, the other throws `ConcurrencyError`, no
  gaps/dupes; raw `23505` surfaced as the typed error (no leaked `code`); full
  rollback on conflict; `appendWithRetry` lets the loser reload + retry to a
  contiguous stream containing both writers' events; retry exhaustion still
  throws `ConcurrencyError`.

## Invariants verified

- No `Date.now(` in `store.ts` (`occurred_at` comes from the event/caller;
  `recorded_at` is the only DB-clock field).
- No `any` in `packages/event-store/src`.
- `schema.sql` contains `UNIQUE (stream_id, version)`.

## Gates

| Gate | Result |
|------|--------|
| `pnpm install` | OK |
| `pnpm -r build` | OK |
| `pnpm lint` | OK |
| `pnpm test:all` | OK — 55 tests / 8 files (incl. 14 Postgres integration) |

## Integration

Merged rival #1 (`wt/p1-03-r1` @ `d274cbba3369a63a55c579c4ad99c04c446bc1da`) into
`feature/phase-1-operational-data-foundation-live-map-spike` via `--no-ff` (no
conflicts; winner was a direct descendant of the phase tip). All gates re-verified
green from the main repo against real Postgres (Testcontainers on the active
OrbStack docker context): `pnpm install && pnpm -r build && pnpm lint &&
pnpm test:all` → build (6 pkgs) OK, lint 0 errors, **55/55 tests passed (8 files)**.

## Carried risks (integrator notes for Plan 04+)

1. **Two append paths coexist.** R1 keeps both the forward API
   (`appendToStream` / `appendWithRetry`) and the legacy `append` (which also
   writes the inline `hubs` projection in-transaction) so the Plan-01 spine
   (`seed.ts` / `app.ts`) stays green. **Plan 04 projections MUST consume
   `appendToStream`, not the legacy `append`, to avoid double-projecting.**
2. **events → streams FK ordering.** `schema.sql` carries an `events.stream_id`
   FK to `streams`; appends must create/claim the `streams` row first (R1's CAS
   does this via insert-on-conflict-do-nothing for `expectedVersion === 0`). Any
   future direct event-insert path must respect this ordering or hit a FK
   violation.
3. **`appendWithRetry` default `maxRetries = 3`** (with an `expectedVersion`
   mapping option, identity by default). Trivially raised; confirm 3 is enough
   headroom once the Phase-4 optimizer becomes a concurrent writer.
4. **`projection_checkpoints`** table is created but unused until Plan 04
   (intentional scaffolding).
5. **`SCHEMA_SQL` is embedded in `schema.ts`** (no `.sql` asset copy at runtime),
   guarded by a byte-identity unit test. Editors must update `schema.sql` and
   re-run `schema-sql.test.ts` — do not edit only one side.
6. **Read-back re-validation.** `readStream` / `readAll` re-validate every row via
   `@mm/domain` `validateEvent` on read-back: correct and type-safe, but a slight
   per-read cost at large replay volumes. Fine for demo scale; revisit if replay
   throughput matters.
