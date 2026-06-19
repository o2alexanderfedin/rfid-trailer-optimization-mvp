---
phase: 2
slug: load-planning
doc: review
confirmed_high: 0
confirmed_medium: 1
confirmed_low: 6
resolved_medium: 1
resolved_low: 5
remaining_low: 2
reviewed_at: 2026-06-19
resolved_at: 2026-06-19
resolution_commit: b268f8b
fix_source_commit: 17055cdbb683a4d898f2b3f410fc6afbe4e18b0c
---

# Phase 2 — Review (Confirmed Issues)

> Only **confirmed** findings (read-the-code + empirical reproduction). Severity reflects *reachability through the documented production flow*, not just mechanical possibility. Every file:line below was re-checked against the working tree.

**Counts (as found):** HIGH **0** · MEDIUM **1** · LOW **6**
**Status after rival-#1 integration (`b268f8b`, fixes from `17055cd`):** M1 **RESOLVED** · L1 **RESOLVED** · L2 **RESOLVED** · L3 **RESOLVED** · L6 **RESOLVED** · L7 **RESOLVED** · L4/L5 carried (safe debt).

There are **no confirmed HIGH issues** and **no data-corruption or security path** through the documented `POST /plan` → `aggregate`/`planLoad` flow. The single MEDIUM was a latent correctness bug in a *public helper* reachable only by an out-of-contract direct caller — now closed. The build-gate failure (L1) was a process/dependency gap blocking the `passed` verdict — now closed, with turbo `pnpm build` green.

## Resolution summary

