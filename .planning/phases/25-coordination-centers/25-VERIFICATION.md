---
phase: 25-coordination-centers
verified: 2026-06-27T01:40:02Z
status: passed
score: 5/5 success criteria met; both adversarial WARNINGs resolved (TTL wired; reject-demo → Phase 27)
overrides_applied: 0
orchestrator_remediation:
  date: 2026-06-27
  resolved:
    - "GUARD 3 (sim-time TTL / isExpired) ORPHANED → WIRED (commit e112490) at both stepAgents drain loops (engine.ts:1990 truck, 2111 hub); expired cross-tick suggestions dropped (no accept/reject/binding). TDD RED→GREEN (coordinator-ttl.unit.test.ts, 3 tests). All 3 goldens (3920accc/94689f99/edfa5a6d) byte-identical + continuation-equivalence green — confirming the handshake is strictly within-tick (no latent cross-tick-consume bug)."
  accepted_deferrals:
    - "COORD-03 reject-with-reason DEAD in the continental scenario (0 SuggestionRejected across 7 seeds; rule-based reroute never lands on a constrained truck). The reject MACHINERY is fully wired + proven (unit tests + 21 legacy rejects + the coordination-rejected alert/audit wiring) — only the continental SCENARIO doesn't exercise it. → Phase 27 demo carry-over: tune the continental scenario/suggestion heuristic so the headline 'won't divert: HOS/fuel' reject fires live (reject-red viz overlay is already a Phase-27 item). Phase-25 requirement (path exists + surfaces) is met."
  notes:
    - "Test-strength nit (non-blocking): the convergence '≤1 distinct reroute destination' assertion is tautological in the single-center golden config; the bounded-plateau (≤K) anti-Zeno test is the substantive, non-tautological guards witness and is solid."
    - "Pre-existing api INTEGRATION timeouts (scenario-reopt/retention) are unrelated to Phase 25 (external-drive DB-timeout skew), not a regression."
gaps: []
deferred:
  - truth: "COORD-03 visible reject-with-reason fires in the CONTINENTAL config (the v3.0 demo topology)"
    addressed_in: "Phase 27"
    evidence: "Phase 27 SC3 explicitly ships 'an opt-in/decluttered advisory-suggestion overlay (accept-green / reject-red)' — the reject-VISUALIZATION carry-over. The reject DATA (rejects actually firing in continental) is a scenario-shaping concern Phase 26 (coordinator-uses-optimizer changes generation) and/or Phase 27 (scale viz) own. Reject path + alert surfacing are fully wired + exercised in the legacy golden (21 dock rejects) and unit tests."
human_verification:
  - test: "Run the live demo in the CONTINENTAL config (continentalTopology + ooda + coordinators + hos + fuel + induction + consolidation on) and confirm whether the headline 'won't divert: HOS/fuel' reject alert is ever expected to appear on screen, or whether the demo will narrate rejects from the legacy-star config."
    expected: "A visible reject-with-reason alert in the feed (the 'smart and honest' moment). MEASURED: continental yields 0 SuggestionRejected across seeds 1/7/42/99/123/777/2024 (only the always-accepted `hold` rule fires; reroute is rare and never lands on a constrained truck). The reject moment is therefore NOT reachable in the continental demo config as built."
    why_human: "Whether the COORD-03 demo headline must work AT CONTINENTAL SCALE (vs. being demonstrated on the legacy star + Phase-27 viz overlay) is a product/demo-scope decision, not a code-correctness fact. The reject machinery is fully wired and proven; only the continental scenario does not exercise it."
  - test: "Decide whether GUARD 3 (sim-time TTL / isExpired) must be ENFORCED at the suggestion consume site, or whether the within-tick handshake (suggestion always consumed in its issuing tick) makes enforcement unnecessary for v3.0."
    expected: "All five COORD-04 guards 'ship with the first coordinator' and are active. MEASURED: isExpired is implemented + unit-tested but is NEVER called in engine.ts — the handshake drains all pending suggestions with no expiry check. In practice the handshake is strictly within-tick so a stale suggestion never reaches a later tick; pendingSuggestionsByTarget is even serialized 'defensively' for the cross-chunk edge case — which is precisely where an un-enforced TTL could let a stale suggestion be acted on after a chunk boundary."
    why_human: "Whether 4-of-5-guards-enforced + a within-tick-only handshake satisfies the COORD-04 'five guards ship' contract is a scope/acceptance judgement. The fix (one isExpired call in the drain loop) is small; the question is whether it is required now or accepted as defensively-moot."
