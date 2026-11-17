---
phase: 25-coordination-centers
plan: 06
subsystem: simulation
tags: [coordination, determinism, gap-closure, ttl, guards, anti-deadlock, sim-time, verification]

# Dependency graph
requires:
  - phase: 25-coordination-centers (plan 04)
    provides: "isExpired — the sim-time TTL predicate (GUARD 3) + SUGGESTION_TTL_SIM_MS; implemented + unit-tested but never called in the engine (the gap)"
  - phase: 25-coordination-centers (plan 03)
    provides: "the stepAgents same-tick suggestion drain (pendingSuggestionsByTarget) — the consume/handshake site the TTL is wired into"
  - phase: 25-coordination-centers (plan 05)
    provides: "the serialized pendingSuggestionsByTarget (cross-tick restore) — the only path that can produce a stale (expired) pending suggestion"
provides:
  - "GUARD 3 (sim-time TTL) wired into BOTH stepAgents drain loops (truck + hub): a pending suggestion with issuedAtSimMs + ttlSimMs <= now (sim-time) is DROPPED — no SuggestionAccepted/Rejected/binding event, no reject-counter advance (T-25-17 closed at the enforcement site, not just the predicate)"
  - "the cross-chunk-stale-suggestion verifier hole closed: a dedicated TTL-enforcement test (coordinator-ttl.unit.test.ts) injects a stale + a fresh cross-tick pending suggestion into a restored continuation and asserts drop vs consume"
