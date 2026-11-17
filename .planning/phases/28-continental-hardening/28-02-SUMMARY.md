---
phase: 28-continental-hardening
plan: "02"
subsystem: simulation/test
tags: [determinism, coordinator, shuffle-invariance, tdd, gap-closure]

dependency_graph:
  requires:
    - "28-01"  # goldens.ts created; COORDINATOR_ON_GOLDEN_SHA256 available
  provides:
    - "coordinator agent-order-shuffle witness (GAP-1 closed)"
  affects:
    - packages/simulation/test/coordinator-determinism.unit.test.ts

tech_stack:
  added: []
  patterns:
    - "Shuffle-invariance batch test: codepoint-sort → call pure function per id → assert byte-identical JSON regardless of input permutation"

key_files:
  created: []
  modified:
    - packages/simulation/test/coordinator-determinism.unit.test.ts

decisions:
  - "Used inline codepoint sort instead of importing sortAgentsByStableId — coordinator sort is simpler (plain string comparison) and importing the OODA helper would create a cross-subsystem dependency for a structural primitive"
  - "Observations exercise all 4 suggestion rules (reroute/hold/consolidate/dispatch) so the batch is non-trivial; the shuffled-equals-sorted assertion is load-bearing, not vacuous"
  - "No new golden baked — test asserts RELATIVE invariance (all permutations equal the in-order batch), exactly mirroring the OODA template which also does not bake a shuffle-specific SHA"
  - "Added imports for decideCoordinatorSuggestions, deriveCoordinatorRng, and CoordinatorObservation directly from coordinator/index (already re-exported there)"

metrics:
  duration_minutes: 15
  completed_date: "2026-06-27"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 1
---

# Phase 28 Plan 02: Coordinator Agent-Order-Shuffle Test (GAP-1) Summary

Coordinator per-center shuffle-invariance batch test closing DET-02 GAP-1: mirrors the OODA agent-order-shuffle pattern for the coordinator/center iteration order.

## What Was Built

Added a new `describe("coordinator-order-shuffle golden (COORD-01, Pitfall 1+4)")` block to `coordinator-determinism.unit.test.ts` with 2 `it()` assertions:

1. **Shuffle yields byte-identical batch** — reverse, rotate, and an explicit permutation of the 6-center input all produce the same sorted `{ order, suggestions }` JSON string.
2. **Sorted order is codepoint-sorted** — the batch's `order` array equals `[...centerIds].sort()` regardless of which permutation was supplied.

The test structure is a structural mirror of `ooda-determinism.unit.test.ts:49-105`:
- `batch(order)` codepoint-sorts the input, calls `decideCoordinatorSuggestions(obsFor(centerId), deriveCoordinatorRng(SEED, centerId))` per sorted center, returns `JSON.stringify({ order, suggestions })`.
- `obsFor(centerId)` builds a minimal but non-trivial `CoordinatorObservation` that crosses all 4 rule thresholds (reroute, hold, consolidate, dispatch), ensuring the batch carries real content.

## Task 1: Read Signature (findings)

- `decideCoordinatorSuggestions(obs: CoordinatorObservation, rng: Rng): readonly CoordinatorSuggestion[]` — only 2 params (no guard-state, no simTimeMs in this phase's rule-based path; `void rng` is the body's first line since Plan 04 jitter is not yet consumed)
- `CoordinatorObservation`: `centerId`, `tick`, `issuedAtSimMs`, `spokes: readonly ObservedSpoke[]`, `trucks: readonly ObservedTruck[]`
- Thresholds: `congestionQueueDepth: 12`, `consolidationFill: 6`, `dispatchReadyFill: 3`

## Task 2: Test Implementation

New imports added to `coordinator-determinism.unit.test.ts`:
- `decideCoordinatorSuggestions`, `deriveCoordinatorRng`, `type CoordinatorObservation` from `../src/coordinator/index.js`

No bare golden string literals. No production code changes.

## Verification Results

```
✓ coordinator-order-shuffle golden (COORD-01, Pitfall 1+4)
  ✓ shuffling the per-tick center INPUT order yields a byte-identical batch  2ms
  ✓ the sorted batch order is the codepoint-sorted centerId order (input-independent)  1ms

Test Files  5 passed (5)
Tests  67 passed (67)
```

All 5 goldens byte-identical:
- `FLAGS_OFF_GOLDEN_SHA256`  (3920accc) — green
- `OODA_ON_GOLDEN_SHA256`    (94689f99) — green
- `COORDINATOR_ON_GOLDEN_SHA256` (edfa5a6d) — green
- `OPTIMIZER_ON_GOLDEN_SHA256`   (162efbd8) — green
- `CONTINENTAL_GOLDEN_SHA256`    (8f91b13f) — green

`pnpm typecheck` — clean (0 errors).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1+2  | 5c8b6a2 | test(28-02): add coordinator agent-order-shuffle batch test (GAP-1 closure) |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. Test-only change; no new production surface.

## Self-Check: PASSED

- `coordinator-determinism.unit.test.ts` contains the new describe block: CONFIRMED
- Commit 5c8b6a2 exists: CONFIRMED
- All 67 determinism tests green: CONFIRMED
- `pnpm typecheck` clean: CONFIRMED
- No bare golden literals added: CONFIRMED (relative-invariance assertion only)
- All 5 committed goldens still match: CONFIRMED
