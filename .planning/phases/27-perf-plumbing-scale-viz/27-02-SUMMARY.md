---
phase: 27-perf-plumbing-scale-viz
plan: "02"
subsystem: perf-plumbing
tags: [async-queue, eslint, workspace, fifo, det-03]
dependency_graph:
  requires: []
  provides: [async-queue-workspace-link, det-03-core-ban, fifo-order-test]
  affects: [packages/api, eslint.config.ts, pnpm-workspace.yaml]
tech_stack:
  added: ["@alexanderfedin/async-queue@1.1.0 (CJS, workspace-linked via vendor/*)"]
  patterns:
    - "vendor/* workspace glob + prepare=tsc for CJS submodule dist build"
    - "ESLint no-restricted-imports widened to full packages/simulation/src/**"
    - "FIFO order-guarantee test: N=1000, maxSize=4, concurrent producer+consumer"
key_files:
  created:
    - packages/api/test/async-queue-order.unit.test.ts
  modified:
    - pnpm-workspace.yaml
    - vendor/async-queue/package.json (submodule, commit 452f12d)
    - packages/api/package.json
    - pnpm-lock.yaml
    - eslint.config.ts
decisions:
  - "Added prepare=tsc to vendor submodule package.json (commit inside submodule 452f12d) rather than a workspace-root hook — cleanest approach that triggers on pnpm install"
  - "ESLint ban third block is purely additive: files=[packages/simulation/src/**/*.ts], ignores=[*.test.ts], bans async-queue + kysely for parity with existing ooda/coordinator blocks"
  - "FIFO test lives in @mm/api (not simulation) — DET-03 would ban AsyncQueue import in simulation core"
metrics:
  duration: "~6 min"
  completed: "2026-06-27"
  tasks: 3
  files: 6
---

# Phase 27 Plan 02: PERF-03 Foundation (vendor build + ESLint ban + FIFO test) Summary

**One-liner:** Vendored `@alexanderfedin/async-queue` CJS submodule linked into pnpm ESM workspace via prepare=tsc, DET-03 ESLint no-restricted-imports ban widened to full `packages/simulation/src/**`, and FIFO order-guarantee test proves the queue never reorders the event stream across the backpressure boundary.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | vendor build + workspace wiring | 223c2b2 | pnpm-workspace.yaml, vendor/async-queue/package.json, packages/api/package.json, pnpm-lock.yaml |
| 2 | widen DET-03 ESLint core-ban | c9d6467 | eslint.config.ts |
| 3 | append-order == generation-order FIFO test | f36d629 | packages/api/test/async-queue-order.unit.test.ts |

## Verification Results

- `vendor/async-queue/dist/index.js` and `dist/index.d.ts` exist after `pnpm install` (prepare=tsc ran)
- `node -e "require('./vendor/async-queue/dist/index.js').AsyncQueue"` → function (resolves)
- ESLint probe in `packages/simulation/src/` → `BAN_ENFORCED` (no-restricted-imports fires)
- `pnpm exec vitest run packages/api/test/async-queue-order.unit.test.ts` → 3 passed
- `pnpm exec tsc --project packages/api/tsconfig.json --noEmit` → 0 errors
- Determinism gate: `pnpm exec vitest run packages/simulation/test/determinism.unit.test.ts` → 33 passed; goldens `3920accc`/`94689f99`/`edfa5a6d` byte-identical

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Scope Notes

- Pre-existing lint error in `packages/projections/test/trailer-fuel-rebuild.unit.test.ts:221` (unnecessary type assertion, from 27-01 PERF-02 plan) is out of scope — not touched by this plan.
- Pre-existing typecheck errors in `packages/projections/test/` and `packages/web/vite.config.ts` are from PERF-02 and a vite version mismatch — pre-dating this plan, not caused by our changes.

## Known Stubs

None — this plan is foundation/plumbing only (no UI rendering paths or data wiring).

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The `vendor/**` ESLint ignore is intentional (CONTEXT Area 2); call sites are linted and `AsyncQueue<ConcreteType>` is always parameterized.

## Self-Check: PASSED

- [x] `vendor/async-queue/dist/index.js` — FOUND
- [x] `vendor/async-queue/dist/index.d.ts` — FOUND
- [x] `packages/api/test/async-queue-order.unit.test.ts` — FOUND
- [x] Commit 223c2b2 exists (Task 1)
- [x] Commit c9d6467 exists (Task 2)
- [x] Commit f36d629 exists (Task 3)