---

# Phase 25: Coordination Centers — Verification Report

**Phase Goal:** One advisory coordination center per regional center (an in-fold event-sourcing process-manager) observes agent events and emits `ActionSuggested`; the target agent accepts (binding event) or rejects-with-reason on its local feasibility — surfaced as a visible "won't divert: HOS/fuel" alert — with the full set of anti-oscillation/anti-deadlock guards so the network stays stable.

**Verified:** 2026-06-27T01:40:02Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Verdict in one line

The phase is **substantively built, deterministic, and gate-green** — all 16 task commits exist, all four quality gates pass, all three goldens verify, and the headline reject machinery is fully wired and exercised in the legacy golden. **Two real holes surfaced under adversarial probing**, neither a hard blocker but both requiring a human decision: (1) the COORD-03 reject DEMO is **dead in the continental topology** (0 rejects across 7 seeds — only the always-accepted `hold` rule fires); (2) GUARD 3 (sim-time TTL `isExpired`) is **orphaned** — implemented + unit-tested but never called in the engine.

## Goal Achievement

### Observable Truths (the 5 ROADMAP success criteria)

| # | Truth (success criterion) | Status | Evidence |
|---|---------------------------|--------|----------|
| 1 | One coordinator per center runs **in-fold** (sorted-by-centerId `stepCoordinators` SimTask, bounded per-center scope) emitting advisory `ActionSuggested` (4 kinds) consumed same-tick via `pendingSuggestionsByTarget` | VERIFIED | `engine.ts:2164` `stepCoordinators` is a self-rescheduling `SimTask` (continuation.ts union); `coordinatorCenterIds` sorted (engine.ts:2186-2190); bounded scope via `centerOf(s.hubId).hubId === centerId` (engine.ts:2203,2213); all 4 kinds generated in `coordinator.ts:66`; `pendingSuggestionsByTarget` populated (engine.ts:2342) and drained in `stepAgents` same tick (engine.ts:1972,2085). Bootstrap seeds coordinator one queue-seq before stepAgents (engine.ts:3245). 26 coordinator-engine + stability tests GREEN. |
| 2 | Target agent **accepts** (`SuggestionAccepted`+binding event) or **rejects** (`SuggestionRejected`+reasonCode) on its OWN feasibility; a **visible reject-with-reason** surfaces in the alert feed + audit timeline | VERIFIED (with a continental-reachability caveat → Truth-2 carry-over) | `arbitrateSuggestion` (handshake.ts:71) reads the agent's binding verdict, never recomputes; accept → `SuggestionAccepted` + reuses existing `TrailerDiverted`/`dispatchHubConsolidation` (no new binding path, engine.ts:1979-1997); reject → `SuggestionRejected`+reasonCode. Surfacing: `exceptions.ts:242` folds a `coordination-rejected` row with `reasonCode`/`suggestionId`/`label` (COORDINATION_REJECT_LABELS incl. "won't divert: HOS"/"won't divert: fuel"); `snapshots.ts:426` maps it to the `blockedFreight` wire kind surfacing the label as the alert reason; audit-timeline fold present. 42 surfacing tests GREEN. Legacy golden fires 21 such alerts. **Caveat:** in continental 0 rejects fire (see Human Verification #1). |
| 3 | Network stays stable: the **five guards** ship — hysteresis, seeded-jitter backoff, sim-time TTL, single-owner lease, reject-path pruning — and a fixed scenario converges within K with no A↔B↔A | VERIFIED with 1 WARNING (GUARD 3 not wired) | `guards.ts` exports all 5 pure/sim-time/seeded predicates; `constants.ts` is the named envelope (all integral MS_PER_TICK). 4 of 5 guards are WIRED into stepCoordinators in deterministic order lease→prune→backoff→hysteresis (engine.ts:2300-2310) + lease-on-emit (2339) + zone-change prune-clear (2253-2262) + reject-loop backoff (recordSuggestionReject engine.ts:1930). **GUARD 3 (`isExpired`) is ORPHANED** — exported + unit-tested but NEVER called in engine.ts (no TTL check at the drain site). Stability suite proves 0 oscillating targets + same-seed byte-identity. |
| 4 | No livelock/deadlock: feasible no-op default closes every tick; all-reject agent still closes; coordinator stops re-suggesting after K — events-per-tick bounded (no Zeno) | VERIFIED | `hold` is always accepted = the feasible no-op (handshake.ts:77). Stability suite (coordinator-stability.unit.test.ts) proves with concrete numbers: a persistently-rejected option re-suggested ≤ REJECT_COOLDOWN_K (=3) times — the Zeno plateau (test b); accepted+rejected == suggested for every tick (test c); HOS-out all-reject run returns a finite stream (termination witness); suggestions/tick < agentBound and < 50. This is the strongest, non-tautological guards-witness in the suite. |
| 5 | Determinism gate: 3 events in closed union+zod+every exhaustive switch + scope-neutral + canonicalize; flag absent (and :false) ⇒ byte-identical `3920accc…`; coordinator-on captures its own golden + continuation-equivalence | VERIFIED | 3 events in `DomainEvent` union (domain-event.ts:259-261) + zod + contract.assert + 12 reducers + inline + scope.ts. All 3 scope-neutral in `hubsOf` (scope.ts:78-96 return []) — no feedback path. `canonicalizeSuggestionPayload` pins ActionSuggested key order, routed at emit (engine.ts:2326). **Determinism re-run by verifier:** flags-off `3920accc…` ✓, two-part gate (false===absent + absent⇒golden) ✓ (27 tests); OODA-on `94689f99…` ✓; coordinator-on `edfa5a6d…` ✓ + != both others + reproducible. Continuation-equivalence chunked==all-at-once @1/7/23/500 ✓. coordinator/** DET-03 ESLint guard active. |

**Score:** 5/5 success criteria substantively met. 2 WARNINGs (Truth 2 continental-reachability, Truth 3 GUARD-3-orphaned) → routed to human decision (status: human_needed).

### Determinism Re-Run Results (verifier-executed, not SUMMARY-trusted)

| Golden / Gate | Expected | Verifier Result | Status |
|---------------|----------|-----------------|--------|
| Flags-off seed-42 10k | `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861` | `pnpm exec vitest run determinism.unit.test.ts` → 27/27 GREEN | ✓ PASS |
| `coordinatorsEnabled` absent ⇒ 3920accc | byte-identical | gate (a/b/c triple) GREEN | ✓ PASS |
| `coordinatorsEnabled: false` === absent | byte-identical | GREEN | ✓ PASS |
| OODA-on | `94689f99…` | pinned + verified | ✓ PASS |
| Coordinator-on | `edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc` | coordinator-determinism.unit.test.ts → 14/14 GREEN; != 3920accc, != 94689f99, reproducible, validateEvent clean, non-trivial 3-type counts | ✓ PASS |
| Continuation-equivalence | chunked==all-at-once @1/7/23/500 | GREEN | ✓ PASS |
| Salt-collision | Set size 9 (COORDINATOR_RNG_SALT pairwise-distinct) | GREEN | ✓ PASS |

### Deferred Items (addressed in later milestone phases)

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | COORD-03 reject-with-reason firing/visualization at continental scale | Phase 27 | Phase 27 SC3: "an opt-in/decluttered advisory-suggestion overlay (accept-green / **reject-red**)". Reject viz is an explicit Phase-27 carry-over; reject DATA shaping is a Phase-26/27 concern. The reject PATH itself is fully wired + exercised this phase (legacy golden + unit). |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `coordinator/canonical.ts` | ActionSuggested canonicalizer | ✓ VERIFIED | Pure fixed-key-order; routed at emit (engine.ts:2326) |
| `coordinator/rng.ts` | ninth salt + deriveCoordinatorRng + stableCenterHash | ✓ VERIFIED | `COORDINATOR_RNG_SALT=0x1c6ea54b`; FNV-1a; lazy; salt-collision Set 9 GREEN |
| `coordinator/observe.ts` | frozen per-center observation | ✓ VERIFIED | readonly integer/string snapshot; bounded scope types |
| `coordinator/coordinator.ts` | rule-based 4-kind generation | ✓ VERIFIED | `decideCoordinatorSuggestions` pure; named thresholds; all 4 kinds |
| `coordinator/handshake.ts` | pure arbitrateSuggestion | ✓ VERIFIED | reads verdict; HOS>fuel>dock; hold always accepted; closed enums |
| `coordinator/constants.ts` | named guard envelope | ✓ VERIFIED | all integral MS_PER_TICK; applied in guards.ts + engine (not dead config) |
| `coordinator/guards.ts` | 5 pure guard predicates | ⚠️ ORPHANED (1 of 5) | passesHysteresis/nextBackoffUntil/inBackoff/leaseAvailable/acquireLease/isPruned/recordReject WIRED; **`isExpired` exists+tested but UNWIRED** |
| `engine.ts` stepCoordinators + handshake + guard filter + reject loop + continuation | full wiring | ✓ VERIFIED (minus TTL) | stepCoordinators (2164), drain/arbitrate (1972/2085), guard filter (2300-2310), recordSuggestionReject (1930), capture (3351-3380) + restore (943-957) |
| `optimizer/rolling/scope.ts` | 3 events scope-neutral | ✓ VERIFIED | hubsOf returns [] for all 3 (78-96); trailersOf default covers them; no feedback path |
| `eslint.config.ts` coordinator/** DET-03 | static guard | ✓ VERIFIED | scoped to coordinator/**/*.ts (172); Date.now/new Date/Math.random/kysely/async-queue blocked; lint exit 0 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| stepCoordinators | stepAgents | `pendingSuggestionsByTarget` (same-tick, coordinator seq < agents seq) | ✓ WIRED | bootstrap order engine.ts:3245 before stepAgents; drained + deleted per agent |
| arbitrateSuggestion | binding events | reuse TrailerDiverted / dispatchHubConsolidation | ✓ WIRED | no new binding path; accept suppresses autonomous Act (no double-emit) |
| SuggestionRejected | alert feed | exceptions.ts `coordination-rejected` → snapshots.ts `blockedFreight` wire | ✓ WIRED | label "won't divert: HOS/fuel" surfaced as alert reason |
| reject site | next coordinator pass | recordSuggestionReject → rejectCount + seeded backoff | ✓ WIRED | closes the Pitfall-10 re-suggest loop; jitter from deriveCoordinatorRng |
| guard state | continuation | captureContinuation (sorted) + !resuming restore | ✓ WIRED | all 6 fields; chunked==all-at-once proven |
| **TTL guard** | **drain site** | **isExpired on pending suggestion** | **✗ NOT_WIRED** | isExpired never called; drain loop has no expiry check |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Produces Real Data | Status |
|----------|------|--------|--------------------|--------|
| ActionSuggested stream | suggestion kind/target/params | live fold maps (pendingBySpoke, pendingAtSpoke, activeTripByTrailer) via frozen observe | YES — legacy golden: 22290 suggested across hold/reroute/consolidate | ✓ FLOWING |
| coordination-rejected alert | reasonCode/label | SuggestionRejected fold | YES in legacy (21 dock alerts); **NO in continental (0)** | ⚠️ STATIC in continental config |

