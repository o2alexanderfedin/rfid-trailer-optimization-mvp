---
phase: 28-continental-hardening
plan: "04"
subsystem: scripts / determinism tooling
tags: [determinism, golden, developer-script, reproducibility, capture-protocol]
dependency_graph:
  requires: ["28-01"]
  provides: [capture-golden-script]
  affects: [scripts/capture-golden.ts]
tech_stack:
  added: []
  patterns:
    - Self-invocating worker mode via CAPTURE_WORKER env var for cross-process hash comparison
    - 4-way reproducibility gate (in-process ×2 + spawnSync child ×2) before baking a golden
key_files:
  created:
    - scripts/capture-golden.ts
  modified: []
decisions:
  - "Import simulate() and FLAGS_OFF_GOLDEN_SHA256 via relative paths (not workspace alias) because the test/ dir is not in @mm/simulation package.json exports"
  - "Use process.execPath + --import tsx/esm for child-process spawning (matches how tsx executes ESM scripts in the project)"
  - "Self-test only fires on the canonical seed=42/durationTicks=10000 config; shorter runs skip it cleanly"
metrics:
  duration: "~20 min"
  completed: "2026-06-27"
  tasks_completed: 1
  files_created: 1
  files_modified: 0
---

# Phase 28 Plan 04: DET-02 Golden Capture Script Summary

**One-liner:** 4-way reproducibility-first golden capture protocol (in-process ×2 + fork ×2 + self-test against `3920accc…`) as a one-command developer script.

## What Was Built

`scripts/capture-golden.ts` — a developer-only tool that codifies the mandatory reproducibility protocol for baking new determinism goldens into `packages/simulation/test/goldens.ts`.

### Script behavior

Two modes controlled by `CAPTURE_WORKER` env var:

**Parent mode** (normal invocation):
1. Runs `simulate(opts)` in-process twice → `h1`, `h2`
2. Spawns itself twice as `CAPTURE_WORKER=1` child processes → `h3`, `h4`
3. Asserts all 4 hashes are identical — exits 1 with which run differed if not
4. Self-test: when seed=42 and durationTicks=10000, asserts against `FLAGS_OFF_GOLDEN_SHA256` and prints confirmation
5. Prints `CONFIRMED SHA-256: <hash>` (ready to paste into goldens.ts)

**Worker mode** (child process):
- Computes hash, writes it to stdout, exits 0 — no other output

### Verified smoke-run output

```
$ pnpm exec tsx scripts/capture-golden.ts 42 10000
[capture-golden] seed=42 durationTicks=10000
[capture-golden] running in-process ×2 …
[capture-golden] spawning child process ×2 …
[capture-golden] self-test: matches FLAGS_OFF golden — capture tooling is wired correctly
[capture-golden] CONFIRMED SHA-256: 3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861
```

Exit code: 0.

## Verification Results

- `pnpm typecheck` — clean (zero errors)
- `pnpm lint` — clean (zero warnings/errors)
- `pnpm exec tsx scripts/capture-golden.ts 42 500` — exits 0, CONFIRMED SHA-256 printed (short run, self-test skipped)
- `pnpm exec tsx scripts/capture-golden.ts 42 10000` — exits 0, self-test green, CONFIRMED SHA-256: `3920accc…`
- `pnpm exec vitest run --project unit packages/simulation/test/determinism.unit.test.ts` — 33/33 tests pass; all 5 goldens byte-identical

## Deviations from Plan

**1. [Rule 1 - Bug] Removed unused `pathToFileURL` import**

- **Found during:** typecheck (`pnpm typecheck` exited 2: TS6133)
- **Issue:** Initial write included `pathToFileURL` in the import from `node:url` (copied from `generate-hubs.ts`), but it's not needed since the script uses `import.meta.url` directly with `fileURLToPath`
- **Fix:** Removed `pathToFileURL` from the import
- **Files modified:** `scripts/capture-golden.ts`
- **Commit:** Folded into the single task commit `8584010`

## Known Stubs

None. This script has no stub values — it runs the real `simulate()` and asserts live-computed hashes.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes. The script is a developer-only tool in `scripts/`, never in the production path. The two threats `T-28-07` and `T-28-08` from the plan's threat model are addressed:

- **T-28-07** (Tampering: script incorrectly claims reproducibility): Mitigated by the 4-way assertion — any hash divergence exits 1 with which run differed.
- **T-28-08** (Elevation: spawnSync inherits env): Accepted — dev-only script inheriting developer's existing env.

## Self-Check: PASSED

- `scripts/capture-golden.ts` exists: FOUND
- Commit `8584010` exists: FOUND
- `pnpm exec tsx scripts/capture-golden.ts 42 10000` exits 0 with `3920accc…`: CONFIRMED
- All 33 determinism unit tests pass (goldens unchanged): CONFIRMED