The winning Phase-2 fix bundle (rival #1, source `17055cdbb683a4d898f2b3f410fc6afbe4e18b0c`) was merged into `feature/phase-2-load-planning` as `b268f8b`. Re-verified all gates green afterward: `pnpm install` (frozen lockfile consistent), `pnpm build` (turbo — 8/8, clean no-cache rebuild in the main repo), `pnpm -r build` (8/8), `pnpm lint` (0), `pnpm test:all` (41 files / 323 tests; integration project 10 files / 37 tests including the relocated `api/test/projections-*.int.test.ts` + `skeleton.int.test.ts`).

| Finding | Status | Fix (commit `b268f8b` ← `17055cd`) | Guarding test |
|---|---|---|---|
| **M1** duplicate `loadBlockId` on mixed-handling + over-volume | **RESOLVED** | `split.ts` re-derives the key per handling group (`withHandlingClass`) and threads the `#h{i}` discriminator through the `#v{j}` volume split so sub-block ids stay globally unique | `aggregation/src/split.test.ts:180` ("M1/L2: mixed-handling + over-volume — id uniqueness + key match"): asserts `new Set(ids).size === out.length` |
| **L1** full-repo `pnpm build` build-cycle (Phase-1 debt) | **RESOLVED** | Removed test-only cross-package devDeps (`@mm/api`, `@mm/simulation`) from `event-store/package.json` and the `@mm/event-store`/pg devDeps from `projections/package.json`; relocated `skeleton.int.test.ts` + `projections-*.int.test.ts` into `api/test/` (a package that already depends on those graphs). Turbo can now order the graph | turbo `pnpm build` exits 0 (8/8, verified with cache cleared); integration glob `packages/*/test/**/*.int.test.ts` still runs the relocated tests (10/10, 37 tests) |
| **L2** stale `BlockKey.handlingClass` on re-keyed sub-blocks | **RESOLVED** | Same `withHandlingClass(block.key, g[0].handlingClass)` re-derivation as M1 — each handling sub-block's `key.handlingClass` now matches its members | `aggregation/src/split.test.ts:180` (asserts sub-block key class matches members) |
| **L3** deadline term loses resolution at far-future epochs | **RESOLVED** | Replaced asymptotic `d/(d+SCALE)` with a **linear** `min(d/HORIZON,1)*MAX_FRACTION` over a fixed `Date.UTC(3000,0,1)` horizon — uniform precision across the range; SLA dominance preserved (`<1` always). Documented edge: deadlines past the year-3000 horizon clamp to `MAX_FRACTION` and rank equal-latest (never crossing the SLA tier) | `aggregation/src/priority.test.ts:63` (1ms-apart far-future deadlines stay distinct) + `:72` (SLA dominance at far-future) |
| **L6** zone label derived from caller `placement.depth` | **RESOLVED** | `zoneLabel(plan, placement)` now finds the owning slice in `plan.slices` by `loadBlockId` and labels THAT depth (the same slice-truth the blocker count uses); falls back to `placement.depth` only if absent from every slice | `load-planner/src/rationale.test.ts:112` ("zone label tracks the block's ACTUAL slice, not a drifted placement.depth") |
| **L7** `plannerConfigSchema` missing `utilLow ≤ utilHigh` cross-validation | **RESOLVED** | Split into `plannerConfigObjectSchema` (`.partial()`-able) + `plannerConfigSchema` that `.refine`s `utilLow <= utilHigh`. `parseBody` re-runs the full refine on the merged config so `POST {config:{utilLow:0.95, utilHigh:0.5}}` is rejected with 400 | `domain/test/planning.unit.test.ts` (inverted band rejected) + `api/test/plan.test.ts:208` ("inverted util band … rejected with 400 (L7)") |
| **L4** `keyId` separator-collision for adversarial hub-id strings | **carried** | Not addressed (near-zero practical reachability — requires U+241F in a hub id). Safe carried debt | — |
| **L5** dead-doc partial-LIFO branch in `plan-load.ts` docstring | **carried** | Not addressed (maintainability-only; planner is structurally total-LIFO). Safe carried debt | — |

---

## MEDIUM

### M1 — `splitBlock` produces DUPLICATE `loadBlockId`s on a mixed-handling, over-volume block (id-uniqueness / determinism invariant broken)  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: `split.test.ts:180`)
- **File:** `packages/aggregation/src/split.ts:42-53` (recursion at `:46`, volume rebuild at `:53`)
- **Kind:** correctness (latent, public-API)
- **Evidence (reproduced):** The handling-incompatibility branch recurses with `splitBlock(buildLoadBlock(block.key, g, '#h'+i), g, config)` — passing the **parent** `block.key` (a single stale `handlingClass`) into every group. When a handling group is itself over-volume, the recursive call hits the volume branch `buildLoadBlock(block.key, g, '#v'+j)` (`:53`), which **rebuilds the id from the same stale key + a fresh `#v{j}`, discarding the `#h{i}` discriminator**. Since `keyId` (`block.ts:28-30`) derives `loadBlockId` purely from key fields + suffix, the fragile-`#v0` and heavy-`#v0` sub-blocks collide. Repro (3 fragile + 3 heavy, vol 9 each, cap=20, hand-built mixed block): output ids `['LB-…fragile␟small#v0','…#v1','…fragile␟small#v0','…#v1']` → `new Set(ids).size === 2 !== 4`. `aggregate.ts:56` sorts by `loadBlockId` as the canonical stable key, so colliding ids break determinism and any id-keyed downstream map/dedup.
- **Why MEDIUM not HIGH:** Unreachable through the production entry point. `handlingClass` is part of the 7-part `BlockKey` and `deriveKey` (`aggregate.ts:66-76`) sets it per-package, so fragile and heavy packages always land in *separate* blocks — `aggregate` can never hand `splitBlock` a mixed-handling block (the aggregate-path repro of the same 6 packages yields all-unique ids). The collision is reachable only by an external caller hand-constructing a mixed block and calling the publicly exported `splitBlock` (`index.ts:15`) directly. Bounded, no data corrupted through the documented flow today — hence MEDIUM.
- **Fix:** Rebuild each handling group's block from a key derived from *that group's* actual `handlingClass` so `keyId` itself differs per group (also fixes L2). Concretely, at `split.ts:46` use `buildLoadBlock({ ...block.key, handlingClass: g[0].handlingClass }, g, '#h'+i)` so the recursed id prefix is distinct before the `#v` suffix is appended; or thread the parent suffix through so volume ids become `#h{i}#v{j}`. Add a regression test: mixed-handling **and** over-volume groups asserting `new Set(out.map(b=>b.loadBlockId)).size === out.length`.

---

## LOW (carried debt)

### L1 — Full-repo `pnpm build` fails on a pre-existing Phase-1 circular package dependency (build gate red)  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: turbo `pnpm build` 8/8 + integration glob 10/10)
- **File:** `packages/event-store/package.json` (devDependencies `@mm/api`, `@mm/simulation`); `turbo.json` `build.dependsOn = ["^build"]`
- **Kind:** build / dependency hygiene
- **Evidence:** `pnpm build` exits 1 — turbo: *"Cyclic dependency detected: `@mm/simulation#build, @mm/event-store#build, @mm/projections#build, @mm/api#build`"*. `event-store` declares `@mm/api`/`@mm/simulation` as **devDependencies** (used only by `test/skeleton.int.test.ts`; the sole `src` cross-import is `store.ts:3 → @mm/projections`), and `@mm/api` depends on `@mm/event-store`, closing the loop because turbo treats devDeps as `^build` inputs. `git log -S '"@mm/api"' -- packages/event-store/package.json` attributes it to commit `53f6a4b` "feat(01): walking skeleton" (Phase 1). **Not a Phase-2 regression:** `@mm/aggregation`/`@mm/load-planner` declare only `@mm/domain` and build EXIT 0 in isolation (`turbo run build --filter=@mm/aggregation --filter=@mm/load-planner` → 3/3 successful). `pnpm test:all` (40/309) and `pnpm lint` (0) are green.
- **Fix:** Break the cycle so `turbo run build` can order the graph. Cleanest: move `@mm/api`/`@mm/simulation` out of `event-store`'s build-visible deps — e.g. relocate `skeleton.int.test.ts` to a top-level integration test package, or restructure so the test imports don't make `api` a `^build` input of `event-store` (a turbo `dependsOn` override / `tasks` graph split, or extracting the shared contract into `@mm/domain`). This is Phase-1 debt surfaced by the Phase-2 gate; tracked here so the build gate can go green.

### L2 — Handling-incompatibility split leaves a stale `BlockKey.handlingClass` on re-keyed sub-blocks  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: `split.test.ts:180`)
- **File:** `packages/aggregation/src/split.ts:46` (passes `block.key` unchanged); `block.ts:41-61` (`buildLoadBlock` uses `key` verbatim, never re-derives `handlingClass`)
- **Kind:** correctness (latent, defensive-branch)
- **Evidence:** A fragile-keyed parent's heavy-only sub-block keeps `key.handlingClass:'fragile'` and a `loadBlockId` embedding `'fragile'`; `loadBlockSchema.parse` passes because `'fragile'` is a valid enum. Same reachability bound as M1: through `aggregate`, every block has uniform `handlingClass` matching its key, so the fragile+heavy branch is effectively dead/defensive for any aggregate-produced block. `split.test.ts:135-136` itself documents that the mixed block must be hand-forged (an input that already violates AGG-01's key-describes-members invariant). The existing "splits a fragile+heavy block" test only checks no sub-block mixes classes, never that the key matches members.
- **Fix:** Re-derive each handling group's key (shared with M1): `buildLoadBlock({ ...block.key, handlingClass: g[0].handlingClass }, g, '#h'+i)`. Add an assertion that every handling sub-block's `key.handlingClass` equals its members' uniform `handlingClass`.

