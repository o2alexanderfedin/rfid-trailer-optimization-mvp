---
phase: 23-multi-center-topology
verified: 2026-06-26T12:32:00Z
status: passed
score: 5/5 success-criteria verified (code); int-test confirmed; 1 UI visual deferred to demo; 1 planned-Phase-26 wiring deferral
overrides_applied: 0
orchestrator_remediation:
  date: 2026-06-26
  resolved:
    - "golden-replay int test RE-RUN under a 300s timeout from the same external-drive tree → PASSED (exit 0); the 120s timeout was purely the documented external-drive skew, not an assertion failure. SC#4 confirmed."
    - "root pnpm lint: the 16 errors (all in vendor/async-queue, a Phase-27 submodule) cleared by adding vendor/** to eslint.config.ts ignores (the research-specified treatment; the core-import ban is a separate Phase-27 no-restricted-imports rule). pnpm lint now exit 0."
    - "stale 'DELETE emptied hubs' JSDoc + inline comment in inline.ts corrected to the actual golden-safe upsert-empty-row behavior."
    - "REQUIREMENTS.md HUB-02/HUB-03/PERF-01 checkboxes + traceability marked Complete (bookkeeping drift)."
  accepted_deferrals:
    - "UI map render + on-map attribution footer: engine proven to emit 92 hubs / 202 routes under the flag; pixel render is unverifiable headless → deferred to the milestone-end live demo (visual eyeball)."
    - "partitionScopeByCenter (NET-05) live wiring → Phase 26 (no per-center consumer exists until coordinators; wiring a no-op now would be premature). Carried as an explicit Phase 24/26 planner note."
human_verification:
  - test: "Run the demo with continentalTopology ON and open the live map"
    expected: "~92 big-city hubs render across the lower-48 (1-3/state), 6 regional centers + the near-full-mesh backbone are visually distinguishable, and the on-map OL attribution control shows 'City data © GeoNames, CC BY 4.0' next to the OSM credit"
    why_human: "Visual map rendering + the on-map attribution footer cannot be asserted programmatically; the engine is proven to register 92 hubs / 202 routes under the flag, but the map render + footer visibility is a UI behavior"
  - test: "Run the @mm/api projections golden-replay int test on an INTERNAL disk (not the external /Volumes mount)"
    expected: "live-twin == rebuilt-from-log twin byte-identical (FND-04), including the key-scoped applyHubInventory empty-row persistence — passes (it timed out at 120s/test from the external-drive tree, a known environment skew, NOT an assertion failure)"
    why_human: "DB-bound int test times out from the external-drive main tree per the documented external-drive-skews-db-test-timeouts issue; needs an internal-disk run to confirm. Unit-level rebuild-equivalence (hub-inventory-cost.unit.test.ts) already passes 3/3 as the authoritative correctness witness"
warnings:
  - item: "partitionScopeByCenter (NET-05 per-center scope partition) is defined, exported, re-exported, and unit-tested (6/6, incl. a 500-hub scope-size-invariant proof) but is NOT invoked by any production epoch consumer (epoch.ts / rolling-service.ts / live-loop.ts all still call the flat detectAffectedScope)."
    severity: WARNING
    assessment: "Committed-but-dark — the scaling CAPABILITY exists and its hub-count-independence is proven by test, but it does not yet govern any live epoch. This matches the 23-04 PLAN Task-3 done-condition (which required the function + disjoint/scope-size-invariant tests, NOT loop wiring) and the ROADMAP defers the consumer to Phase 26 (coordinators call a scoped runEpoch; global RollingLoop disabled under the coordinator flag). The deviation from the PLAN's literal wording (an optional centerOf arg ON detectAffectedScope vs a separate partitionScopeByCenter sibling) is a reasonable design choice that keeps detectAffectedScope truly byte-identical. Not a BLOCKER; flagged so Phase 24/26 planners wire it."
deferred:
  - truth: "Per-center scope partition actually governs a live rolling epoch (one center's epoch never pulls another's trailers, in production)"
    addressed_in: "Phase 26"
    evidence: "Phase 26 SC#2: 'each coordinator reuses detectAffectedScope over a short horizon ... scope ⊆ that center's affected hubs, size independent of total network size'; Phase 26 SC#3 disables the global RollingLoop under the coordinator flag. Phase 23 ships the pure, tested partition substrate that Phase 26 consumes."