### Behavioral Spot-Checks (verifier-executed)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Continental all-on reject count | simulate(continentalTopology+all-on, seed 42, 10k) | suggested=395, ALL `hold`, accepted=395, **rejected=0** | ✗ FAIL (reject demo dead in continental) |
| Legacy all-on reject count (golden cfg) | simulate(all-on, seed 42, 10k) | suggested=22290, rejected=21 (all `dock`; **no hos/fuel**) | ✓ PASS (rejects fire) but headline HOS/fuel reason never fires |
| Continental rejects across 7 seeds | seeds 1/7/42/99/123/777/2024 | rejected=0 in ALL; only `hold` (+ rare reroute, all accepted) | ✗ FAIL (continental reject path structurally unexercised) |
| Determinism suite | vitest run determinism.unit.test.ts | 27/27 GREEN | ✓ PASS |
| Coordinator goldens + continuation | vitest run coordinator-{determinism,continuation} | 14/14 GREEN | ✓ PASS |
| Stability/oscillation/livelock | vitest run coordinator-stability + coordinator-engine | 26/26 GREEN | ✓ PASS |
| Coordinator unit (guards/handshake/canonical/coordinator) | vitest run src/coordinator/ | 56/56 GREEN | ✓ PASS |
| Reroute destination cardinality (legacy) | probe distinct reroute toHubId | ALL reroutes → single center 'MEM' | ℹ️ makes convergence test (a)/(2nd) tautological in single-center cfg |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| COORD-01 | 25-02 | One advisory center per regional center, in-fold, bounded scope | ✓ SATISFIED | stepCoordinators sorted-by-centerId, bounded by centerOf, self-rescheduling SimTask |
| COORD-02 | 25-01/02/03 | ActionSuggested → accept(+binding)/reject(+reason) | ✓ SATISFIED | full handshake; arbitrateSuggestion; reuses binding events |
| COORD-03 | 25-03 | Visible reject-with-reason in alert feed + audit timeline | ⚠️ SATISFIED (path) / NEEDS HUMAN (continental reachability) | surfacing fully wired + tested + fires in legacy golden; 0 rejects in continental demo config |
| COORD-04 | 25-04/05 | 5 guards + scope-neutral + determinism | ⚠️ SATISFIED (4/5 wired) | hysteresis/backoff/lease/prune wired + scope-neutral + goldens green; **TTL (GUARD 3) orphaned** |
| COORD-05 | 25-04 | Feasible no-op default, no Zeno livelock | ✓ SATISFIED | hold always accepted; ≤K plateau; tick-closes; HOS-out termination |

