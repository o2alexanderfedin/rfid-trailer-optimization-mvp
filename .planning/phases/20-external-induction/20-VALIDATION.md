---
phase: 20
slug: external-induction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-24
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `20-RESEARCH.md` § Validation Architecture (HIGH confidence, source-anchored).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x |
| **Config file** | `vitest.config.ts` at repo root |
| **Quick run command** | `pnpm test` (turbo build + vitest unit) |
| **Full suite command** | `pnpm test:all` (unit + integration + ui) |
| **Type gate** | `pnpm typecheck` (MUST run after every domain/continuation change — catches closed-union/contract.assert failures the build alone may miss) |
| **Estimated runtime** | ~15 min full gate (target); new induction tests scale-bounded to keep it there |

---

## Sampling Rate

- **After every task commit:** `pnpm build && pnpm typecheck` (closed-union + `contract.assert.ts` exhaustiveness fail fast)
- **After every task commit:** `pnpm test` (vitest unit)
- **After every plan wave:** `pnpm test:all`
- **Before `/gsd-verify-work` (phase gate):** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` all green
- **Max feedback latency:** < 60s for unit; full gate ~15min

---

## Per-Task Verification Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IND-01 | `packageInductedSchema` validates a well-formed event | unit | `vitest run packages/domain` | ❌ W0 |
| IND-01 | `validate(buildPackageInducted(...))` round-trips without error | unit | `vitest run packages/domain` | ❌ W0 |
| IND-01 | `contract.assert.ts` exhaustiveness — build gate, not a runtime test | build | `pnpm build` / `pnpm typecheck` | n/a |
| IND-02 | `inductionEnabled: false` (default) → zero `PackageInducted` events | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ W0 |
| IND-02 | `inductionEnabled: false` → seed-1234 + seed-42 goldens byte-identical (DET regression) | unit | existing golden tests (simulation + projections) | ✅ regression |
| IND-02 | `INDUCTION_RNG_SALT` pairwise-distinct from all existing salts | unit | `vitest run packages/simulation/test/fuel-determinism.unit.test.ts` | ✅ extend |
| IND-02 | `inductionEnabled: true` → `PackageInducted` events present | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ W0 |
| IND-02 | Continuation-equivalence, `inductionEnabled: true`, chunk boundary **between** arrivals | unit | `vitest run packages/simulation/test/continuation-equivalence.unit.test.ts` | ✅ add 1 case |
| IND-03 | `slaDeadlineIso` deterministic and `> occurredAt` | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ W0 |
| IND-03 | `hubInventory[inductionHubId].inbound` gains the package on `PackageInducted` (same path as `PackageArrivedAtHub`) | unit | `vitest run packages/projections/test/hub-inventory.unit.test.ts` | ✅ extend |
| IND-03 | `detectAffectedScope` returns `[inductionHubId, destHubId]` for `PackageInducted`; `TwinBlock.deadlineMin?` additive | unit | `vitest run packages/optimizer/test/scope.unit.test.ts` | ✅ extend |
| VIZ-13 | induction ws message present on ticks containing inductions | unit | `vitest run packages/api/test/` | ❌ W0 |
| VIZ-13 | `inductionLayer` pulsing-circle marker renders on `PackageInducted` | manual | live map smoke (VIZ — see Manual-Only) | manual |

*Status legend: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Scale Bounds (Gate-Hygiene — MANDATORY)

The full gate must stay ~15 min. New heavy determinism/continuation tests are **scale-bounded from the start**:

- **Continuation-equivalence, `inductionEnabled: true`:** ONE case only — `seed=42, horizon≈100, chunk≈7` with the boundary landing between two induction arrivals. Run time < 1s.
- **`induction-determinism.unit.test.ts`:** `durationTicks ≤ 1000` (existing golden tests use ≤ 10000; new induction tests stay well under).
- **Do NOT** author a chunk-1 × huge-horizon × many-seed matrix. Do NOT extend the `continuation-adversarial.unit.test.ts` SEEDS × HORIZONS matrix; at most add `inductionEnabled: true` to the existing `ALL_ON` flag constant (1-line, same test budget).
- Postgres-bound continuous tests (if any) must use small horizons/few chunks.

---

## Wave 0 Requirements

New / extended test files (stubs land in Wave 0 alongside or before the code under test, TDD-first):

- [ ] `packages/domain/test/` — `packageInductedSchema` validate + round-trip (IND-01)
- [ ] `packages/simulation/test/induction-determinism.unit.test.ts` (NEW) — flag-off zero-events golden, flag-on events-present, deadline sanity (IND-02, IND-03)
- [ ] `packages/simulation/test/fuel-determinism.unit.test.ts` (EXTEND) — add `INDUCTION_RNG_SALT` to pairwise-distinct salt-collision assertion (IND-02)
- [ ] `packages/simulation/test/continuation-equivalence.unit.test.ts` (EXTEND) — add the single bounded `inductionEnabled: true` chunk-boundary-between-arrivals case (IND-02)
- [ ] `packages/projections/test/hub-inventory.unit.test.ts` (EXTEND) — `PackageInducted` populates `inbound` (IND-03)
- [ ] `packages/optimizer/test/scope.unit.test.ts` (EXTEND) — `detectAffectedScope` → `[inductionHubId, destHubId]` (IND-03)
- [ ] `packages/api/test/` — induction ws message on tick payload (VIZ-13)

*Existing golden tests (simulation + projections) require NO new files for DET regression — they must simply remain byte-identical with the flag OFF.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Pulsing induction marker appears at spoke hubs on the live map | VIZ-13 | Visual/animation behavior in OpenLayers; no headless assertion in MVP scope | Run the app with `inductionEnabled: true`, open the map, confirm pulsing circles appear at spoke hubs on a repeating schedule (mirrors VIZ-05/06 visual smoke) |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 test dependencies (VIZ-13 marker visual is the only manual item)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all NEW/EXTEND test references above
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s (unit); full gate ~15min
- [ ] All new heavy tests scale-bounded per § Scale Bounds
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
