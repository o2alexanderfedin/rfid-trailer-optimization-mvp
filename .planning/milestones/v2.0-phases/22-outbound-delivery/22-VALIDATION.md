---
phase: 22
slug: outbound-delivery
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-24
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `22-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4 |
| **Config file** | `packages/simulation/vitest.config.ts` (unit), `packages/api/vitest.config.ts` (int) |
| **Quick run command** | `pnpm --filter @mm/simulation test -- --run --reporter=dot packages/simulation/test/outbound-determinism.unit.test.ts` |
| **Full suite command** | `pnpm test:all` (run ONE gate at a time; `--max-workers 1` for continuation tests) |
| **Estimated runtime** | ~30 seconds (quick) / multi-minute (full suite, gated one at a time) |

---

## Sampling Rate

- **After every task commit:** Run the quick run of the directly-affected test file (`outbound-determinism.unit.test.ts` or the domain/reducer test touched).
- **After every plan wave:** `pnpm --filter @mm/simulation test --run && pnpm --filter @mm/domain test --run && pnpm --filter @mm/projections test --run`
- **Before `/gsd-verify-work`:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` — run ONE gate at a time (see GATE-HYGIENE / `v2-gate-hygiene-oom`).
- **Max feedback latency:** 30 seconds (quick run)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 22-XX | dom | 1 | OUT-01 | — | N/A (validated at existing Zod `.strict()` boundary) | unit | `pnpm --filter @mm/domain test -- --run packages/domain/test/package-delivered.unit.test.ts` | ❌ W0 | ⬜ pending |
| 22-XX | dom | 1 | OUT-01 | — | N/A | build | `pnpm --filter @mm/domain build` (exhaustive switch compiles) | ❌ union ceremony | ⬜ pending |
| 22-XX | sim | 2 | OUT-02 (golden) | — | N/A | golden invariance | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/determinism.unit.test.ts` | ✅ extend DET-01 | ⬜ pending |
| 22-XX | sim | 2 | OUT-02 (flag-off zero events) | — | N/A | golden invariance | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/outbound-determinism.unit.test.ts` | ❌ W0 | ⬜ pending |
| 22-XX | sim | 2 | OUT-02 (terminal-completeness) | — | N/A | unit | (outbound-determinism.unit.test.ts) | ❌ W0 | ⬜ pending |
| 22-XX | sim | 2 | OUT-02 (lifecycle-ordering) | — | N/A | unit | (outbound-determinism.unit.test.ts) | ❌ W0 | ⬜ pending |
| 22-XX | sim | 2 | OUT-03 (onTime) | — | N/A | unit | (outbound-determinism.unit.test.ts) | ❌ W0 | ⬜ pending |
| 22-XX | sim | 2 | OUT-03 (whole-minute ISO) | — | N/A | unit | (outbound-determinism.unit.test.ts) | ❌ W0 | ⬜ pending |
| 22-XX | sim | 1 | D-22-4 (pairwise-distinct salt) | — | N/A | unit | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/fuel-determinism.unit.test.ts` | ✅ extend salts array | ⬜ pending |
| 22-XX | sim | 2 | D-22-4 (continuation-equiv mid-dwell) | — | N/A | continuation equiv. | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/continuation-equivalence.unit.test.ts` | ✅ add "outbound" FEATURE_CASE | ⬜ pending |
| 22-XX | proj | 2 | OUT-04 (bounded-memory / DELETE purge) | — | N/A | unit (pure reducer) | `pnpm --filter @mm/projections test --run` | ❌ W0 + extend existing | ⬜ pending |
| 22-XX | proj | 2 | OUT-04 (DELETE no-op on missing row) | — | N/A | unit | (package-delivered reducer test + hub-inventory.test.ts) | ❌ W0 | ⬜ pending |
| 22-XX | web | 3 | VIZ-14 (flashDelivery self-removes) | — | N/A | unit | `pnpm --filter @mm/web test -- --run packages/web/src/map/deliveryLayer.test.ts` | ❌ W0 | ⬜ pending |
| 22-XX | api | 3 | VIZ-14 (tick-only, not in snapshot) | — | N/A | unit | `pnpm --filter @mm/api test -- --run packages/api/test/ws-delivery.unit.test.ts` | ❌ W0 | ⬜ pending |
| 22-XX | proj | 3 | OUT-05 (P2) (event-derived KPI) | — | N/A | unit | `pnpm --filter @mm/projections test -- --run delivery-kpi` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Task IDs (`22-XX`) are placeholders — the planner assigns concrete plan/task IDs; the requirement→test-type mapping is the binding contract here.*

---

## Determinism-Critical Invariants (acceptance gates — MUST verify)

1. **Flag-off golden byte-identical:** `simulate({ seed: 42, durationTicks: 10000 })` (no `outboundDeliveryEnabled`) hashes to `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`.
2. **Explicit-false ≡ absent:** `simulate({ ..., outboundDeliveryEnabled: false })` byte-identical to the absent-flag run (seed-1234 + seed-42).
3. **`OUTBOUND_RNG_SALT` pairwise-distinct:** `Set([all 8 salts]).size === 8` — extend `fuel-determinism.unit.test.ts`.
4. **Continuation-equivalence mid-dwell:** chunked(7) ≡ all-at-once with `outboundDeliveryEnabled: true`, bounded scale (`durationTicks: 800`, `timing: SHORT_TIMING`), chunk boundary crossing mid-dwell.

---

## Wave 0 Requirements

- [ ] `packages/domain/test/package-delivered.unit.test.ts` — OUT-01 (mirrors `package-inducted.unit.test.ts`)
- [ ] `packages/simulation/test/outbound-determinism.unit.test.ts` — OUT-02, OUT-03, D-22-4, lifecycle-ordering, terminal-completeness (mirrors `induction-determinism.unit.test.ts`)
- [ ] `packages/web/src/map/deliveryLayer.test.ts` — VIZ-14 flash/self-remove (mirrors `inductionLayer.test.ts`)
- [ ] `packages/api/test/ws-delivery.unit.test.ts` — VIZ-14 WS Pitfall-7 (mirrors `ws-induction.unit.test.ts`)
- [ ] Add `PackageDelivered` no-op-on-missing-row test cases to existing `hub-inventory.test.ts` and the package-location reducer test suite
- [ ] Extend `fuel-determinism.unit.test.ts` salts array + `continuation-equivalence.unit.test.ts` FEATURE_CASES (existing files)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Destination-hub highlight pulse visible on live map when `PackageDelivered` fires | VIZ-14 | Visual animation timing/color is not unit-assertable | Run the app with `outboundDeliveryEnabled: true`, watch the map; destination hubs briefly pulse (distinct from VIZ-13 induction purple + VIZ-12 consolidation cyan) |
| KPI widget shows live delivered-out count + on-time % | OUT-05 (P2) | Live operator-panel render | Run app, open operator panel, confirm delivered-out counter + on-time % increment as deliveries fire |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
