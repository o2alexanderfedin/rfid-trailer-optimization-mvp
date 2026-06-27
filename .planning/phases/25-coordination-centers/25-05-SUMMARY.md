---
phase: 25-coordination-centers
plan: 05
subsystem: simulation
tags: [determinism, continuation-equivalence, golden, salt-collision, eslint-guard, serialization, coordination, keystone]

# Dependency graph
requires:
  - phase: 25-coordination-centers (plan 02)
    provides: "stepCoordinators + COORDINATOR_RNG_SALT (the ninth salt) + deriveCoordinatorRng (stateless re-derive) + pendingSuggestionsByTarget"
  - phase: 25-coordination-centers (plan 03)
    provides: "the same-tick accept/reject handshake (the reject site that advances the guard counters) — proven strictly within-tick"
  - phase: 25-coordination-centers (plan 04)
    provides: "the five guard state maps (leaseByAgent, rejectCountByOption, backoffUntilByOption, metricAboveSinceByOption, lastCenterByAgent) + the CoordinatorLease shape"
  - phase: 24-ooda-step-agents (plan 04)
    provides: "the activeTripByTrailer present-only-when-on serialization pattern + the OODA-on golden 94689f99 reproducibility-first pattern + the ooda/** DET-03 ESLint block to mirror"
provides:
  - "the coordinator GUARD state + pendingSuggestionsByTarget serialized into SerializedWorldState (present-only-when-on, sorted-by-key, byte-identical [] off path) — full continuation-equivalence for the coordinator-on model"
  - "COORDINATOR_ON_GOLDEN_SHA256 = edfa5a6d... — the coordinator-on 10k golden, captured reproducibility-first (in-process + across-process), != 3920accc and != 94689f99"
  - "the coordinatorsEnabled two-part flags-off gate consolidated in determinism.unit.test.ts (false===absent + absent=>3920accc + false===absent 10k)"
  - "the salt-collision Set size 9 (COORDINATOR_RNG_SALT pairwise-distinct from the 8 prior salts)"
  - "the coordinator/** DET-03 ESLint static guard (Date.now/new Date()/Math.random/kysely/async-queue), proven by a planted violation"
