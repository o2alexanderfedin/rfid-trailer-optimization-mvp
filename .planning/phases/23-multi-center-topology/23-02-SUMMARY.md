---
phase: 23-multi-center-topology
plan: 02
subsystem: projections
tags: [perf, key-scoping, hub-inventory, projection-fold, determinism, jsonb-containment, tdd]

# Dependency graph
requires:
  - phase: v2.1 (sim-perf)
    provides: the key-scoped inline-applier surgery on package_location/trailer_state/driver_status/zone_estimate/exceptions/tag_registry; the xmin-probed projection-fold-bounded cost test pattern
  - phase: 23-01
    provides: the 92-hub big-city dataset that makes the latent O(events x hubs) fold an ACTIVE freeze at 100 hubs
provides:
  - "Key-scoped applyHubInventory: per-event row reads bounded by the event payload (touched hub id(s) + the rows holding touched package ids), independent of total hub count"
  - "affectedHubInventory(event): closed-union (default: never) key extractor classifying every event as placement-adding (named hub) / placement-removing (package ids) / no-op"
  - "Injectable HubsContainingPackages port (JSONB ?| containment, default impl) — the package->hub placement read without a full scan; the test injects an in-memory counting equivalent"
  - "packages/projections/test/hub-inventory-cost.unit.test.ts — per-event projection-cost witness (10-hub vs 100-hub row reads equal) + rebuild-equivalence (T-23-04), Postgres-free"
affects: [23-04 (per-center scope partition runs atop a non-freezing fold), 27 (twin-snapshot cursor fold — the remaining full-scan debt), multi-center-topology]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Closed-union key extractor with `default: never` exhaustiveness for the applier's scoped read (mirrors affectedPackageLocationId / affectedDriverIds)"
    - "JSONB `?|` (array-contains-any) for a reverse-index read (package id -> holding hub row) without a full-table scan"
    - "Injectable read port (HubsContainingPackages) so a Postgres-free unit test can count row reads while production uses real `sql` containment — keeps @mm/projections's acyclic DAG (no pg/event-store dev dep)"

key-files:
  created:
    - packages/projections/test/hub-inventory-cost.unit.test.ts
  modified:
    - packages/projections/src/runner/inline.ts

key-decisions:
  - "Resolve placement-removing events (package ids -> holding hub) via Postgres `jsonb ?| text[]` containment (rows whose inbound/outbound/staged hold ANY touched package), not a full scan; verified against the running Postgres before implementing"
  - "Emptied hubs are UPSERTED as empty rows, never DELETEd — to stay byte-identical to the prior full-table fold (the golden-replay test asserts `DFW.outbound === []`, i.e. the row PERSISTS empty after departure). A DELETE would diverge from rebuild-from-0 and break FND-04"
  - "applyHubInventory exported + a third injectable `hubsContainingPackages` param added (default = production `?|` query) so the cost test counts reads against an in-memory db with zero Postgres dependency (DAG stays acyclic)"
  - "readOperationalTwin's `hub_inventory` full read (line ~921) is INTENTIONALLY left as-is: it is the read-side twin-snapshot assembler (one bounded read to build an API response), NOT the per-event applier fold that caused the freeze — out of scope for PERF-01"

patterns-established:
  - "Per-event projection-cost test: a counting fake Kysely modeling exactly the applier's hub_inventory builder chains + an injected placement read, asserting rows-read at 10 hubs === rows-read at 100 hubs (the direct hub-count-independence witness)"

requirements-completed: [PERF-01]

# Metrics
duration: 10min
completed: 2026-06-26
---

# Phase 23 Plan 02: Key-Scope applyHubInventory (PERF-01) Summary

**`applyHubInventory` no longer loads the entire `hub_inventory` table per event: it reads only the hub id(s) the event names (placement-adding) or the rows currently holding the event's package ids via a JSONB `?|` containment query (placement-removing), folds with the SAME pure `hubInventoryReducer`, and persists only that scoped delta — so per-event row reads are independent of hub count (proven equal at 10 vs 100 hubs), defusing the v2.1 O(events x hubs) freeze before the continental hub jump can re-arm it, while staying byte-identical to the prior full-table fold (golden-replay + idempotency green).**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-26T18:14Z
- **Completed:** 2026-06-26T18:24Z
- **Tasks:** 2 (a single TDD cycle: RED cost test -> GREEN key-scoping)

