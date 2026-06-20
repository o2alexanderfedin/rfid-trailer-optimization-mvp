# Plan 04-03 Summary — Min-cost flow (SSP) + glpk.js oracle (OPT-02)

## What shipped
A pure-TS **Successive Shortest Path** min-cost-flow solver and the **glpk.js
exact-LP correctness oracle** (the Phase-4 keystone), plus `assignFreight` mapping
freight blocks to route legs over the Plan-02 time-expanded graph.

### Files
- `packages/optimizer/src/flow/types.ts` — `Supply`, `FlowResult` contracts.
- `packages/optimizer/src/flow/min-cost-flow.ts` — `minCostFlow(graph, supplies)`:
  residual graph with paired reverse arcs, **Bellman-Ford** initial potentials then
  **Dijkstra-with-potentials**, super-source/super-sink, integer arithmetic only.
  Self-loop edges (`from === to`, e.g. in-place handling) are skipped — they carry
  no flow and would corrupt the paired-arc indexing.
- `packages/optimizer/src/flow/min-cost-flow.test.ts` — diamond hand-fixture (cost
  9), parallel-path, infeasibility, conservation, determinism, multi-source/sink.
- `packages/optimizer/src/flow/glpk-oracle.test.ts` — **KEYSTONE**: SSP optimum ==
  glpk.js exact LP optimum on 60 seeded random instances (4 seeds × 15) + the hand
  fixtures + a capacity-starved infeasible instance. Integer equality, no tolerance.
- `packages/optimizer/src/flow/assign-freight.ts` — `assignFreight`: runs
  `minCostFlow`, decomposes the optimal flow into per-block source→sink leg paths.
- `packages/optimizer/src/flow/assign-freight.test.ts` — single/multi-block,
  cost == optimum, capacity respect, infeasible ⇒ `[]`, real Plan-02 graph.
- `packages/optimizer/src/flow/index.ts` — barrel exports `minCostFlow`,
  `assignFreight`, `FreightAssignment`, `Supply`, `FlowResult`.

## Discipline honored
- **Strict TDD**: RED (failing tests) → GREEN (minimal impl) → REFACTOR per task.
- **anti-P12**: integer costs/capacities/supplies end-to-end; the glpk oracle agrees
  to the unit (no float drift).
- **anti-P2**: `feasible` is a separate `FlowResult` output, checked first, never
  folded into `totalCost`; oracle asserts feasibility agreement independently.
- **anti-P3 determinism**: no `Date.now()` / `Math.random()` in `src`; dense
  Dijkstra selection + id-sorted decomposition replay identically.
- **DRY/KISS/YAGNI/DIP**: smallest correct API (two pure functions), the residual
  engine is a private `ResidualGraph` helper; reuses Plan-02 `TimeExpandedGraph`.
- **glpk.js**: TEST-only devDependency; imported ONLY in `glpk-oracle.test.ts`,
  never in production `src`.

## Gates (run with MM_PG_URL set)
- `pnpm install` — ok.
- `pnpm build` (turbo) — 9/9 successful.
- `pnpm -r build` — ok (force-clean `tsc -b --force` on `@mm/optimizer` also green,
  i.e. not a stale turbo cache artifact).
- `pnpm lint` — clean.
- Unit tests — **342/342 pass** (44 in `@mm/optimizer`, incl. 16 flow + keystone).
- Integration tests — pass in isolation / when the shared Postgres is stable
  (event-store, api, simulation, projections all green). The full `test:all` run was
  intermittently red ONLY because the concurrent Phase-3 worktree repeatedly tears
  down the shared `mm-postgres` container mid-run (verified: container removed 3×).
  Failures are exclusively `ECONNREFUSED` / `CREATE DATABASE` connectivity, never in
  optimizer code, which touches no DB.

## Integration record (merge into `feature/phase-4-rolling-optimizer`)
- Merged winner **rival #2** `wt/p4-03-r2` @ `f62d8fa` via `git merge --no-ff` into
  `feature/phase-4-rolling-optimizer`. Merge commit `2fc53e4`. No conflicts (winner
  was a clean descendant of the branch HEAD `81e3808`).
- Re-verified the FULL gate suite green with `MM_PG_URL=postgres://mm:mm@localhost:5432/postgres`:
  - `pnpm build` (turbo) = 0, `pnpm -r build` = 0, `pnpm lint` = 0.
  - **`pnpm test:all` = 0 → 47 files / 379 tests passed, 0 failed, 0 skipped**,
    integration suites included, against a STABLE shared Postgres on `localhost:5432`.
- Root cause of the previously-reported red, now confirmed and resolved for this run:
  the concurrent Phase-3 worktree (`p3-06-r1`) wraps every `test:all` with
  `docker ps -aq | xargs docker rm -f` — a blanket teardown of ALL containers — which
  removed the docker `mm-postgres` mid-run (observed signature flipping from
  `ECONNREFUSED` to `Connection terminated unexpectedly`). Resolved by serving the
  shared PG natively (Homebrew `postgresql@14` on `localhost:5432`, listening on both
  `127.0.0.1` and `::1`), which is immune to the docker nuke. Per-run isolation via the
  fixture's `mm_test_<uuid>` databases is preserved. This closes the judge's only
  outstanding gate-(1) caveat: integration-on-shared-PG is now verified green.
- No source was modified to make gates pass (no merge breakage existed; tests never
  weakened). Pushed `81e3808..2fc53e4` to `origin/feature/phase-4-rolling-optimizer`.

## Carried risks (from judging, re-stated)
- **R2 flow non-uniqueness**: when multiple min-cost optima exist, `totalCost` is
  deterministic and oracle-verified, but the specific per-edge flow / per-block leg
  assignment is an arbitrary-but-stable tie-break. Acceptable; downstream consumers
  must not assume a unique edge decomposition.
- **NUL-byte sentinels**: super-source/sink node IDs are spelled `"\0SUPER_SOURCE"` /
  `"\0SUPER_SINK"` (literal NUL prefix to avoid collision with real ids). Valid TS, it
  compiles and all tests pass, but it makes `min-cost-flow.ts` register as a binary
  blob in git diffs. Cosmetic; flagged for a future readability cleanup, not weakened.
- **Shared-PG environment coupling**: gate (1) green requires a stable Postgres on
  `localhost:5432`; in a multi-worktree setup the docker-based `mm-postgres` is fragile
  against neighbours that blanket-`docker rm -f`. The native-PG approach above is the
  robust workaround.
