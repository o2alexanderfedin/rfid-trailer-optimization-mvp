---
phase: 02-load-planning
plan: 01
type: summary
requirements: [AGG-01, AGG-02, LOAD-01]
status: shipped
merge_commit: dd0b698341a37bceb931c0d5088c807bd543d312
source_sha: 0d4b69ef8b336a00219de7f1a62f33b6d1686af4
source_branch: wt/p2-01-r2
selected_rival: 2
---

# 02-01 Summary — Phase-2 Domain Contracts

## What shipped

Plan 02-01 ("Domain contracts") fleshes out the `@mm/domain` leaf package with the
Phase-2 planning vocabulary that the two pure packages (`@mm/aggregation`,
`@mm/load-planner`) and downstream scoring build against. Integrated via a `--no-ff`
merge of the winning rival (#2) into `feature/phase-2-load-planning`.

Merge commit: `dd0b698341a37bceb931c0d5088c807bd543d312`
Selected implementation: rival #2, source sha `0d4b69ef8b336a00219de7f1a62f33b6d1686af4`.

### Files added / changed
- `packages/domain/src/planning/index.ts` (new) — Phase-2 planning value types as pure
  zod schemas + inferred types:
  - `slaClassSchema` / `SlaClass` (closed enum `express|priority|standard|economy`)
  - `SLA_CLASS_WEIGHT: Record<SlaClass, number>` — single source of SLA weighting,
    `{ express: 4, priority: 3, standard: 2, economy: 1 }`
  - `handlingClassSchema` / `HandlingClass` (`standard|fragile|heavy`)
  - `sizeWeightClassSchema` / `SizeWeightClass`
  - `deadlineBucketSchema` / `DeadlineBucket` (non-negative integer bucket)
  - `planningPackageSchema` / `PlanningPackage` (numeric `deadline` ms-since-fixed-epoch,
    sla/handling/size class, `volume>0`, `weight>0`, hub ids, `packageId`)
  - `routeStopSchema` / `RouteStop` (`{ hubId, stopIndex }`, stop 0 = earliest unload)
  - `plannerConfigSchema` / `PlannerConfig` + `DEFAULT_PLANNER_CONFIG` (spec-derived
    defaults: `maxAllowedBlockers: 2`, `targetUtil: 0.80`, `utilLow: 0.75`,
    `utilHigh: 0.90`, cost/penalty knobs)
- `packages/domain/src/entities/index.ts` — replaced the `LoadBlock`/`TrailerSlice`
  stubs with full Phase-2 shapes and added `blockKeySchema`/`BlockKey`:
  - `blockKeySchema` (AGG-01) — 7-part key: currentHubId, nextUnloadHubId,
    finalDestHubId, slaClass, deadlineBucket, handlingClass, sizeWeightClass
  - `loadBlockSchema` (AGG-02) — key + packageIds(min 1) + totalVolume>0 +
    totalWeight>0 + refined `packageCount === packageIds.length` + numeric priority
  - `trailerSliceSchema` (LOAD-01) — depth int>=0 (0 = rear/easiest access),
    capacity/used volume + weight, loadBlockIds; refined `used <= capacity`
- `packages/domain/src/index.ts` — barrel now re-exports the planning types/schemas/
  constants; all existing entity + event exports preserved.
- Tests added: `packages/domain/test/planning.unit.test.ts`,
  `packages/domain/test/entities-phase2.unit.test.ts`; `events.unit.test.ts` touched
  (closed `DomainEvent` union + contract assertion unchanged and green).

## Requirements satisfied
- **AGG-01** — 7-part `BlockKey` schema as the aggregation grouping key.
- **AGG-02** — `LoadBlock` with aggregate volume/weight/count + priority, count refined
  against `packageIds`.
- **LOAD-01** — `TrailerSlice` modelling LIFO depth (0 = rear), capacity vs used
  volume/weight, placed block ids.

All new types are zod-schema-derived, deterministic, and IO-free (no `Date.now()` /
`Math.random()` in `planning`/`entities` source — verified).

## Gate results (post-merge, all green)
- `pnpm install` — clean (lockfile up to date)
- `pnpm -r build` — all 6 packages built (domain, api, event-store, projections, web,
  simulation)
- `pnpm lint` — eslint clean, no errors
- `pnpm test:all` — 23 test files, 168 tests passed (full vitest suite incl. integration)

No merge-only breakage; no fix commits were required.

## Cleanup
- Rival worktrees removed: `.mm-worktrees/p2-01-r1`, `.mm-worktrees/p2-01-r2`
- `git worktree prune` run
- Rival branches deleted: `wt/p2-01-r1`, `wt/p2-01-r2`

## Carried risks / notes (from judge)
- **Close call vs R1.** Both rivals passed every weighted gate and would pass review.
  The margin was convention-fidelity and marginally tighter validation, not correctness.
  R1 was a fully valid alternative (looser deadline typing — "plain number, ms since
  fixed epoch" — is a defensible reading of the plan, not a bug; co-located `src/` tests
  are a reasonable preference). A reviewer could reasonably have picked R1.
- **SLA weight magnitudes are tunable, not spec-pinned.** R2 ships `{4,3,2,1}`
  (all-positive; avoids a zero economy weight, marginally safer if ever used
  multiplicatively downstream); R1 used `{3,2,1,0}`. Both preserve the required
  `express > priority > standard > economy` ordering. Downstream scoring plans (AGG-04,
  LOAD) MUST import `SLA_CLASS_WEIGHT` and must NOT hard-depend on the exact magnitudes.
- **`DEFAULT_PLANNER_CONFIG` weights are tunable.** Non-spec-pinned config knobs differ
  between rivals; downstream plans must treat them as tunable defaults, not constants.
- **Summary artifact.** Neither rival generated `02-01-SUMMARY.md` during execution (a
  subagent instruction overrode the plan's `<output>` note). This file was authored by
  the integration step to close that gap.