## What Was Built

### Task 1 (RED) — per-event projection-cost test
`packages/projections/test/hub-inventory-cost.unit.test.ts` instruments a counting,
in-memory fake `Kysely<ProjectionDb>` that models exactly the `hub_inventory` builder
chains the applier uses (`selectAll().execute()`, `selectAll().where("hub_id","in",..)`,
`insertInto(...).onConflict(...)`) plus an injected placement read, and counts every
`hub_inventory` row the applier reads per event. It seeds a 10-hub and a 100-hub
inventory (each holding the same package P at one known hub) and asserts:

- `PackageArrivedAtHub`: rows-read at 10 hubs **===** rows-read at 100 hubs.
- `TrailerDeparted` removing P: rows-read at 10 hubs **===** rows-read at 100 hubs.
- Rebuild-equivalence (T-23-04): the key-scoped fold's non-empty hub contents **===** the
  pure full-table fold's, at both 10 and 100 hubs.

Against the un-fixed full-scan applier the two cost tests FAILED `10 !== 100` (proving the
test measures the right thing); the rebuild-equivalence test PASSED (the prior fold was
already correct). No Postgres — `@mm/projections` depends only on `@mm/domain` + `kysely`
(its acyclic-DAG contract).

### Task 2 (GREEN) — key-scope the applier
`applyHubInventory` rewritten in `packages/projections/src/runner/inline.ts`:

- `affectedHubInventory(event)` — a closed-union extractor (`default: never`) returning
  `{ hubIds, packageIds }`: the named hub for `PackageArrivedAtHub`/`PackageInducted`/
  `PackageScanned`; the package ids for `TrailerDeparted`/`PlanSuperseded`/`PackageDelivered`;
  empty for every other event (each classified explicitly so a future event must be triaged).
- Early return on a no-op event (zero reads, zero writes).
- Scoped read: `WHERE hub_id IN (touched hub ids)` UNION the rows holding any touched package
  id, the latter via `defaultHubsContainingPackages` — a `jsonb ?| text[]` containment query
  (`inbound ?| ids OR outbound ?| ids OR staged ?| ids`) bounded by how many hubs actually hold
  the packages (<= packageIds.length), never by total hub count.
- Partial-state fold with the SAME `hubInventoryReducer` (touches no other key), then persist
  ONLY the scoped hubs' delta: upsert each scoped hub present in the fold (INCLUDING emptied
  hubs, as empty rows — preserving the prior full-table behavior the golden-replay test
  depends on); a scoped named hub the fold never materialized gets no row (old-applier parity).

## Verification

| Gate | Result |
|------|--------|
| `hub-inventory-cost.unit.test.ts` (cost + rebuild-equivalence) | 3/3 GREEN |
| `@mm/projections` unit suite | 122/122 green |
| `projections-golden-replay.int.test.ts` (real PG, FND-04: live==rebuild byte-identical) | 2/2 green |
| `projections-idempotency.int.test.ts` (real PG) | 2/2 green |
| `projection-fold-bounded.int.test.ts` (v2.1 xmin cost regression guard) | 2/2 green |
| `hub-detail.int.test.ts` (reads hub_inventory) | 8/8 green |
| `drives-projections.int.test.ts` (sim-driven full projection path) | 1/1 green |
| `pnpm typecheck` (root gate) | clean |
| `eslint` (changed files) | clean (no `any`, no assertions) |
| `grep -v '^//' inline.ts | grep -c 'selectFrom("hub_inventory").selectAll()'` | 1 — the read-side `readOperationalTwin`, NOT the applier (see Deviations) |

The two real-Postgres determinism gates (golden-replay + idempotency) are the decisive
proof that the key-scoped fold is byte-identical to a rebuild-from-0 with the real `?|`
containment query — T-23-04 (scoped fold diverging from the full-table fold) is mitigated by
direct witness, and T-23-05 (the residual O(events x hubs) freeze at 100 hubs) by the
hub-count-independence cost test.