affects: [28-consolidated-determinism-audit (inherits the coordinator-on golden + continuation-equivalence + the static guard as the basis)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "present-only-when-on guard-state serialization: every coordinator state map captured into SerializedWorldState as a sorted-by-key tuple array, written ONLY under coordinatorsEnabled, so the off path captures [] and the serialized form is byte-identical to pre-Phase-25 (mirrors activeTripByTrailer EXACTLY)"
    - "defensive serialization of a within-tick handshake substrate: pendingSuggestionsByTarget serialized even though the handshake proved strictly within-tick, so ANY pending suggestion targeting an agent not in the same-tick roster survives a chunk boundary unconditionally"
    - "reproducibility-first golden capture extended to a fourth model (coordinator-on): prove in-process AND across two separate process invocations BEFORE baking the literal; empirically SELECT the config that genuinely exercises the model (legacy all-on fires rejects; continental yields 0)"
    - "per-coordinator RNG is a documented STATELESS re-derive (deriveCoordinatorRng rebuilt each pass; backoff jitter drawn per-pass from a freshly-derived rng) => NO new SerializedRngStates field"

key-files:
  created:
    - packages/simulation/test/coordinator-continuation.unit.test.ts
    - packages/simulation/test/coordinator-determinism.unit.test.ts
  modified:
    - packages/simulation/src/continuation.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/test/determinism.unit.test.ts
    - eslint.config.ts

key-decisions:
  - "Serialize ALL coordinator state (the 5 guard maps + pendingSuggestionsByTarget) as 6 present-only-when-on, sorted-by-key tuple-array fields on SerializedWorldState, captured in captureContinuation + restored in the !resuming bootstrap, mirroring activeTripByTrailer. Off path: every map empty => captured arrays [] => byte-identical to pre-Phase-25 (3920accc holds)."
  - "pendingSuggestionsByTarget serialized DEFENSIVELY: the Plan-03 handshake is strictly within-tick (stepCoordinators fires one queue-seq before stepAgents at a shared tick; each agent deletes its entry after consuming), so a captured continuation is normally empty here — but serializing it anyway guarantees a suggestion targeting an agent not in the same-tick roster never desyncs a chunked run. Rehydrated through canonicalizeSuggestionPayload (byte-identical key order)."
  - "Per-coordinator RNG confirmed STATELESS re-derive => NO new SerializedRngStates field (mirrors the OODA decision at 24-04). The backoff jitter draws per-pass from deriveCoordinatorRng(seed, coordinatorId) freshly rebuilt at the reject site, with NO stored stream position."
  - "Coordinator-on golden config: the LEGACY single-center all-on stack (coordinatorsEnabled + oodaAgentsEnabled + hos + fuel + induction + consolidation), NOT continentalTopology. Empirically the continental config yields 0 rejects (freight spreads thin — the 25-02 finding); the legacy stack fires non-trivial counts of ALL THREE suggestion event types (suggested 22290 / accepted 22269 / rejected 21). The must-have requires non-trivial reject counts, so legacy all-on is the config the model genuinely exercises (one coordinator on the single legacy center advising real OODA agents)."
  - "COORDINATOR_ON_GOLDEN_SHA256 = edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc captured on arm64 darwin, 61128 events; reproducibility-first proven (in-process twice + two separate node process invocations all identical) BEFORE baking. Capture-env note + integer-LUT cross-arch contingency documented next to the literal. The prior goldens (3920accc, 94689f99) verify GREEN on this arm64 host, so the float path is arch-stable here."
  - "The coordinatorsEnabled two-part gate is CONSOLIDATED in determinism.unit.test.ts (the canonical DET-01 gate file) mirroring the oodaAgentsEnabled a/b/c triple — confirming the gate that also lives in coordinator-engine.unit.test.ts."
  - "The coordinator/** DET-03 ESLint block mirrors the ooda/** block EXACTLY (no-restricted-syntax for Date.now/new Date()/Math.random + no-restricted-imports for kysely/async-queue + patterns), scoped to packages/simulation/src/coordinator/**/*.ts (ignoring *.test.ts). Proven by a planted violation (5 DET-03 errors fired), probes removed, clean tree exit 0."

patterns-established:
  - "salt-collision Set grows by one per new substream salt (Set size 9 now: 7 engine + OODA + COORDINATOR)"
  - "DET-03 static guard cloned per pure decision-core leaf (ooda/** then coordinator/**); the doc comments NAME the banned APIs to document the contract but ESLint matches AST nodes (never comments), so a pure-but-documented tree passes"

requirements-completed: [COORD-04]

# Metrics
duration: 10min
completed: 2026-06-27
---

# Phase 25 Plan 05: The Determinism + Continuation Keystone Summary

**The coordinator model is now a first-class, reproducible, continuation-equivalent, statically-guarded golden (COORD-04 determinism facet): the five anti-oscillation guard state maps + the pending-suggestion substrate serialize into `SerializedWorldState` (present-only-when-on, byte-identical `[]` off path) so a chunked coordinator-on run is byte-identical to all-at-once at chunk sizes 1/7/23/500; a NEW coordinator-on golden `edfa5a6d…` is captured reproducibility-first (in-process AND across two separate process invocations) and differs from both `3920accc…` (flags-off) and `94689f99…` (OODA-on); the `coordinatorsEnabled` two-part flags-off gate + the salt-collision Set size 9 are confirmed; and a `coordinator/**` DET-03 ESLint guard (Date.now/new Date()/Math.random/kysely/async-queue) is proven to fire on a planted violation — full phase gate green (build 10/10, typecheck clean, lint exit 0, 1260 unit tests).**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-27T01:07:16Z
- **Completed:** 2026-06-27T01:17:40Z
- **Tasks:** 3 (Task 1 serialization with co-authored continuation test; Task 2 TDD reproducibility-first golden + gate; Task 3 ESLint guard with planted-violation proof)
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- **Continuation-equivalence for the coordinator-on model (Task 1, COORD-04 / T-25-19).** All five guard state maps (`leaseByAgent`, `rejectCountByOption`, `backoffUntilByOption`, `metricAboveSinceByOption`, `lastCenterByAgent`) PLUS the `pendingSuggestionsByTarget` handshake substrate now serialize into `SerializedWorldState` as six present-only-when-on, sorted-by-key tuple-array fields — captured in `captureContinuation`, restored in the `!resuming` bootstrap, mirroring `activeTripByTrailer` EXACTLY. A coordinator-on run driven in CHUNKS via `runToHorizon` is byte-identical to all-at-once at chunk sizes **1, 7, 23, 500** (8 continuation tests GREEN). The per-coordinator RNG is a documented STATELESS re-derive, so NO new `SerializedRngStates` field is needed.
- **Off-path inertness preserved (the keystone).** Every coordinator-state field is written ONLY under `coordinatorsEnabled`, so on the off path all maps are empty ⇒ captured arrays are `[]` ⇒ the serialized form is byte-identical to pre-Phase-25. The seed-42 10k golden stays `3920accc…` and the OODA-on golden stays `94689f99…` — both verified GREEN.
- **Reproducibility-first coordinator-on golden (Task 2, COORD-04 / T-25-20).** `COORDINATOR_ON_GOLDEN_SHA256 = edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc` (61128 events) captured BEFORE baking by running the config twice in-process (identical) AND across two separate `node` process invocations (identical). It is `!= 3920accc…` (flags-off) AND `!= 94689f99…` (OODA-on) — the coordinator advise/accept/reject handshake changed the decisions. Every emitted event passes the domain `validateEvent` boundary; the stream carries non-trivial counts of all three suggestion event types (**suggested 22290 / accepted 22269 / rejected 21**, `accepted + rejected == suggested`).
- **Two-part flags-off gate + salt-collision Set 9 (Task 2).** The `coordinatorsEnabled` two-part gate (`false === absent` short + `absent ⇒ 3920accc…` 10k + `false === absent` 10k) is consolidated in `determinism.unit.test.ts` mirroring the `oodaAgentsEnabled` a/b/c triple. The salt-collision Set is size 9 — `COORDINATOR_RNG_SALT` pairwise-distinct from the 8 prior salts (7 engine + OODA).
- **The coordinator/** DET-03 ESLint guard (Task 3, COORD-04 / T-25-22).** A flat-config block scoped to `packages/simulation/src/coordinator/**/*.ts` (ignoring `*.test.ts`) mirrors the `ooda/**` block EXACTLY: `no-restricted-syntax` (Date.now, `new Date()`, Math.random) + `no-restricted-imports` (kysely + `@alexanderfedin/async-queue` + patterns). PROVEN by planting `__guard_probe.ts` / `__guard_probe2.ts` — all 5 DET-03 violations fired with their messages — then removing both probes and confirming the clean tree passes `pnpm lint` (exit 0). No production-code change was needed (the leaf was already pure).

## Task Commits

1. **Task 1: serialize the coordinator guard state into SerializedWorldState (continuation-equivalence)** — `71951b5` (feat) — 8 coordinator-continuation tests GREEN (chunked==all-at-once at 1/7/23/500, off-path [], JSON round-trip, sorted-by-key); typecheck clean
2. **Task 2: two-part gate + salt-collision Set 9 + reproducibility-first coordinator-on golden** — `e24e8f5` (feat) — coordinator-determinism 6 GREEN + determinism 27 GREEN (3 new gate tests); golden captured in-process + across-process before baking
3. **Task 3: DET-03 ESLint guard scoped to coordinator/** (planted-violation proof)** — `b78c0a1` (feat) — 5 DET-03 errors fired on the probes; probes removed; pnpm lint exit 0

_Note: Task 1 is serialization with a co-authored continuation-equivalence test (verified GREEN). Task 2 is TDD-style: the golden was captured reproducibility-first (the RED → GREEN gate is the literal-not-yet-present → empirically-captured-then-baked cycle). Task 3 proves the guard by a planted-violation check before/after._

## Files Created/Modified

**Created:**
- `packages/simulation/test/coordinator-continuation.unit.test.ts` — chunked==all-at-once coordinator-on at chunk 1/7/23/500; off-path [] witness; JSON round-trip equivalence; sorted-by-key witness; guard-state-accrued witness (8 tests)
- `packages/simulation/test/coordinator-determinism.unit.test.ts` — COORDINATOR_ON_GOLDEN_SHA256 (reproducibility-first, != 3920accc + != 94689f99, validateEvent, non-trivial 3-type counts) + salt-collision Set size 9 (6 tests)

**Modified:**
- `packages/simulation/src/continuation.ts` — 6 present-only-when-on tuple-array fields on SerializedWorldState (leaseByAgent / rejectCountByOption / backoffUntilByOption / metricAboveSinceByOption / lastCenterByAgent / pendingSuggestionsByTarget)
- `packages/simulation/src/engine.ts` — capture (sorted-by-key) in captureContinuation + restore in the !resuming bootstrap for all 6 fields; pending events rehydrated through canonicalizeSuggestionPayload
- `packages/simulation/test/determinism.unit.test.ts` — the coordinatorsEnabled two-part flags-off gate (a/b/c triple) consolidated in the canonical DET-01 file
- `eslint.config.ts` — the coordinator/** DET-03 static guard block (mirrors ooda/**)

## Decisions Made

See `key-decisions` frontmatter. Highlights: serialize ALL coordinator state (5 guard maps + pending substrate) present-only-when-on + sorted-by-key (byte-identical [] off path); serialize the within-tick pendingSuggestionsByTarget DEFENSIVELY; per-coordinator RNG is a stateless re-derive (no new rng field); the coordinator-on golden uses the LEGACY all-on stack (continental yields 0 rejects, failing the non-trivial-reject must-have); the gate is consolidated in determinism.unit.test.ts; the DET-03 block mirrors ooda/** exactly.

## Deviations from Plan

### Documentation-only reconciliation (not a code deviation)

**1. [Doc] Guard-state field name + salt-Set-size reconciled to the actual codebase**
- **Plan frontmatter referenced** `metricAboveSinceByAgent` and the 25-02 SUMMARY mentioned "Set size 10" in one place.
- **Actual codebase (from Plans 02/04):** the hysteresis marker map is keyed by OPTION (`metricAboveSinceByOption`, `${coordinatorId}|${targetAgentId}|${kind}`), and the salt count is 9 (7 engine + OODA + COORDINATOR). The plan's `must_haves.truths` and the Task-2 interface note both correctly say "Set size 9", so I implemented Set size 9 and serialized `metricAboveSinceByOption` (the real map). No logic change — the field/Set-size names were aligned to ground truth.

**2. [Decision] Coordinator-on golden config selection (within plan's discretion)**
- The plan's Task-2 interface note left the exact config to Claude's discretion ("pick + document the config the model genuinely exercises"), noting coordinators "likely" run continental. Empirically (probed both), the continental config yields 0 rejects — it does NOT exercise the advise/accept/REJECT handshake the must-have requires. The legacy all-on stack fires all three event types (rejected 21). I selected legacy all-on and documented the reasoning next to the literal. This is the plan's discretion exercised, not a deviation from a mandate.

No Rule 1-4 deviations were needed — all three tasks landed as specified; no bugs/missing-functionality/blocking-issues/architectural-changes arose.

## Issues Encountered

- **Continental topology under-triggers the coordinator rules (a known 25-02 finding).** The continental multi-center 10k run produced 395 suggestions, 395 accepted, 0 rejected (freight spreads thin across the backbone; no agent is constrained enough to reject). The legacy single-center all-on stack concentrates congestion + HOS/fuel pressure so the full advise/accept/reject handshake fires. Resolved by selecting the legacy all-on config for the golden (documented).
- **Capture host is arm64, prior goldens were captured on x86_64.** The prior goldens (`3920accc…`, `94689f99…`) verify GREEN on this arm64 host, so the `Math.exp`/`Math.log` float path is arch-stable here and baking the new golden on arm64 is safe. The integer-LUT cross-arch contingency note is documented next to the literal (per the roadmap) for a future multi-arch CI.

## Known Stubs

None. The coordinator-on model is now fully serialized (continuation-equivalent), golden-pinned (reproducibility-first), gated (two-part flags-off), and statically guarded (coordinator/** DET-03). The within-tick pendingSuggestionsByTarget is serialized defensively (not a stub — a correctness guard). Phase 28's consolidated determinism audit inherits all of this.

## User Setup Required

None — no external service configuration required.

## Threat Surface Scan

The plan's `<threat_model>` threats are all MITIGATED (no new surface introduced):
- **T-25-18 (Tampering / flags-off seed-42 golden)** — mitigated by the two-part gate (false===absent AND absent⇒3920accc over short + 10k), confirmed GREEN.
- **T-25-19 (Tampering / guard state across a continuation boundary)** — mitigated by serializing the 5 guard maps + pending substrate present-only-when-on; chunked==all-at-once at 1/7/23/500 proven.
- **T-25-20 (Repudiation / non-reproducible coordinator golden)** — mitigated by reproducibility-first capture (in-process + two separate process invocations before baking).
- **T-25-21 (Tampering / salt collision)** — mitigated by COORDINATOR_RNG_SALT in the size-9 salt-collision Set.
- **T-25-22 (Tampering / wall-clock/random in coordinator core)** — mitigated by the coordinator/** DET-03 ESLint guard, proven by a planted violation.

No threat flags — the change adds NO new network endpoint, auth path, file access, or schema change; the new SerializedWorldState fields are in-process continuation data (present-only-when-on, [] off path).

## Next Phase Readiness

- **Phase 26 (coordinator-uses-optimizer)** can layer scoped pure `runEpoch` suggestion generation onto a coordinator model that is now continuation-equivalent + golden-pinned. The serialized guard state means a scoped optimizer pass that crosses a chunk boundary is already covered.
- **Phase 28 (consolidated determinism audit)** inherits the coordinator-on golden `edfa5a6d…`, the continuation-equivalence test, the two-part gate, the salt-collision Set 9, and the coordinator/** DET-03 static guard as its basis.
- No blockers. Full phase gate green: build 10/10, typecheck clean, lint exit 0 (coordinator/** + ooda/** guards active), 556 simulation + 260 domain + 132 projections + 312 api unit tests GREEN; goldens 3920accc / 94689f99 / edfa5a6d all verified.

## Full Phase Gate Results

| Gate | Result |
|------|--------|
| `pnpm build` (turbo) | 10/10 tasks successful (22.7s) |
| `pnpm typecheck` | clean (tsc -p tsconfig.eslint.json --noEmit) |
| `pnpm lint` | exit 0 (coordinator/** + ooda/** DET-03 guards active) |
| simulation unit | 45 files / 556 tests GREEN |
| domain unit | 17 files / 260 tests GREEN |
| projections unit | 16 files / 132 tests GREEN |
| api unit | 29 files / 312 tests GREEN |
| **total unit** | **1260 tests GREEN** |
| flags-off golden | 3920accc… verified (DET-01/02) |
| OODA-on golden | 94689f99… verified |
| coordinator-on golden | edfa5a6d… verified (reproducibility-first) |
| continuation-equivalence | chunked==all-at-once at 1/7/23/500 |
| DET-03 coordinator/** guard | proven (5 violations fired; clean tree exit 0) |

_Vitest lanes run ONE AT A TIME with pkill -f vitest between runs (the v2-gate-OOM memory — no exit 137)._

## Self-Check: PASSED

- Created files verified on disk: `coordinator-continuation.unit.test.ts`, `coordinator-determinism.unit.test.ts`, `25-05-SUMMARY.md`
- Task commits verified in git log: `71951b5`, `e24e8f5`, `b78c0a1`
- Gates: build 10/10, typecheck clean, lint exit 0 (coordinator/** DET-03 active); 1260 unit tests GREEN; goldens 3920accc / 94689f99 / edfa5a6d verified; chunked==all-at-once at 1/7/23/500; DET-03 coordinator/** guard proven by planted violation

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