### L3 — `blockPriority` deadline term loses sub-second resolution at far-future Unix-ms epochs  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: `priority.test.ts:63,72`)
- **File:** `packages/aggregation/src/priority.ts:48` (`d / (d + DEADLINE_SCALE_MS)`, `DEADLINE_SCALE_MS = 1e9` at `:38`)
- **Kind:** correctness (latent precision)
- **Evidence (reproduced):** The fold loses resolution as `d` grows. Binary search: at base `2,865,693,213,830` (~year 2060 in Unix-ms) two deadlines 1ms apart map to the **same** double; at base 9e12 (~2255) they are non-distinct AND mis-ordered. The raw Unix-ms `deadline` is what flows in (`block.ts:60` passes `earliestDeadline` reduced from `p.deadline`; clock uses real Unix epoch). SLA dominance always holds (`frac<1` even at `MAX_SAFE_INTEGER`). Untested above 1e10.
- **Why LOW:** `EPOCH_ISO` is 2026-04-01 (~1.775e12); the collapse threshold (~2.866e12) is ~34 years of deadline magnitude away — unreachable for any realistic logistics horizon. Only sub-millisecond differences collapse even far-future; hours/days/weeks stay distinct for centuries. No production code currently sorts LoadBlocks by `priority` (only `aggregate.test.ts:149`), so nothing downstream is corrupted today.
- **Fix:** Stop folding two axes into one lossy double — store priority as a structured `{slaWeight, deadline}` (exact integers) with a compound comparator (slaWeight desc, deadline asc), making AGG-04 lexicographic order exact at any magnitude. If a single sortable number is contractually required, derive the deadline term from the small integer `deadlineBucket` instead of raw Unix-ms. Add a far-future-epoch precision test.

