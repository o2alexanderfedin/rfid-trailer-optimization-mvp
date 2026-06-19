# Plan 02-02 Summary — `@mm/aggregation` (AGG-01..04)

**Status:** COMPLETE — all gates green. Rival #2 implementation.

## What landed

A new PURE, IO-free package `@mm/aggregation` (depends on `@mm/domain` ONLY) that turns
raw `PlanningPackage[]` into feasible, prioritized `LoadBlock[]`. Built strict TDD
(RED → GREEN → REFACTOR).

| Requirement | Where | Proof |
|-------------|-------|-------|
| AGG-01 group by 7-part key | `src/aggregate.ts` (`deriveKey` + grouping) | grouping tests per key axis + merge test |
| AGG-02 per-block volume/weight/count | `src/block.ts` (`buildLoadBlock`) | sum/count tests; `loadBlockSchema.parse` round-trips |
| AGG-03 split (volume OR fragile⊄heavy) | `src/split.ts` (`splitBlock`) | over-volume → ≤maxBlockVolume; fragile/heavy partition; idempotency; passthrough |
| AGG-04 lexicographic priority | `src/priority.ts` (`blockPriority`) | SLA-dominates-deadline property; earliest-deadline tiebreak |
| deadlineBucket (no wall clock) | `src/deadline-bucket.ts` | determinism, monotonicity, SLA-window width tests |

## Module surface (smallest-correct, KISS/YAGNI/DIP)

- `aggregate(packages, config) -> LoadBlock[]` — group → sum → prioritize → split → **stable sort by loadBlockId**. Output is all-feasible and canonically ordered (never input/Map-order dependent).
- `splitBlock(block, packages, config) -> LoadBlock[]` — see "API note" below.
- `blockPriority(block: PrioritizableBlock) -> number` — `SLA_CLASS_WEIGHT[sla] - deadlineFraction`, where `deadlineFraction = d/(d+SCALE) ∈ [0,1)`. Integer SLA weights spaced ≥1 ⇒ SLA strictly dominates deadline (the AGG-04 lexicographic guarantee).
- `deadlineBucket(deadlineMs, slaClass) -> DeadlineBucket` — `floor(deadlineMs / width(slaClass))`; tighter SLA ⇒ narrower window (express 1h … economy 24h). Deterministic, no wall clock.
- Shared `src/block.ts` (`buildLoadBlock`, `keyId`) — DRY aggregate-recompute helper used by both `aggregate` and `splitBlock`; aggregates are ALWAYS recomputed from members so a block can't carry an inconsistent total/count.

## Deliberate design decisions (flagged for review)

1. **`splitBlock` takes `(block, packages, config)` — 3 args, not the plan's 2.**
   `LoadBlock` (domain) carries only `packageIds`, not per-package `volume`/`handlingClass`.
   To recompute sub-block aggregates and apply the fragile⊄heavy rule, split must see the
   member `PlanningPackage[]`. This keeps the module pure (no back-reference to a registry)
   and is the minimal honest signature. `aggregate` already has the members in hand.
2. **`deadlineBucket` is RE-DERIVED in `aggregate`**, ignoring the package's own
   `deadlineBucket` field — single source of truth (a test pins this: a bogus input bucket
   of 999 is overridden).
3. **Handling split rule:** a block splits on handling ONLY when BOTH `fragile` and `heavy`
   are present; it then partitions strictly by handling class (fixed order standard→fragile→heavy).
   This guarantees no sub-block mixes fragile with heavy, is deterministic, stable, and
   idempotent (single-class blocks never re-split). `standard`-only or `fragile`-only blocks
   are left intact.

## Pitfall discipline

- **P3 determinism:** zero `Date.now()`/`Math.random()` call-sites (grep-clean; only JSDoc prose names them). Stable sorts keyed on string tuples; integer deadline buckets (no float sort keys). Same input ⇒ same output (verified via shuffled-input test + Node dist smoke test).
- **Anti-P1:** this package does not touch LIFO/depth; it consumes the canonical enums from `@mm/domain` only. No divergent invariant restated.
- **Anti-P2:** no feasibility/score folding here — `splitBlock` enforces feasibility structurally (volume cap + handling) before any score exists; priority is a separate AGG-04 ordering number, not a feasibility gate.

## Gates (run from worktree root)

- `pnpm install` — OK
- `pnpm -r build` — OK (full graph; `@mm/domain` `contract.assert.ts` build-gate intact, domain untouched)
- `pnpm lint` — OK (exit 0; no `any`)
- `pnpm test:all` — OK: **206 passed (27 files)**, incl. Testcontainers Postgres integration. Unit-only **169** (= 131 baseline + 38 new). No prior tests regressed.

## Files

- `packages/aggregation/package.json`, `tsconfig.json`
- `packages/aggregation/src/{index,aggregate,split,priority,deadline-bucket,block}.ts`
- `packages/aggregation/src/{aggregate,split,priority,deadline-bucket}.test.ts`
- `tsconfig.eslint.json` — added `@mm/aggregation` path mapping (lint resolves src)
