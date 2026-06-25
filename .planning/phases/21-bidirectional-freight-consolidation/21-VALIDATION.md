---
phase: 21
slug: bidirectional-freight-consolidation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-24
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 21-RESEARCH.md "Validation Architecture" + the project gate (CLAUDE.md).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x (projects: `unit`, `integration`, `ui`, `browser`) |
| **Config file** | root `vitest` projects; `vitest.coverage.config.ts` aliases `@mm/*`→src |
| **Quick run command** | `vitest run --project unit` (touched package) |
| **Full suite command** | `pnpm test:all` (`turbo run build && vitest run --no-file-parallelism --project unit --project integration --project ui`) |
| **Full gate** | `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` |
| **Estimated runtime** | full gate ~15 min (GATE-HYGIENE: bound new continuation/Postgres tests) |

---

## Sampling Rate

- **After every task commit:** Run `vitest run --project unit` for the touched package (each engine/domain/reducer change exposes a deterministic event-stream / hash assertion).
- **After every plan wave:** Run `pnpm test:all` (the integration lane exercises the Postgres idempotency + supersession projection paths).
- **Before `/gsd-verify-work`:** Full gate green, INCLUDING the seed-42 10k golden (`3920accc…`) and the new `consolidationEnabled:true` continuation-equivalence case.
- **Max feedback latency:** unit lane < 60s; full gate ~15 min.

---

## Per-Task Verification Map

> Plan/task IDs are assigned by the planner; rows below map requirements → observable signal → test. The planner must wire each task's `<acceptance_criteria>` to one of these commands.

| Req | Behavior (observable signal) | Threat Ref | Test Type | Automated Command | File Exists |
|-----|------------------------------|------------|-----------|-------------------|-------------|
| FLOW-01 | spoke-origin `TrailerDeparted` (from≠center) carries real freight drained from `pendingAtSpoke` | T-21 (double-drain) | unit | `vitest run packages/simulation/test/consolidation-determinism.unit.test.ts` | ❌ W0 (mirror over-carry.unit.test.ts) |
| FLOW-02 | center arrival unloads + re-stages into `pendingBySpoke[destSpoke]` (cross-dock); re-staged pkg later departs center→destSpoke | — | unit | same consolidation file | ❌ W0 |
| FLOW-03 | `consolidationEnabled:false` byte-identical to absent; seed-42@10k = `3920accc…`; empty return valid | — | unit | `vitest run packages/simulation/test/determinism.unit.test.ts` (extend) + consolidation file | ⚠️ EXTEND |
| FLOW-03 | chunked == all-at-once with `consolidationEnabled:true` (continuation captures `pendingAtSpoke`) | — | unit | `vitest run packages/simulation/test/continuation-equivalence.unit.test.ts` (add FEATURE_CASE) | ⚠️ EXTEND |
| FLOW-04 | `PlanSuperseded` round-trips + `.strict` rejects extras + exhaustive in all 11 reducers | T-21 (audit/replay) | unit | `vitest run packages/domain` + `vitest run packages/projections` | ❌ W0 (mirror plan-events.test.ts + reducer tests) |
| FLOW-04 | durable idempotency: same `(horizon, scope_hash)` claimed once across a simulated restart; `scopeHash` stable with explicit `ORDER BY` | T-21 (idempotency race) | integration | `vitest run --project integration packages/api/.../rolling-service*.int.test.ts` (BOUNDED: 1 epoch, 1 restart) | ❌ W0 (uses pg-fixture) |
| FLOW-04 | supersession clears stale `staged` (delete-then-apply); no double-count | T-21 (double-count) | unit/int | hub-inventory reducer test + bounded projection int test | ❌ W0 |
| FLOW-04 | detection bounded — `is_active` scoping benchmark at ~1–5k packages | — | unit (perf) | `vitest run packages/projections/.../detector-bound*.test.ts` (NOT 10k) | ❌ W0 |
| VIZ-12 | `TrailerKeyframe.direction` set; consolidation legs ⇒ `'consolidation'`; diff re-emits on change | — | unit | `vitest run packages/api/src/ws/envelope.test.ts` + `snapshots.test.ts` (extend) | ⚠️ EXTEND |
| VIZ-12 | map renders distinct style per direction | — | ui/browser | `vitest run --project ui packages/web/.../layers*.test.ts` (mirror inductionLayer.test.ts) | ❌ W0 |
| FLOW-05 (P2) | hub inbound/outbound balance in read API + operator panel | — | int + ui | `vitest run packages/api/src/routes/hub-detail.test.ts` (extend) + web panel test | ⚠️ EXTEND |

*Status legend: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/simulation/test/consolidation-determinism.unit.test.ts` — FLOW-01/02/03 (mirror `over-carry.unit.test.ts`); BOUNDED (seed 1234 @ ≤6000, the existing determinism horizon).
- [ ] EXTEND `packages/simulation/test/continuation-equivalence.unit.test.ts` — add a `consolidation` FEATURE_CASE crossing a chunk boundary mid-consolidation, seed 1234 @ 800 (existing bound).
- [ ] EXTEND `packages/simulation/test/determinism.unit.test.ts` — add a `consolidationEnabled:false` byte-identical assertion to the DET-01 flags-off gate; keep the seed-42@10k `3920accc…` golden green.
- [ ] `packages/domain/src/events/plan-superseded.test.ts` (or extend `plan-events.test.ts`) — round-trip through `validate()` + `.strict` strict-reject + `DomainEvent` union membership for `PlanSuperseded`.
- [ ] Reducer tests: hub-inventory `PlanSuperseded` delete-then-apply; the other 10 reducers' no-op branch (the existing `assertNeverEvent` exhaustiveness makes the build the primary witness).
- [ ] `packages/api/.../rolling-service` integration test — durable idempotency claim across a restart; uses `startPgFixture()`; BOUNDED to one epoch + one simulated restart.
- [ ] Detection-bound perf test at ~1–5k packages (NOT 10k — GATE-HYGIENE).
- [ ] EXTEND `packages/api/src/ws/envelope.test.ts` / `snapshots.test.ts` for `direction`.
- [ ] Web: VIZ-12 layer style test (mirror `packages/web/src/map/inductionLayer.test.ts`).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live map shows consolidation trailers (spoke→center, distinct styling, non-empty manifests) alongside unchanged distribution trailers | VIZ-12, FLOW-01 | Visual/animation correctness on the OpenLayers map is the demo centerpiece; automated layer-style test covers data, not visual judgment | Run the demo with `consolidationEnabled:true`, observe both directions active simultaneously; confirm consolidation legs render with distinct color/arrow and non-empty freight |
| End-to-end freight trace Spoke A → Center → Spoke B (cross-dock value) | FLOW-02 | End-to-end visual trace across the live map | Induct a package at Spoke A, follow it through consolidation departure, center re-sort, distribution toward Spoke B |
| Per-hub inbound/outbound balance panel (cross-dock heat) | FLOW-05 (P2) | UI presentation/readability of the numeric balance | Open a hub detail panel; confirm inbound/outbound balance is visible and numerically sensible |

---

## Validation Sign-Off

- [ ] All tasks have an `<acceptance_criteria>` automated verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING (❌) references above
- [ ] No watch-mode flags in any command
- [ ] Feedback latency < 60s (unit lane); full gate ~15 min
- [ ] `nyquist_compliant: true` set in frontmatter once Wave 0 is complete

**Approval:** pending