### L4 — `keyId` separator-collision guarantee is not enforced for arbitrary hub-id strings  ⏳ CARRIED (safe debt — near-zero reachability)
- **File:** `packages/aggregation/src/block.ts:24-30`
- **Kind:** correctness (latent, doc-claim overstated)
- **Evidence:** `keyId` joins the 7 fields with U+241F (`␟`); the doc comment asserts distinct keys "never alias" because the separator "can't appear in the enum/id values." True for the 4 enum/numeric fields, but the **three hub-id fields** are `z.string().min(1)` (`domain/src/planning/index.ts:22`, `entities/index.ts:24`) — no character exclusion — so U+241F passes validation. Collision: `{currentHubId:"X␟Y", nextUnloadHubId:"Z"}` and `{currentHubId:"X", nextUnloadHubId:"Y␟Z"}` both stringify to `"X␟Y␟Z␟…"`. `keyId` is the Map grouping key in `aggregate()` (`:38-43`), so colliding keys would merge distinct blocks. No test asserts no-collision for adversarial strings.
- **Why LOW:** triggering requires an obscure non-printing control char embedded in a hub id; near-zero in practice (hub ids flow from event payloads but are never expected to contain U+241F).
- **Fix:** Either constrain the hub-id schema to exclude the separator (`z.string().min(1).regex(/^[^␟]+$/)`), or make `keyId` injective regardless of contents (length-prefixed segments, or `JSON.stringify` of the fixed-order tuple). Add a regression test with two distinct keys whose hub ids contain the separator.

### L5 — `plan-load.ts` docstring advertises a partial-LIFO / SOFT (bounded-blocker) branch that `planLoad` can never reach  ⏳ CARRIED (safe debt — maintainability-only)
- **File:** `packages/load-planner/src/plan-load.ts:28-34`
- **Kind:** maintainability (dead doc branch)
- **Evidence (reproduced):** The docstring says "the planner never rejects a bounded-blocker layout — the rehandle COST is assigned in a later plan." But the greedy construction is provably **total-LIFO**: `ordered` is sorted strictly DESC by `unloadOrder` (id tie-break, `:139-144`), `depthOf` inverts the build index (`:172`) so lower order ⇒ lower-or-equal depth (invariant by construction), and `isBlocker` (`lifo-invariant.ts:52-54`) is strict in both axes so same-order cross-depth blocks are never mutual blockers. A 5000-input LCG fuzz over capacity-pressure scenarios + the keystone property test (`planner-vs-validator.property.test.ts:137-147` asserts `totalBlockers===0 && softViolations.length===0` over 200 seeds) confirm `planLoad` emits zero blockers for every well-formed input. Every SOFT/rehandle test feeds a hand-reversed plan or the FIFO baseline — never a `planLoad` output.
- **Why LOW:** the planner being structurally incapable of creating blockers is the *desired* behavior; only the docstring overstates what `planLoad` reaches. The rehandle pathway IS exercised end-to-end, by `baselinePlan` + `scorePlan` (`baseline-vs-optimizer.test.ts`), with a real (non-hand-built) blocker plan.
- **Fix:** Reword `:28-34` to state the greedy placement is total-LIFO (zero blockers) for any input where every block fits a slice (guaranteed by sizing caps to `maxBlockVolume` + the AGG-03 split threshold), and that SOFT/partial-LIFO + rehandle handling is reserved for externally-supplied / non-greedy plans (the FIFO baseline or future optimizers). Reframe the LOAD-05 "partial-LIFO acceptance" as a *tolerance property of the validator/scorer*, not a layout the planner manufactures.

### L6 — `placementRationale` derives the zone label from caller-supplied `placement.depth`, which can disagree with the plan's actual slice depth  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: `rationale.test.ts:112`)
- **File:** `packages/load-planner/src/rationale.ts:60` (`zoneLabel(placement.depth, sliceCount)`)
- **Kind:** correctness (cosmetic, out-of-contract input only)
- **Evidence:** The zone word uses the **caller's** `placement.depth`, while the blocked/accessible verdict and `blockerCount` come from an id-keyed lookup into `breakdown` (`:61-62`), which is built from `placementsFromSlices` (re-derived purely from `plan.slices`, ignoring `plan.placements`). A caller passing a `Placement` whose `depth` disagrees with where that id actually sits in `plan.slices` yields a sentence whose zone noun contradicts the slice-truth blocker count. No production path feeds a contradicting placement (`planExplanation` iterates `plan.placements`; only consumers are the test and the `index.ts:62` export), and every `rationale.test.ts` case passes a depth matching its slice.
- **Why LOW:** nothing data-bearing desyncs — `blockerCount`, the feasible/infeasible verdict, and the minutes figure all flow from the slice-derived breakdown and stay correct; only the human-readable zone noun can drift, only on out-of-contract input with no production trigger.
- **Fix:** Derive the zone from the same slice-truth the count uses — look up the block's depth by `loadBlockId` from the slice-derived placements (reuse `placementsFromSlices`, or scan `plan.slices`) and label THAT depth. To do it cleanly, pass the plan (or slice-derived placement list) into the renderer instead of just `sliceCount`. Alternatively assert a dev-build precondition that `placement.depth` equals the plan's slice depth for that id.