## Deviations from Plan

### Auto-fixed / clarified during execution

**1. [Rule 2 - Correctness] Emptied hubs are upserted as EMPTY ROWS, not DELETEd**
- **Found during:** Task 2 (designing the delta-persist step).
- **Issue:** The plan's Task-2 sketch said "DELETE hubs that became empty," mirroring
  `applyPackageLocation`'s absent-key delete. But the prior `applyHubInventory` (and therefore
  the rebuild-from-0 path) KEEPS empty hub rows: the reducer's `placePackage` leaves an empty
  `HubInventory` in the map, which the old applier upserted. The existing
  `projections-golden-replay.int.test.ts` encodes this exactly: it asserts
  `liveTwin.hubInventory.get("...DFW")?.outbound === []` AFTER the hub is emptied by a departure
  — i.e. the row must PERSIST empty. A DELETE would make `get(...)` return `undefined`, failing
  that assertion and breaking FND-04 (live != rebuild).
- **Fix:** The key-scoped applier upserts every scoped hub present in `next.hubs` (empty or not)
  and never deletes — byte-identical to the prior fold. The cost test compares non-empty hub
  contents so the empty-row representation does not muddy the equivalence assertion.
- **Files modified:** `packages/projections/src/runner/inline.ts`.
- **Commit:** 9d8d613.

**2. [Rule 3 - Enablement] `applyHubInventory` exported + an injectable placement-read port added**
- **Found during:** Task 1 (the cost test must call the applier directly and count its reads).
- **Issue:** `applyHubInventory` was module-private, and the package→hub placement read (a raw
  `sql` `?|` query) cannot be evaluated by a Postgres-free in-memory fake.
- **Fix:** Exported `applyHubInventory` (documented as test-only, not part of the public twin API)
  and added a third parameter `hubsContainingPackages: HubsContainingPackages` defaulting to the
  production `?|` query. `applyInline` calls it with the default (unchanged behavior); the cost
  test injects an in-memory equivalent that counts the same rows. This keeps `@mm/projections`
  free of any `pg`/`@mm/event-store` dev dependency (its acyclic-DAG contract, index.ts L9).
- **Files modified:** `packages/projections/src/runner/inline.ts`.
- **Commit:** cccd91f (export) / 9d8d613 (port).

### Scope clarification (NOT a deviation)

`readOperationalTwin` (inline.ts ~L921) still does `selectFrom("hub_inventory").selectAll()`.
This is the **read-side twin-snapshot assembler** — one bounded read to build an API response
object, reading every projection table once. It is NOT the per-event applier fold that caused
the v2.1 freeze (the thing PERF-01 targets) and pre-dates this plan. The `twin-snapshot`
incremental-cursor follow-up (the other carried full-scan debt, Pitfall 9) is explicitly
deferred to Phase 27 per 23-CONTEXT.md.

## Known Stubs

None. No placeholder data, hardcoded empties flowing to UI, or unwired data sources were
introduced. (The empty `hub_inventory` rows are not stubs — they are the correct persisted
representation of an emptied hub, identical to the prior fold.)

## Threat Flags

None. No new network endpoint, auth path, file-access pattern, or trust-boundary schema change
was introduced. The only surface touched is the internal event-stream → `hub_inventory`
projection fold already covered by the plan's `<threat_model>` (T-23-04 / T-23-05, both
mitigated above).

## TDD Gate Compliance

- RED gate: `test(23-02): ...` commit `cccd91f` (failing cost test present, 10 != 100 on the
  un-fixed applier).
- GREEN gate: `feat(23-02): ...` commit `9d8d613` (cost test passes; all projection + determinism
  gates green) AFTER the RED commit.
- REFACTOR gate: none needed (the implementation mirrors the existing key-scoped appliers; no
  cleanup pass produced changes).

## Self-Check: PASSED

- FOUND: packages/projections/test/hub-inventory-cost.unit.test.ts
- FOUND: packages/projections/src/runner/inline.ts (modified)
- FOUND: .planning/phases/23-multi-center-topology/23-02-SUMMARY.md
- FOUND commit cccd91f (RED test)
- FOUND commit 9d8d613 (GREEN feat)
