# Plan 03-05 Summary — Tag + zone projections (inline) in `@mm/projections`

**Requirements:** SNS-02 (tag→package registry; RfidObserved.tagId resolves to a package)
**Type:** TDD · **Status:** complete · **Module:** extends `@mm/projections` (adds `@mm/sensor-fusion` workspace dep, downward/acyclic)

## What this plan delivers

Two new INLINE (read-your-writes, decision-critical) operational read models, the OBSERVED layer made queryable:

1. **tag-registry** (SNS-02) — a `tagId → packageId` map folded from `PackageCreated.rfidTagId`. An `RfidObserved.tagId` resolves to its package; an UNMAPPED tag resolves to `undefined` (T-03-13: not a package, never an exception).
2. **zone-estimate** (SNS-02 attribution + SNS-03 consumed) — the latest fused `ZoneEstimate` per `(packageId, trailerId)`. Folds `RfidObserved` reads (attributed via the registry) through the Plan-02 fusion engine (`windowObservations` + `fuseZone`). Persisted `confidence` is STRICTLY `< 1.0` and `<= confidenceCeiling` — anti-P5b INHERITED from the cap (0.85) + entropy floor (2%).

Both are idempotent (per-projection `last_seq` checkpoint, P5a), checkpointed, and survive truncate+replay byte-identically (FND-04).

## Exported surface (Plan 06 detector reads zone-estimate + tag-registry; Plan 07 exposes estimates via API)

### Reducers / states / types (`@mm/projections`)
- `tagRegistryReducer`, `emptyTagRegistryState`, `TagRegistryState = ReadonlyMap<tagId, packageId>`, `resolveTag(state, tagId): string | undefined`.
- `makeZoneEstimateReducer(deps): Reducer<ZoneEstimateState>` where `deps = { resolveTag, config: FusionConfig, dwellWindowMs?, readerTypes? }`. `ZoneEstimateState = ReadonlyMap<\`${packageId}|${trailerId}\`, ZoneEstimate>`; `emptyZoneEstimateState`; `zoneEstimateKey(packageId, trailerId)`; `DEFAULT_DWELL_WINDOW_MS = 3000`; `ResolveTag`, `ZoneEstimateDeps`.
- Both reducers are EXHAUSTIVE over the closed 11-member `DomainEvent` union (`assertNeverEvent` default) and no-op the non-target events (same state reference).
- Schema types: `TagRegistryTable`, `TagRegistryRow`, `ZoneEstimateTable`, `ZoneEstimateRow`, `OperationalProjectionName`.

### Design notes
- The zone-estimate reducer is INCREMENTAL: each `RfidObserved` windows its own read and fuses against the prior estimate's `posterior` (the carried-forward Bayesian belief; first read starts from `config.defaultPrior`). This matches the DB applier (which loads only the persisted row) and keeps the fold KISS — no raw-read retention. The per-read cap + entropy floor keep confidence `< 1.0` regardless of how many same-tag reads arrive.
- Purity (P3): time only from `occurredAt` (a deterministic dwell-window bucket = `floor(Date.parse(occurredAt) / dwellWindowMs)`); registry + config injected; no `Date.now`/`Math.random`/`any`.

## Persistence

### Tables (in BOTH `schema.sql` and the byte-identical embedded `PROJECTIONS_SCHEMA_SQL`; drift test guards)
- `tag_registry (tag_id TEXT PK, package_id TEXT NOT NULL)`.
- `zone_estimate (package_id, trailer_id, estimated_zone, confidence DOUBLE PRECISION, posterior JSONB, last_reliable_checkpoint TEXT NULL, last_observed_at TIMESTAMPTZ; PK (package_id, trailer_id))`.

### Wiring (`runner/inline.ts`)
- `OPERATIONAL_PROJECTIONS` extended with `"tag-registry"`, `"zone-estimate"` (each gets its own `last_seq` checkpoint).
- `APPLIERS` registers `applyTagRegistry` BEFORE `applyZoneEstimate`, so a `PackageCreated` registers the tag before the same-pass zone-estimate applier resolves a `RfidObserved` against the persisted registry slice (read-your-writes within one `applyInline`).
- `rebuildProjections` TRUNCATE extended to include `tag_registry, zone_estimate`; the checkpoint-reset loop covers them via `OPERATIONAL_PROJECTIONS`.

## Tests (all green)
- 14 new unit tests: `test/tag-registry.unit.test.ts` (7), `test/zone-estimate.unit.test.ts` (7) — round-trip resolution, unmapped⇒undefined, no-op exhaustiveness, purity, anti-P5b confidence `< 1.0` at N=200 same-dwell reads, per-trailer keying, freshness.
- 4 new integration tests (real Postgres / Testcontainers, hosted in `@mm/api`): `test/zone-projections.int.test.ts` — read-your-writes, P5a idempotent re-apply, unmapped-tag⇒no-estimate, truncate+replay byte-identical.
- Schema-drift test extended to assert the two new tables.

## Gates (run from worktree, ALL GREEN)
- `pnpm install` — clean (adds `@mm/sensor-fusion` link to `@mm/projections`).
- `pnpm build` (turbo) — 9/9, no workspace cycles (`@mm/projections` → `@mm/sensor-fusion` → `@mm/domain`, downward only).
- `pnpm -r build` — all packages Done.
- `pnpm lint` — clean (no `any`; no `Date.now`/`Math.random` in new src).
- `pnpm test:all` — 431/431 across 53 files (was 375 unit baseline; prior phases all still green).