---

## Boundary hardening (config validation) — folded into L-tier

### L7 (companion) — `plannerConfigSchema` does not cross-validate `utilLow ≤ utilHigh`, so an inverted band is accepted at `POST /plan`  ✅ RESOLVED (`b268f8b` ← `17055cd`; guard: `planning.unit.test.ts` + `api/test/plan.test.ts:208`)
- **File:** `packages/domain/src/planning/index.ts:145,147` (no `.refine`/`.superRefine`; defaults 0.75/0.90 at `:169-170`)
- **Kind:** correctness (boundary robustness)
- **Evidence:** `utilLow`/`utilHigh` are each the independent `utilFraction = z.number().gt(0).lte(1)` with no relating refine (the cross-field-refine pattern IS used elsewhere — `entities/index.ts` `packageCount===packageIds.length`, `usedVolume<=capacityVolume`). `plan.ts:107` parses the body with `plannerConfigSchema.partial()` and `mergeConfig` overlays onto defaults, so `POST {config:{utilLow:0.9, utilHigh:0.75}}` passes zod and yields an inverted band. In `utilizationScore` (`scoring.ts:156-165`) any `u∈(0.75,0.9)` then makes BOTH `below` and `above` strictly positive, double-counting the penalty and violating that function's own "at most one side non-zero" docstring (`:153-154`).
- **Why LOW:** the soft `ScoreResult` is structurally separate from the feasibility verdict (`plan.ts` `feasible = isFeasible(validation)` only), the `/plan` route is read-only (no event-store writes), the shipped defaults are coherent, and the bad band is self-inflicted via an explicitly incoherent caller config. No feasibility flip, no data corruption, no security impact.
- **Fix:** Add `.refine((c) => c.utilLow <= c.utilHigh, { message: "utilLow must be <= utilHigh" })` (ideally `utilLow <= targetUtil <= utilHigh`) to `plannerConfigSchema`. Note `partial()` drops the object-level refine, so either re-run the full non-partial `plannerConfigSchema.parse` on the merged config in `parseBody`, or add an explicit post-merge invariant check in `mergeConfig`. Add a unit test asserting an inverted band is rejected with a 400.

---

## Net

- **HIGH:** none.
- **MEDIUM (1) — RESOLVED:** M1 `splitBlock` duplicate-id collision — fixed in `b268f8b` (← `17055cd`), guarded by `split.test.ts:180`. Latent, public-API-only, was unreachable via `aggregate`.
- **LOW (6) — 5 RESOLVED, 2 carried:** L1 build-cycle (RESOLVED — turbo `pnpm build` green), L2 stale key class (RESOLVED with M1), L3 deadline precision (RESOLVED — linear horizon map), L6 zone drift (RESOLVED — slice-truth), L7 config cross-validation (RESOLVED — `.refine` + 400). **Carried (safe debt):** L4 `keyId` separator collision (near-zero reachability), L5 dead doc branch (maintainability-only).
- **Verdict:** All gates green INCLUDING turbo `pnpm build`. M1 + L1 (the two `passed`-blockers) are closed; verification flipped to `status: passed`. L4/L5 remain as carried debt with no production reachability.

## Post-integration status

- **Resolution commit:** `b268f8b` (merge `--no-ff` of rival #1 `17055cdbb683a4d898f2b3f410fc6afbe4e18b0c` into `feature/phase-2-load-planning`).
- **Gates re-verified green:** `pnpm install` (frozen lockfile consistent) · `pnpm build` (turbo 8/8, clean no-cache rebuild) · `pnpm -r build` (8/8) · `pnpm lint` (0) · `pnpm test:all` (41 files / 323 tests) · integration project (10 files / 37 tests, relocated `.int.test.ts` included).
- **Resolved:** M1, L1, L2, L3, L6, L7. **Carried:** L4, L5.