info:
  - "applyHubInventory JSDoc (inline.ts L514) says 'DELETE hubs the fold emptied', but the implementation (L586-605) and the adjacent comment (L581) correctly UPSERT empty rows and NEVER delete — to stay byte-identical to the prior full-table fold / golden-replay (DFW.outbound === []). Stale doc line; behavior is correct and guarded by the rebuild-equivalence test. Cosmetic."
  - "REQUIREMENTS.md checkboxes are stale: HUB-02, HUB-03, PERF-01 show '[ ]' Pending and the traceability table marks HUB-02/HUB-03 'Pending', though the code fully delivers all three (verified). Bookkeeping drift, not a code gap."
  - "Root `pnpm lint` fails with 16 errors, ALL in vendor/async-queue/* (a submodule for Phase 27 PERF-03, introduced by commit b964c93, touched by zero Phase-23 commits). Direct ESLint on every Phase-23 changed file is clean (exit 0). Out-of-scope, pre-existing vendored-submodule parserOptions.project config issue."
---

# Phase 23: Multi-Center Topology — Verification Report

**Phase Goal:** The engine runs on a continental network of ~80–130 deterministically-generated big-city hubs spoked to multiple regional sort centers over a near-full-mesh backbone, with the projection fold and optimizer scope key-scoped so the 100-hub jump does not re-create the v2.1 freeze — the foundation every later phase reads.
**Verified:** 2026-06-26T12:32:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

All 5 ROADMAP success criteria are met **in code** and proven by tests I ran myself. Status is `human_needed` (not `passed`) because SC#1's "live map renders" + on-map attribution footer is a UI behavior that requires a human to confirm visually, and the real-DB golden-replay int test needs an internal-disk run (it times out from this external-drive tree — a documented environment skew, not a failure). One WARNING: the NET-05 per-center scope-partition function is delivered and tested but not yet wired into a live epoch (planned deferral to Phase 26).

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (Success Criterion) | Status | Evidence |
|---|---------------------------|--------|----------|
| 1 | continentalTopology ON renders ~80–130 hubs (1–3/state, cross-state de-duped, in-envelope) from a committed checksummed `us-big-cities.generated.json` (no runtime city-data dep) + GeoNames CC BY 4.0 attribution in README/UI | ✓ VERIFIED (code) / human (map render) | Committed JSON has **92** hubs, 0 out-of-envelope, 1–3/state (cap respected), 92 unique ids, AK/HI excluded, `hubsChecksum=66ec8b81`, `generatedFrom: all-the-cities@3.1.0 (GeoNames CC BY 4.0)`. Runtime isolation CLEAN — no `all-the-cities`/`us` import under any `packages/*/src` (only `node:fs`/`node:url`/`@mm/domain` in hubs.ts; the lone `all-the-cities` mention there is a comment). Engine spot-check: `simulate({continentalTopology:true})` registers **92** hubs (vs 10 legacy) with real ids (`az-phoenix`…). Attribution wired in README L163-170 AND MapView.tsx L183-190 (OL OSM `attributions`). Map *render* + footer visibility → human. |
| 2 | Freight spoke→nearest center→backbone→dest center→dest spoke; partition+great-circle nearest tie-break by id under leg cap; near-full-mesh backbone ≤2-hop; anti-SPOF survives removing any one center | ✓ VERIFIED | `pickRegionalCenters` (partition by region\|timezone, largest-pop rep, clamp ≥2), `assignSpokesToNearestCenter` (6dp-rounded great-circle, in-partition-first, leg cap 2500km, id-tie-break), `buildBackbone` (n·(n-1) directed legs), `isConnectedWithoutAnyCenter` (pure BFS, true for mesh / false for star) — all substantive in centers.ts. Engine cross-center backbone hop wired in `arriveConsolidationAtCenter`. Spot-check: continental run emits **202 routes** (vs 18 legacy). Tests: centers (18) + routes (13) + multi-center-flow (7) all green. Snapshot records `antiSpof:true`. |
| 3 | Center count parameterized (not hard-coded), chosen empirically THIS phase from a real continental run; committed partition snapshot records the decision; never collapses to a single primary | ✓ VERIFIED | `pickRegionalCenters(hubs, count)` — `count` is a plain param, clamped to `[2, partitionCount]`; no hard-coded literal in the selection logic. `EMPIRICAL_CENTER_COUNT=6` chosen from a documented seed-1234 6000-tick continental run (4/5/6/7/8 measured; rationale in SUMMARY + snapshot). `center-partition.snapshot.json`: centerCount=6, rationale, capturedEnv, hubsChecksum, partitionChecksum=883c337b, antiSpof=true, 6 center ids, **86 assignments across 6 distinct centers** (never single primary). `deriveCenterPartition` throws on count<2. |
| 4 | applyHubInventory key-scoped to touched hub id(s); per-event cost test proves 10-hub === 100-hub; detectAffectedScope gains a per-center partition | ✓ VERIFIED (capability) — see WARNING on wiring | `affectedHubInventory(event)` closed-union extractor (`default: never`); applier reads only `WHERE hub_id IN (touched ids)` UNION the JSONB `?|` placement rows; no full `selectAll()` in the applier path (the one residual `selectAll` at L921 is `readOperationalTwin`, the read-side assembler, documented out of scope / deferred to Phase 27). **Cost test ran green 3/3**: `fx10.rowsRead() toBe fx100.rowsRead()` for PackageArrivedAtHub AND TrailerDeparted + rebuild-equivalence at 10 & 100. `partitionScopeByCenter` exists + tested (6/6 incl. 500-hub scope-size-invariant) but **not yet invoked by a live epoch** → WARNING (deferred to Phase 26). |
| 5 | Generalized buildRoutes produces IDENTICAL Route[] for legacy 10-hub input; continentalTopology absent (and :false) ⇒ seed-42 10k golden byte-identical to 3920accc…; new continental golden on a 12–20-hub fixture | ✓ VERIFIED | **I ran determinism.unit.test.ts: 21/21 pass** — incl. `3920accc…` 10k golden AND the two-part continentalTopology gate (false===absent short + 10k; absent⇒3920accc). Legacy `Route[]` deep-equality test (routes.unit.test.ts) + `buildRoutes(USA_HUBS, undefined, undefined) === buildRoutes(USA_HUBS)`. New continental golden `8f91b13f…` on a 14-hub fixture with reproducibility-FIRST assertion; continental-vs-legacy differs sanity; drift guard (hub-dataset-drift, 12 tests). All green. |

