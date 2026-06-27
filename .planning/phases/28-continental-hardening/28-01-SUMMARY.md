---
phase: 28-continental-hardening
plan: "01"
subsystem: simulation/test
tags: [determinism, dry-refactor, golden-constants, det-02]
dependency_graph:
  requires: []
  provides: [goldens.ts]
  affects:
    - packages/simulation/test/determinism.unit.test.ts
    - packages/simulation/test/ooda-determinism.unit.test.ts
    - packages/simulation/test/coordinator-determinism.unit.test.ts
    - packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts
    - packages/simulation/test/continental-determinism.unit.test.ts
    - packages/simulation/test/coordinator-engine.unit.test.ts
tech_stack:
  added: []
  patterns:
    - "Single canonical golden module pattern: goldens.ts as a pure-data leaf with zero imports, 5 named exports"
key_files:
  created:
    - packages/simulation/test/goldens.ts
  modified:
    - packages/simulation/test/determinism.unit.test.ts
    - packages/simulation/test/ooda-determinism.unit.test.ts
    - packages/simulation/test/coordinator-determinism.unit.test.ts
    - packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts
    - packages/simulation/test/continental-determinism.unit.test.ts
    - packages/simulation/test/coordinator-engine.unit.test.ts
decisions:
  - "goldens.ts named exports: FLAGS_OFF_GOLDEN_SHA256 / OODA_ON_GOLDEN_SHA256 / COORDINATOR_ON_GOLDEN_SHA256 / OPTIMIZER_ON_GOLDEN_SHA256 / CONTINENTAL_GOLDEN_SHA256 — zero imports, pure-data leaf"
  - "Local COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256 renamed to OPTIMIZER_ON_GOLDEN_SHA256 at import (DRY + shorter name)"
  - "Provenance comments retained in individual test files (per-file context); master provenance block consolidated in goldens.ts"
  - "it() description strings containing hash prefixes are NOT changed (plan-checker note: these are not const-decl literals)"
metrics:
  duration_minutes: 5
  completed_date: "2026-06-27"
  tasks_completed: 2
  files_modified: 7
---

# Phase 28 Plan 01: DET-02 Golden Consolidation (goldens.ts) Summary

**One-liner:** Canonical `goldens.ts` module extracts all 5 v3.0 SHA-256 golden constants with cross-arch provenance; 6 determinism test files DRY-refactored to named imports — typo in goldens.ts now fails all 83 tests loudly.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create packages/simulation/test/goldens.ts | 7622119 | packages/simulation/test/goldens.ts (new, 116 lines) |
| 2 | Refactor 6 test files to import from goldens.ts | 0f17ccd | 6 test files modified |

## What Was Built

### Task 1 — goldens.ts (new file)

A pure-data leaf module at `packages/simulation/test/goldens.ts` that is the single auditable home for all 5 v3.0 golden SHA-256 constants:

- `FLAGS_OFF_GOLDEN_SHA256` — `3920accc…` (Phase 19 / DET-02, x86_64 darwin, 6172 events)
- `OODA_ON_GOLDEN_SHA256` — `94689f99…` (Phase 24 / OODA-04, x86_64 darwin, 9170 events)
- `COORDINATOR_ON_GOLDEN_SHA256` — `edfa5a6d…` (Phase 25 / COORD-04, arm64 darwin, 61128 events)
- `OPTIMIZER_ON_GOLDEN_SHA256` — `162efbd8…` (Phase 26+P27-A / COORD-06, arm64 darwin)
- `CONTINENTAL_GOLDEN_SHA256` — `8f91b13f…` (Phase 23 / DET-01, x86_64 darwin, topology artifact)

The file includes a consolidated CAPTURE PROVENANCE block with:
- Per-golden architecture (x86_64 vs arm64 darwin) and event counts
- Cross-arch LUT contingency note (RESEARCH VQ#9 / PITFALLS Pitfall 3)
- Reproducibility-first protocol (in-process ×2 + separate node processes)
- Per-golden capture config fingerprints

Zero imports. Named exports only. No default export.

### Task 2 — 6 test files refactored

Each file had its local golden const declarations replaced with imports from `./goldens.js`:

| File | Removed | Added Import |
|------|---------|--------------|
| determinism.unit.test.ts | `LONG_RUN_GOLDEN_SHA256` local + 2 inline consts + 5 bare assertion literals | FLAGS_OFF, OODA_ON, COORDINATOR_ON |
| ooda-determinism.unit.test.ts | `OODA_ON_GOLDEN_SHA256` + `FLAGS_OFF_GOLDEN_SHA256` locals | FLAGS_OFF, OODA_ON |
| coordinator-determinism.unit.test.ts | 3 local golden consts | FLAGS_OFF, OODA_ON, COORDINATOR_ON |
| coordinator-optimizer-determinism.unit.test.ts | 4 local golden consts (COORDINATOR_OPTIMIZER_ON renamed to OPTIMIZER_ON) | FLAGS_OFF, OODA_ON, COORDINATOR_ON, OPTIMIZER_ON |
| continental-determinism.unit.test.ts | `CONTINENTAL_GOLDEN_SHA256` local + 1 bare inline literal | FLAGS_OFF, CONTINENTAL |
| coordinator-engine.unit.test.ts | `GOLDEN` local const | FLAGS_OFF |

## Verification Results

```
Test Files  6 passed (6)
     Tests  83 passed (83)
  Duration  14.65s
```

All 5 goldens byte-identical after refactor. pnpm typecheck: zero errors.

Zero const-declaration bare literal matches:
```
grep -En 'const [A-Z_]+ = "(3920accc|94689f99|edfa5a6d|162efbd8|8f91b13f)' [6 files]
→ exit 1 (no matches)
```

Remaining mentions of hash strings in `it()` description strings and `//` comments are expected and correct (plan-checker note: these are not const-decl literals and should not be removed).

## Deviations from Plan

**1. [Rule 2 - naming] COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256 → OPTIMIZER_ON_GOLDEN_SHA256**
- **Found during:** Task 2 (coordinator-optimizer-determinism.unit.test.ts)
- **Issue:** The plan defined the export name as `OPTIMIZER_ON_GOLDEN_SHA256` in goldens.ts but the local const in the test file was `COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256`. A straight rename was required.
- **Fix:** Replaced all uses of `COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256` with `OPTIMIZER_ON_GOLDEN_SHA256` (the canonical imported name).
- **Files modified:** packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts
- **Commit:** 0f17ccd (included in Task 2 commit)

All other changes executed exactly as planned.

## Known Stubs

None. This is a pure refactor — no new functionality, no data sources, no stubs.

## Threat Flags

None. All changes are test file refactors; no production code path changes. The two mitigate-disposition threats from the plan's threat model are addressed:
- T-28-01 (Tampering): SHA constants are read-only exported strings; 83 tests assert exact hash values.
- T-28-02 (Repudiation): Provenance block consolidated in goldens.ts; per-file comments retained.

## Self-Check: PASSED

- goldens.ts exists: FOUND
- 5 exported constants: 5 (confirmed via `grep -c "^export const"`)
- 2 task commits: 7622119 (feat) + 0f17ccd (refactor)
- 83 tests green: CONFIRMED
- typecheck: zero errors
- No const-decl bare literals in 6 files: CONFIRMED (exit 1 on grep)
