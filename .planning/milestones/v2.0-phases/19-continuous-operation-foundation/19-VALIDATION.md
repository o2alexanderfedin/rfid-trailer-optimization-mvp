---
phase: 19
slug: continuous-operation-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-24
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 19-RESEARCH.md "## Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x |
| **Config file** | `vitest.config.ts` (repo root) |
| **Quick run command** | `pnpm test` (turbo build + unit) |
| **Full suite command** | `pnpm test:all` (unit + integration + ui) |
| **Estimated runtime** | ~60–120 seconds (full suite) |

**Separate type gate:** `pnpm typecheck` (catches test-file TS errors that build/lint/vitest miss — run alongside the suite).

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` (turbo build + vitest unit — the task-level gate)
- **After every plan wave:** Run `pnpm test:all` (full suite)
- **Before `/gsd-verify-work`:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` all green
- **Max feedback latency:** ~120 seconds (full suite)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 19-XX | sim | 1 | DET-02 | — | N/A | unit | `pnpm vitest run packages/simulation/test/determinism.unit.test.ts` | ❌ W0 (new describe block) | ⬜ pending |
| 19-XX | sim | 1 | DET-01 | — | N/A | unit | `pnpm vitest run packages/simulation/test/determinism.unit.test.ts` | ✅ existing (add flags-off case) | ⬜ pending |
| 19-XX | sim | 1 | CONT-01 | — | N/A | unit | `pnpm vitest run -t "open-ended loop"` | ❌ W0 (open-ended.unit.test.ts) | ⬜ pending |
| 19-XX | sim | 1 | CONT-02 | — | N/A | unit | `pnpm vitest run -t "self-rescheduling"` | ❌ W0 (open-ended.unit.test.ts) | ⬜ pending |
| 19-XX | sim | 1 | — (VQ#2) | — | N/A | unit | `pnpm vitest run -t "tie-break"` | ❌ W0 (verification test) | ⬜ pending |
| 19-XX | sim | 1 | — (VQ#5) | — | N/A | unit | `pnpm vitest run packages/simulation -t "RouteRegistered"` | ✅ existing (add assertion) | ⬜ pending |
| 19-XX | api | 2 | CONT-04c | — | N/A | unit | `pnpm vitest run -t "LruMap"` | ❌ W0 (lru-map.unit.test.ts) | ⬜ pending |
| 19-XX | api | 2 | CONT-04b | — | N/A | unit | `pnpm vitest run -t "backpressure"` | ❌ W0 (snapshots backpressure) | ⬜ pending |
| 19-XX | api | 2 | CONT-03 | — | N/A | unit | `pnpm vitest run -t "simDay"` | ❌ W0 (ws-envelope test) | ⬜ pending |
| 19-XX | api | 2 | CONT-04a | — | N/A | integration | `pnpm vitest run packages/projections/test/catchup.int.test.ts` | ✅ existing (verify watermark) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*(Task IDs are placeholders — the planner assigns final IDs in PLAN frontmatter.)*

---

## Wave 0 Requirements

- [ ] `packages/simulation/test/open-ended.unit.test.ts` — stubs for CONT-01, CONT-02, EventQueue tie-break verification (VQ#2)
- [ ] New describe block in `packages/simulation/test/determinism.unit.test.ts` — DET-02 10k-tick seed-42 SHA-256 hash golden; DET-01 flags-off byte-identical case
- [ ] `packages/api/test/lru-map.unit.test.ts` — CONT-04c LruMap eviction unit
- [ ] Extend `packages/api/test/snapshots.unit.test.ts` (or new) — CONT-04b `bufferedAmount` backpressure guard
- [ ] Extend `packages/api/test/ws-envelope.unit.test.ts` (or new) — CONT-03 `simDay` field derivation from `simMs`

*Existing `fuel-determinism.unit.test.ts` (5-salt pairwise-distinct), `catchup.int.test.ts` (watermark), `network.test.ts` (route registration) cover regression/verification without new files.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| sim-day counter increments visibly over a sustained run in operator UI | CONT-03 (UI surface) | Live visual confirmation of continuous multi-period operation | Start the sim with `runUntilStopped: true`, open the operator map, confirm the sim-day counter increments across multiple periods without the sim halting |
| Indefinite run stays memory-bounded (no unbounded growth over a long run) | CONT-04 | Long-run memory profile is environmental | Run open-ended for an extended window; confirm process RSS stays bounded (ws backpressure skips ticks for a backgrounded tab; optimizer memo stays ≤500) |
| Departure surges visible on live map (sort-wave) | CONT-05 (P2) | Visual cadence observation | Enable the sort-wave flag; confirm burst-quiet-burst departure surges on the map vs steady trickle when off |
| 10k-tick golden hash cross-architecture (x86 + ARM) | DET-02 | CI may be single-arch | If CI is single-arch, commit the hash from CI and document the cross-arch check; run locally on the other architecture if available |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (5 new/extended test files above)
- [ ] No watch-mode flags (`vitest run`, never `vitest` watch)
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter after Wave 0 stubs land

**Approval:** pending