**Score:** 5/5 success criteria verified in code (SC#1 map render + SC#4 real-DB replay routed to human; SC#4 wiring carries 1 WARNING).

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|--------------|----------|
| 1 | Per-center scope partition actually governs a live rolling epoch (production) | Phase 26 | Phase 26 SC#2 ("each coordinator reuses detectAffectedScope over a short horizon … scope ⊆ that center's affected hubs, size independent of total network size") + SC#3 (global RollingLoop disabled under the coordinator flag). Phase 23 ships the pure, tested partition substrate consumed there. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/simulation/src/network/us-big-cities.generated.json` | Committed checksummed 92-hub dataset | ✓ VERIFIED | 92 hubs, hubsChecksum=66ec8b81, in-envelope, 1–3/state |
| `scripts/generate-hubs.ts` | Dev-only generator (I/O behind main()) | ✓ VERIFIED | 347 lines; pure helpers exported, dataset I/O guarded |
| `scripts/state-region-tz.ts` | 51-row STATE_REGION_TZ + ADMIN1_TO_POSTAL | ✓ VERIFIED | 111 lines; const present |
| `packages/simulation/src/network/centers.ts` | pickRegionalCenters/assignSpokes/buildBackbone/anti-SPOF + deriveCenterPartition | ✓ VERIFIED | 360 lines; all substantive, pure, reuse haversineKm |
| `packages/simulation/src/network/hubs.ts` | generateBigCityHubs() reading committed JSON | ✓ VERIFIED | readFileSync + structural guard; runtime-isolated |
| `packages/simulation/src/network/routes.ts` | Multi-center buildRoutes (optional topology, legacy byte-identical) | ✓ VERIFIED | 414 lines; centerOf model; legacy deep-equal |
| `packages/simulation/src/engine.ts` | centerOf(spoke) flow behind continentalTopology (strict === true) | ✓ VERIFIED | Flag gate L714; generateBigCityHubs/pickRegionalCenters/assignSpokes/buildBackbone wired; backbone hop in arriveConsolidationAtCenter |
| `packages/simulation/src/network/center-partition.snapshot.json` | Empirical decision + checksummed partition | ✓ VERIFIED | centerCount=6, both checksums, antiSpof=true, 86 assignments |
| `packages/projections/src/runner/inline.ts` | Key-scoped applyHubInventory | ✓ VERIFIED | affectedHubInventory + WHERE hub_id IN + JSONB ?\| ; upsert-empty-rows (golden-safe) |
| `packages/optimizer/src/rolling/scope.ts` | Per-center scope partition | ⚠️ ORPHANED | partitionScopeByCenter substantive + tested, but not invoked by any epoch consumer (WARNING / deferred to Phase 26) |
| `packages/simulation/test/determinism.unit.test.ts` | DET-01 two-part gate + 10k golden | ✓ VERIFIED | 21/21 pass (ran) |
| `packages/simulation/test/continental-determinism.unit.test.ts` | New continental golden (repro-first) | ✓ VERIFIED | 7/7 pass; 8f91b13f… |
| `packages/simulation/test/hub-dataset-drift.unit.test.ts` | Dataset + partition drift guard | ✓ VERIFIED | 12/12 pass |
| `packages/projections/test/hub-inventory-cost.unit.test.ts` | Per-event cost test (10===100) | ✓ VERIFIED | 3/3 pass (ran) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| engine freight flow | centerOf(spokeHubId) | per-spoke center lookup replacing const center=hubs[0] | ✓ WIRED | engine.ts L811 resolver; consumed L1148/1232/1313/1585/1743; OFF ⇒ hubs[0] |
| generateBigCityHubs | us-big-cities.generated.json | readFileSync of committed JSON (no runtime city-data dep) | ✓ WIRED | hubs.ts L83/129; isolation clean |
| applyHubInventory | hub_inventory (scoped read) | WHERE hub_id IN (touched) + JSONB ?\| placement lookup | ✓ WIRED | inline.ts L533 + L489; registered in appliers (L840) |
| assignSpokesToNearestCenter | haversineKm (@mm/domain) | great-circle nearest + leg cap + id tie-break | ✓ WIRED | centers.ts L167 |
| determinism.unit.test.ts | 3920accc… | continentalTopology absent + explicit-false both hash to golden | ✓ WIRED | test L275/284 (ran green) |
| center-partition.snapshot.json | pickRegionalCenters chosen count | committed empirical decision asserted by drift guard | ✓ WIRED | snapshot centerCount=6; hub-dataset-drift re-derives 883c337b |
| detectAffectedScope | per-center partition | partition affected hubs by owning center | ⚠️ PARTIAL | partitionScopeByCenter implemented + tested + re-exported, but NO production consumer calls it (deferred to Phase 26) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Built loader reads dataset | `import dist/network/hubs.js → generateBigCityHubs()` | 92 hubs | ✓ PASS |
| Dataset copied into dist (23-05 fix) | `ls dist/network/us-big-cities.generated.json` | present (22832 B) | ✓ PASS |
| Continental flag re-routes | `simulate({seed:42, continentalTopology:true})` vs legacy | 92 hubs / 202 routes vs 10 hubs / 18 routes; streams differ | ✓ PASS |
| Dataset envelope/dedup/cap | node inspection of committed JSON | 0 out-of-env, 1–3/state, 92 unique ids | ✓ PASS |
| Partition never single-primary | snapshot assignment distinct centers | 6 distinct centers over 86 spokes | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes are declared for this phase; verification is via the vitest determinism/golden/cost suites (run above). N/A.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| HUB-01 | 23-01, 23-05 | Dev-only generator → committed checksummed JSON; runtime imports only JSON | ✓ SATISFIED | generate-hubs.ts + committed JSON (66ec8b81); runtime isolation clean; drift guard |
| HUB-02 | 23-01 | 1–3 hubs/state by population, ~80–130, static | ✓ SATISFIED | 92 hubs, 1–3/state cap respected, no clock/RNG (REQUIREMENTS.md checkbox stale — see INFO) |
| HUB-03 | 23-01 | Cross-state metros de-duped to single hub, within envelope | ✓ SATISFIED | 40km dedupe (NYC/NJ, KC KS/MO); 92 in [80,130]; 0 out-of-env (checkbox stale) |
| HUB-04 | 23-03 | Attribution (GeoNames CC BY 4.0) in README/UI | ✓ SATISFIED | README L163-170 + MapView.tsx L183-190 |
| NET-01 | 23-04 | Engine supports >1 center; buildRoutes off USA_HUBS[0] → centerOf | ✓ SATISFIED | optional topology arg; legacy deep-equal; continental 202 routes |
| NET-02 | 23-03, 23-05 | Auto-select centers by corridor+timezone; count parameterized; chosen empirically | ✓ SATISFIED | pickRegionalCenters param; EMPIRICAL_CENTER_COUNT=6 from real run + snapshot |
| NET-03 | 23-03 | Nearest-center tie-break by stable id under leg cap | ✓ SATISFIED | assignSpokesToNearestCenter; 6dp + id tie-break + 2500km cap |
| NET-04 | 23-03 | Near-full-mesh backbone, ≤2-hop, anti-SPOF | ✓ SATISFIED | buildBackbone n·(n-1) + isConnectedWithoutAnyCenter (mesh true / star false) |
| NET-05 | 23-04 | Freight spoke→center→backbone→center→spoke; detectAffectedScope per-center partition | ⚠️ PARTIAL | Freight flow wired (backbone hop). Partition fn delivered + tested but ORPHANED — not invoked by a live epoch (WARNING; deferred Phase 26) |
| PERF-01 | 23-02 | applyHubInventory key-scoped (P1-BLOCKING); 10===100 cost test | ✓ SATISFIED | key-scoped applier; cost test 3/3 green (checkbox stale) |
| DET-01 | 23-04, 23-05 | Flag-gated two-part gate; buildRoutes identical Route[] for legacy | ✓ SATISFIED | determinism 21/21 incl. continentalTopology gate; legacy Route[] deep-equal |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER in any Phase-23 changed file | — | Clean |
| packages/projections/src/runner/inline.ts | 514 | JSDoc says "DELETE hubs the fold emptied" but impl upserts empty rows (L586-605) | ℹ️ Info | Cosmetic stale doc; behavior correct + golden-safe (guarded by rebuild-equivalence test) |
| packages/optimizer/src/rolling/scope.ts | 164 | partitionScopeByCenter exists + tested but no production consumer | ⚠️ Warning | NET-05 scaling capability not yet active in a live epoch; planned deferral to Phase 26 |
| vendor/async-queue/* | — | 16 ESLint parser errors (out-of-scope submodule, Phase 27) | ℹ️ Info | Pre-existing; zero Phase-23 commits touch vendor/; Phase-23 files lint clean |

### Human Verification Required

#### 1. Continental map render + attribution footer (SC#1)

**Test:** Start the demo with `continentalTopology` enabled and open the live USA map.
**Expected:** ~92 big-city hubs render across the lower-48 (1–3 per state); the 6 regional centers + the near-full-mesh backbone are visually distinguishable; the on-map OpenLayers attribution control shows "City data © GeoNames, CC BY 4.0" next to the OSM credit.
**Why human:** Map rendering and on-map footer visibility cannot be asserted programmatically. The engine is proven to register 92 hubs / 202 routes under the flag, and the attribution string is wired into the OSM source `attributions`, but the actual visual render is a UI behavior. (Note: Phase 23 is a "baseline render" only; clustering/declutter scale-viz is Phase 27.)

#### 2. Real-DB golden-replay (PERF-01 rebuild-equivalence at the integration level)

**Test:** Run `packages/api/test/projections-golden-replay.int.test.ts` (and the projections idempotency int test) on an **internal disk**, not the `/Volumes/Unitek-B` external mount.
**Expected:** live-twin == rebuilt-from-log twin byte-identical (FND-04), confirming the key-scoped `applyHubInventory` empty-row persistence matches a rebuild-from-0.
**Why human:** From this external-drive tree the test TIMED OUT at 120s/test (a documented `external-drive-skews-db-test-timeouts` issue — it connected to Postgres and ran, it did NOT assertion-fail). The unit-level rebuild-equivalence (`hub-inventory-cost.unit.test.ts`, 3/3 green) is the authoritative correctness witness; the int-level confirmation needs an internal-disk run.

### Gaps Summary

**No BLOCKERS.** All 5 ROADMAP success criteria are achieved in code and proven by tests I executed myself (determinism 21/21 incl. the 3920accc golden + continentalTopology two-part gate; cost test 3/3 proving 10===100; topology/golden/drift 77; full unit suites 670 green; root typecheck exit 0; build green; dataset copied to dist; built loader + flagged engine genuinely produce 92 hubs / 202 routes). The committed dataset, checksums, empirical-center-count snapshot, and runtime isolation are all real and substantive.

**One WARNING (not a gap):** `partitionScopeByCenter` (the NET-05 per-center scope partition) is committed-but-dark — the function is real, exported, and proven hub-count-independent by a 500-hub scope-size-invariant test, but no production epoch consumer calls it (epoch.ts / rolling-service.ts / live-loop.ts still use the flat `detectAffectedScope`). This is consistent with the 23-04 PLAN's Task-3 done-condition (function + disjoint/scope-size tests, not loop wiring) and is the substrate Phase 26 consumes (coordinators calling a scoped runEpoch with the global RollingLoop disabled). Phase 24/26 planners should wire it.

**Status human_needed** because two must-haves have a human-only verification facet (the continental map render + footer for SC#1, and the real-DB golden-replay confirmation for SC#4 that times out from the external drive). All programmatically-checkable evidence passes.

---

_Verified: 2026-06-26T12:32:00Z_
_Verifier: Claude (gsd-verifier)_
