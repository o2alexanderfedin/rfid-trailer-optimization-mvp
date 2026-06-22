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

## Integration (merged into feature/phase-1-operational-data-foundation-live-map-spike)

Winner: rival #1, branch `wt/p1-04-r1`, source sha
`21a06f36544b679f371414c19ac554e2c42a8267`. Merged via `git merge --no-ff`
(no conflicts — the winner was a linear addition of `packages/projections` plus
this summary on top of plan-03 HEAD).

Gates re-verified post-merge in the MAIN repo against real Postgres via
Testcontainers on OrbStack (docker context `orbstack`, server 29.4.0):

| Gate              | Result |
|-------------------|--------|
| `pnpm install`    | OK (lockfile up to date) |
| `pnpm -r build`   | OK (6 buildable packages incl. `@mm/projections`) |
| `pnpm lint`       | OK (eslint clean) |
| `pnpm test:all`   | OK — 12 files / **77 tests** passed |

## Carried risks (from cross-rival judging — revisit before later phases)

1. **FND-07 semantics not pinned.** The plan/research do not mandate
   removal-on-move for hub inventory. The winner (R1) treats a move as a
   deterministic removal from the prior (hub, bucket); the rival R2 used an
   additive model. Both passed their own self-written tests, so the chosen
   semantics are a Phase-1 spike decision, not a settled contract — confirm the
   intended FND-07 behavior with stakeholders before downstream consumers depend
   on it.
2. **O(N) whole-table reload + one production cast.** R1's inline runner reloads
   the whole twin per event (O(N) re-read), and carries one production-code cast
   (`projectionView` narrowing the invariant `Kysely<T>` event-store schema to
   the projection sub-schema). These are cleanliness/scalability debts — fine for
   the spike, worth revisiting (incremental reads, typed view) before later
   phases build volume on this twin. R2 avoided both (O(1) loads, zero casts).
3. **trip_id NOT NULL / orphan TrailerDocked.** R2's approach of forcing
   `trip_id NOT NULL` and writing `""` for an orphan `TrailerDocked` could
   surface as a subtle data-quality issue; not present in R1's chosen model and
   not exercised by current tests — noted for awareness.
4. **No regressions observed.** Both rivals were judged on `test:all` green
   (77 R1 vs 75 R2), which includes the full prior Phase-1 spine. No regressions
   in either; the merged R1 keeps the spine green at 77/77.
