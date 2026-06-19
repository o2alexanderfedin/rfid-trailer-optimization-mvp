# Plan 01-04 Summary — Projections + Golden Replay (FND-04/05/06/07)

## What shipped

`@mm/projections` now exports the operational twin: pure reducers, an inline
idempotent applier, and a truncate+replay rebuild driver — gated by the
keystone golden-replay test against real Postgres (OrbStack).

### Pure reducers (Task 1, FND-05/06/07)
- `src/reducers/package-location.ts` — `packageLocationReducer`: package
  last-seen `{ packageId, hubId, confidence, lastSeenAt }`. `confidence` is the
  fixed direct-scan value `1` (RFID probabilistic confidence is Phase 3; the
  field exists now for FND-05). All time from `event.occurredAt`.
- `src/reducers/trailer-state.ts` — `trailerStateReducer`: trailer
  `{ status (in_transit|arrived|docked), currentHubId, tripId, dockDoorId,
  assignedPackageIds (sorted), lastEventAt }` (FND-06).
- `src/reducers/hub-inventory.ts` — `hubInventoryReducer`: per-hub
  `{ inbound, outbound, staged }` id sets (FND-07), with an internal placement
  index so a package occupies at most one (hub, bucket) and moves are
  deterministic removals (no double-count). `load` scans remove a package from
  hub inventory (loaded onto a departing trailer).
- `src/reducers/reducer.ts` — shared `OccurredEvent`/`Reducer<S>` contract +
  `assertNeverEvent` exhaustive guard (extracted, DRY).
- Purity (P3): no wall-clock read, no RNG, no unstable/locale sort. Stable
  code-unit comparator on ids; `Map` order never load-bearing.

### Inline applier + rebuild driver (Task 2, FND-04)
- `src/runner/inline.ts` — `applyInline(db, replayEvent)`: per-projection
  `projection_checkpoints.last_seq` fold; events at/below `last_seq` are SKIPPED
  (idempotent, P5a). `readOperationalTwin` reads the assembled twin.
  `projectionView` narrows a wider (event-store) schema to the projection
  sub-schema (Kysely `Kysely<T>` is invariant).
- `src/runner/rebuild.ts` — `rebuildProjections(db, readAll)`: TRUNCATE
  projection tables, reset operational checkpoints to 0, replay `readAll(db, 0n)`
  strictly by `global_seq` through the SAME `applyInline` path (so live and
  rebuild cannot drift). `serializeTwin` gives a canonical sorted-key string for
  byte-identical comparison. The log reader is INJECTED (dependency inversion) so
  the package never imports `@mm/event-store` — the dep graph stays acyclic.
- `src/schema.sql` + `src/schema.ts` — `package_location`, `trailer_state`,
  `hub_inventory` (idempotent DDL); `PROJECTIONS_SCHEMA_SQL` kept byte-identical
  to the `.sql` (drift-guard test, mirroring event-store convention).

## Tests (all green)
- `test/reducers.unit.test.ts` — 16 cases: documented projected state per
  reducer, purity (twice == deep-equal; replay list twice == identical),
  determinism guard (payload order does not change projected state), immutability.
- `test/schema-sql.test.ts` — DDL drift guard + table presence.
- `test/idempotency.int.test.ts` — re-applying a stored event is a no-op;
  lower/equal `global_seq` is skipped by the `last_seq` gate (real Postgres).
- `test/golden-replay.int.test.ts` — KEYSTONE: live twin == rebuilt-from-`0`
  twin, byte-identical serialization + deep-equal; second rebuild == first.

## Requirements covered
- FND-04 golden replay (keystone) — byte-identical live vs rebuilt.
- FND-05 package last location + confidence + timestamp.
- FND-06 trailer current state / assignment / contents.
- FND-07 hub inventory inbound / outbound / staged.

## Gates
`pnpm install` OK · `pnpm -r build` OK · `pnpm lint` OK · `pnpm test:all` OK
(77/77 across 12 files incl. real Postgres integration). Purity grep guard
`grep -v '^\s*//' packages/projections/src/reducers/*.ts | grep -cE 'Date\.now\(|Math\.random\('`
returns 0. No regressions to the Phase-1 spine or prior plans.