affects: [28-consolidated-determinism-audit (inherits the now-enforced TTL guard + its test)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "guard predicate enforcement at the consume site: isExpired is read at the TOP of each per-suggestion drain iteration (before arbitrate), using the shared sim-time clock nowSimMs = tick × MS_PER_TICK — the SAME clock the reject-path backoff reads (DET-03, never Date.now)"
    - "no-op-on-the-hot-path guard: within the strictly-within-tick handshake issuedAtSimMs == nowSimMs so isExpired is always false ⇒ the goldens are byte-identical; the guard only ever fires on a CROSS-TICK restored pending suggestion"

key-files:
  created:
    - packages/simulation/test/coordinator-ttl.unit.test.ts
  modified:
    - packages/simulation/src/engine.ts

key-decisions:
  - "Wire isExpired at the drain (consume) site, not at emit: the TTL is about a PENDING suggestion that survived to a later tick, so the only correct enforcement point is where each pending entry is read in stepAgents. Both drain loops (truck ~line 1990, hub ~line 2111) check isExpired(issuedAtSimMs, nowSimMs, ttlSimMs) first; an expired entry is `continue`-skipped (dropped) before any arbitrate/accept/reject/binding/recordReject."
  - "Use the shared sim-time clock nowSimMs = tick × MS_PER_TICK (the SAME value recordSuggestionReject already computes) — never Date.now. The handshake fires at the tick the coordinator stamped, so the guard reads one consistent virtual clock."
  - "Drop = silent self-destruct: an expired suggestion emits NOTHING (no SuggestionAccepted, no SuggestionRejected, no binding event) and does NOT advance the reject-path counters — it simply vanishes when the per-target entry is deleted after the drain. This matches the guards.ts contract doc ('an expired pending suggestion self-destructs') exactly."

requirements-completed: []

# Metrics
duration: ~12min
completed: 2026-06-27
---

# Phase 25 Plan 06 (gap-closure): Sim-time TTL Guard Wired into the Suggestion Drain

**Gap closed: `isExpired` (GUARD 3, the sim-time TTL predicate) was implemented + unit-tested in `coordinator/guards.ts` in Plan 04 but had NO call site in the engine — the `stepAgents` drain of `pendingSuggestionsByTarget` consumed every pending suggestion unconditionally, so a cross-tick (restored) stale suggestion could be acted on (T-25-17). It is now wired into BOTH drain loops (truck + hub): a pending suggestion whose `issuedAtSimMs + ttlSimMs <= now` (sim-time) is DROPPED — no accept/reject/binding event, no reject-counter advance. Because the within-tick handshake has `issuedAtSimMs == now`, the guard is a no-op on the hot path, so ALL THREE goldens (`3920accc…` flags-off, `94689f99…` OODA-on, `edfa5a6d…` coordinator-on) AND the continuation-equivalence test (chunked == all-at-once @1/7/23/500) are byte-identical/GREEN.**

## What Was the Gap

`coordinator/guards.ts` exports `isExpired(issuedAtSimMs, nowSimMs, ttlSimMs)` (GUARD 3) with a doc contract — "an expired pending suggestion self-destructs (it is dropped, never acted on)" — and 24 unit tests covering it. But a code search confirmed it had exactly THREE references and none was a call:

```
src/coordinator/guards.ts:130:export function isExpired(...)   # definition
src/coordinator/index.ts:65:  isExpired,                       # re-export
src/coordinator/guards.unit.test.ts                            # unit test
```

It was never imported into `engine.ts`. The 25-04 SUMMARY (line 150) claimed T-25-17 was "mitigated by the sim-time TTL (`isExpired`)" — but the mitigation existed only as an un-called predicate. This is the verification gap.

## The Fix

GUARD 3 wired at the consume site in `stepAgents`, in both drain loops:

- **Truck drain** (~`engine.ts:1990`): before `arbitrateSuggestion`, `if (isExpired(suggested.payload.issuedAtSimMs, nowSimMs, suggested.payload.ttlSimMs)) continue;`
- **Hub drain** (~`engine.ts:2111`): the same check before the hub's `arbitrateSuggestion`.

`nowSimMs = tick × MS_PER_TICK` — the shared sim-time clock (the same value `recordSuggestionReject` computes; never `Date.now`). An expired entry is `continue`-skipped, so NO `SuggestionAccepted`/`SuggestionRejected`/binding event is emitted and the reject-path counters are NOT advanced; the entry self-destructs when the per-target list is deleted after the drain.

`isExpired` added to the existing `./coordinator/index.js` import block (line 83).

## Why the Goldens Are Unchanged (the determinism argument)

In the current same-tick handshake, `stepCoordinators` fires one queue-seq BEFORE `stepAgents` at a shared tick and stamps `issuedAtSimMs = tick × MS_PER_TICK`; the agent consumes it in the SAME tick, so at the drain `nowSimMs == issuedAtSimMs`. Then `isExpired(now, now, ttl) = now >= now + ttl` is **false** for any `ttl > 0` (`SUGGESTION_TTL_SIM_MS = 6 × MS_PER_TICK`). So the guard is a **no-op on the within-tick path** — it can only ever fire on a CROSS-TICK pending suggestion (one restored from a serialized `pendingSuggestionsByTarget` across a chunk boundary, targeting an agent not in the issuing tick's roster).

Verified empirically: the `edfa5a6d…` coordinator-on golden's invariant `accepted + rejected == suggested` (suggested 22290 / accepted 22269 / rejected 21) still holds — no suggestion is dropped on the demo stack — and all three golden hashes are byte-identical.

> Per the key constraint: if wiring the TTL had moved ANY golden, that would have meant a suggestion was being consumed cross-tick (a latent bug) and I would have stopped and reported rather than re-baking. No golden moved — confirming the handshake is strictly within-tick, exactly as 25-05 documented.

## TDD (RED → GREEN)

`coordinator-ttl.unit.test.ts` (new, 3 tests) drives a real coordinator-on chunk to a horizon to capture a genuine `SimContinuation`, then injects TWO synthetic cross-tick pending suggestions into the restored `pendingSuggestionsByTarget` for a real spoke-hub agent (`ORD`): one STALE (`issuedAtSimMs = now − TTL − 1 tick`, strictly expired at resume) and one FRESH (`issuedAtSimMs = now`). It resumes and asserts:

1. The EXPIRED suggestion is DROPPED — 0 `SuggestionAccepted`, 0 `SuggestionRejected` for its id.
2. A within-TTL suggestion is STILL consumed — a `hold` (always feasible, COORD-05) is accepted (1 accepted, 0 rejected).
3. Mixed in one drain: the stale drops, the fresh is consumed.

**RED (before the wire):** tests 1 + 3 failed — the stale `hold` was ACCEPTED (`expected 1 to be 0`), proving the gap (an expired cross-tick suggestion was being acted on). Test 2 passed (the consume path always worked).

**GREEN (after the wire):** all 3 pass. This closes the verifier's cross-chunk-stale-suggestion hole.

## Files Created/Modified

**Created:**
- `packages/simulation/test/coordinator-ttl.unit.test.ts` — 3 TTL-enforcement tests (expired drops / within-TTL consumes / mixed), injecting cross-tick pending suggestions into a restored continuation.

**Modified:**
- `packages/simulation/src/engine.ts` — `isExpired` added to the coordinator import; the GUARD 3 TTL check + shared `nowSimMs` added at the top of both the truck and hub `stepAgents` drain loops.

## Verification

| Gate | Result |
|------|--------|
| new TTL test (`coordinator-ttl`) | 3/3 GREEN (RED→GREEN confirmed) |
| `pnpm typecheck` (repo) | clean (`tsc -p tsconfig.eslint.json --noEmit`) |
| `eslint` (engine.ts, guards.ts, new test) | exit 0 |
| flags-off golden `3920accc…` | unchanged (GREEN) |
| OODA-on golden `94689f99…` | unchanged (GREEN) |
| coordinator-on golden `edfa5a6d…` | unchanged (GREEN); `accepted + rejected == suggested` holds |
| continuation-equivalence (chunked == all-at-once @1/7/23/500) | GREEN |
| coordinator-engine + coordinator-stability | GREEN |
| simulation unit (full) | 46 files / 559 tests GREEN |

`isExpired` now has genuine call sites (`engine.ts:1990`, `engine.ts:2111`) — the orphan is closed.

## Deviations from Plan

None — the gap-closure landed exactly as scoped (TDD RED→GREEN, wire at the drain, goldens unchanged). No Rule 1-4 deviations arose.

## Threat Surface Scan

No new surface. T-25-17 (stale suggestion acted on) is now mitigated at the ENFORCEMENT site (the drain), not merely by an un-called predicate — closing the gap the 25-04 SUMMARY's mitigation claim depended on. No new network endpoint, auth path, file access, or schema change.

## Self-Check: PASSED

- Created file verified on disk: `packages/simulation/test/coordinator-ttl.unit.test.ts`
- `isExpired` call sites verified in `engine.ts` (import line 83; calls lines 1990, 2111)
- Gates: new TTL test 3/3 GREEN (RED→GREEN); `pnpm typecheck` clean; lint exit 0; goldens `3920accc…` / `94689f99…` / `edfa5a6d…` all unchanged; continuation-equivalence (1/7/23/500) GREEN; 559 simulation unit tests GREEN

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
