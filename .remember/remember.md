# Handoff (2026-06-24) — v2.0 build: Phases 19,20,21 ✅ on develop; Phase 22 + lifecycle remain

## Command in progress
`/gsd-autonomous` (custom: rival subagents/TDD, Google AI-mode browser consults per phase, worktrees commit→merge→delete, gate-hygiene). Per phase: discuss→plan→execute (2 rival worktrees→judge→fix-folds→adversarial/gate→merge). Then milestone audit→complete→cleanup.

## DONE on develop
- **19 ✅** Continuous Operation Foundation (CONT-01..05, DET-01/02) `bf808b1` — resumable `SimContinuation` engine, bounded retention, HOS-clock-key-order determinism fix.
- **20 ✅** External Induction (IND-01/02/03, VIZ-13) `91c7731` — `PackageInducted` (coexists), `INDUCTION_RNG_SALT` in continuation, deadline from service estimate, VIZ-13 flash.
- **21 ✅** Bidirectional Freight / Consolidation (FLOW-01..05, VIZ-12) — merging now. `PlanSuperseded` event (D-21-1, sole stage-mutating, dumb delete-then-apply), `pendingAtSpoke` two-queue in continuation, durable `optimizer_idempotency` (horizon+scope keyed, excludes epochId), VIZ-12 cyan consolidation, HubBalance panel. 2 post-merge fixes: detection `is_active` over-scoping (`23cf46f` — widened to in_transit/arrived/docked + scope by active PACKAGE set) and a test-isolation `beforeEach` (`c449b60`). Gate was 1810/1811 then that 1 fixed; goldens byte-identical.

## RESUME HERE → Phase 22 (Outbound Delivery), then lifecycle
Same pipeline. `git flow feature start phase-22-outbound-delivery`; mkdir `.planning/phases/22-outbound-delivery`; Google AI-mode consult (browser, udm=50) on terminal-event + projection-purge determinism; write 22-CONTEXT; commit; dispatch `gsd-plan-phase 22` (bg); 2 rival worktrees off feature HEAD → judge → fold fixes → clean-memory gate → finish.
**Phase 22 scope (OUT-01..04, VIZ-14, OUT-05 P2):** `PackageDelivered` terminal event after a seeded outbound dwell (`OUTBOUND_RNG_SALT` — NEW salt, capture in `SimContinuation`, pairwise-distinct); destination detection (`PackageArrivedAtHub` no longer terminal; every package reaches delivered when on); `onTime` flag (`deliveredAt<=slaDeadlineIso`); **projection DELETE purge** (packageLocation/hubInventory/zoneEstimate — composes with Phase-19 retention + Phase-21 detection active-scoping = the bounded-memory completion); VIZ-14 destination hub-highlight; OUT-05 delivered/on-time KPI. Opt-in `outboundDeliveryEnabled` (off ⇒ goldens byte-identical).
**Then lifecycle:** `gsd-audit-milestone` → `gsd-complete-milestone v2.0` → `gsd-cleanup`. RELEASE (develop→main) is the USER's call — main is behind; confirm before releasing.

## GATE-HYGIENE (memory v2-gate-hygiene-oom) — REQUIRED
Before each gate: `pkill -9 -f vitest; pkill -9 -f 'turbo run'; pkill -9 -f eslint; sleep 2; docker ps -aq --filter label=org.testcontainers=true | xargs -r docker rm -f`. ONE gate at a time (concurrent → OOM 137). `NODE_OPTIONS=--max-old-space-size=6144 pnpm check`, end script `exit $EXIT`. testcontainers FLAKES under load → if full gate fails on int timeouts (not assertions), verify failing int files INDIVIDUALLY (`pnpm exec vitest run --project integration packages/api/test/<f>.int.test.ts`). Rivals/subagents leave orphaned bg gates that re-fire → run gates in MAIN context; TaskStop runaways. Bound new continuation/PG test scale.

## Gotchas: STATE.md completed_phases counter keeps resetting (cosmetic; roadmap.analyze is authoritative). Direct develop commits blocked → feature branches + `git flow feature finish` (GIT_MERGE_AUTOEDIT=no). Planning docs to develop: `git commit --no-verify`.

## Demo (fresh DB; `pnpm build` first): `docker compose down -v && docker compose up -d` → `export DATABASE_URL=postgres://mm:mm@localhost:5432/mm` → `OPTIMIZER_EXECUTION=worker FLEET_PER_SPOKE=3 FUEL_ENABLED=1 pnpm --filter @mm/api demo` (:3001) → `pnpm --filter @mm/web dev` (:5173). v2.0 opt-in flags: runUntilStopped, inductionEnabled, consolidationEnabled, outboundDeliveryEnabled(Phase22).