No orphaned requirements (all of COORD-01..05 mapped to Phase 25 and claimed by plans).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| coordinator/coordinator.ts | 75 | `void rng;` (seeded substream constructed but not drawn) | ℹ️ Info | Documented intentional (drawing would move the golden; jitter draws land at reject site via recordSuggestionReject). Not a stub. |
| engine.ts | drain loop | `isExpired` not called (GUARD 3) | ⚠️ Warning | The sim-time TTL guard does not gate the consume path; within-tick handshake makes it moot in normal operation but defensively-serialized cross-chunk pending could be acted on stale. See Human Verification #2. |
| coordinator-stability.unit.test.ts | 123-136 | convergence "≤1 distinct reroute destination" | ⚠️ Warning (test strength) | Tautological in single-center cfg (all reroutes → the one center). The bounded-plateau test (b) is the real guards-witness; test (a)/(123) is weak. |
| (no debt markers) | — | TBD/FIXME/XXX in Phase-25 files | — | None found in coordinator/** or engine coordinator region. No unreferenced debt markers. |

No 🛑 Blocker anti-patterns. No `Date.now`/`Math.random`/`new Date()` in executable coordinator code (verified: all matches are doc comments). DET-03 ESLint guard + global golden gate both clean.

### Gate Results (verifier-executed)

| Gate | Result |
|------|--------|
| `pnpm build` (turbo) | 10/10 successful |
| `pnpm typecheck` | CLEAN (exit 0) |
| `pnpm lint` | CLEAN (exit 0; coordinator/** + ooda/** DET-03 guards active) |
| simulation unit lane | 46 files / **557 tests GREEN** |
| domain + projections lanes | 34 files / **399 tests GREEN** |
| api UNIT lane (src/) | 21 files / **280 tests GREEN** |
| determinism.unit.test.ts | 27/27 GREEN (3920accc + two-part gate) |
| coordinator-{determinism,continuation} | 14/14 GREEN (edfa5a6d + chunked-equivalence) |
| coordinator-{stability,engine} | 26/26 GREEN |
| api INTEGRATION lane | ⚠️ pre-existing DB-bound timeouts (scenario-reopt/retention/retention-adversarial) — **NOT Phase-25**: reference no coordinator code, untouched by Phase 25, consistent with the documented external-drive DB-timeout skew |

All 16 Phase-25 task commits verified present in git history (d6d805b … b78c0a1).

### Human Verification Required

**1. COORD-03 reject demo at continental scale.** MEASURED: 0 SuggestionRejected across 7 continental seeds (only the always-accepted `hold` fires; reroute is rare and never lands on a constrained truck). The legacy-star golden fires 21 rejects but they are all `dock` reason — the headline "won't divert: HOS/fuel" example fires in NEITHER config in the seed-42 run (HOS/fuel reject is unit-tested only). The reject MACHINERY is fully wired and proven; only the continental SCENARIO does not exercise it. Decide: must the "smart and honest" reject moment work at continental scale (needs scenario tuning / Phase-26 generation change), or is demonstrating it on the legacy star + the Phase-27 reject-red overlay acceptable?

**2. GUARD 3 (sim-time TTL) enforcement.** `isExpired` is implemented + unit-tested but never called at the drain site. The within-tick handshake makes it moot in normal operation, but `pendingSuggestionsByTarget` is serialized defensively for the cross-chunk case — exactly where an un-enforced TTL could let a stale suggestion be acted on. Decide: enforce TTL at the drain loop now (a ~1-line `isExpired` skip), or accept 4-of-5-guards-enforced as satisfying "the five guards ship" given the within-tick invariant.

### Gaps Summary

No hard BLOCKERS. The phase delivers a deterministic, gate-green, continuation-equivalent advisory-coordinator model with all 16 commits, all goldens, and the full accept/reject/surface pipeline wired and exercised in the legacy golden. Adversarial probing found two genuine WARNINGs that are scope/acceptance decisions rather than correctness defects:

1. **COORD-03 reject demo is dead in the continental topology** (0 rejects, all seeds) — the headline demo moment is not reachable in the actual v3.0 demo config. Reject viz is already a Phase-27 carry-over; the reject DATA shaping needs a human call (carry-over vs. tune-now). The reject path/surfacing is fully correct and proven elsewhere.
2. **GUARD 3 (TTL) is orphaned** — 4 of 5 guards are wired; the TTL guard is implemented + tested but unwired. Defensively moot under the within-tick handshake, but it is one of the five guards the criterion names.

A secondary test-strength note: the convergence "≤1 distinct reroute destination" assertion is tautological in the single-center config (all reroutes target the one center); the bounded-plateau (≤K) test is the substantive guards-witness and is solid.

Because both WARNINGs are acceptance decisions (not fixes the verifier can adjudicate), status is **human_needed**. If the developer rules both acceptable (reject-demo deferred to Phase 27, TTL accepted as within-tick-moot), the phase passes; if either must be addressed now, re-plan with `--gaps` after the decision.

---

_Verified: 2026-06-27T01:40:02Z_
_Verifier: Claude (gsd-verifier) — ADVERSARIAL goal-backward pass_
