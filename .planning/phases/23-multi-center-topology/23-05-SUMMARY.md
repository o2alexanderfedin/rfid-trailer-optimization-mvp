---
phase: 23-multi-center-topology
plan: 05
subsystem: simulation
tags: [determinism, golden, continental-topology, center-count, drift-guard, checksum, anti-spof, det-01, tdd]

# Dependency graph
requires:
  - phase: 23 (plan 01)
    provides: "committed us-big-cities.generated.json — 92 continental big-city hubs + hubsChecksum=66ec8b81"
  - phase: 23 (plan 03)
    provides: "pure topology fns — pickRegionalCenters / assignSpokesToNearestCenter / buildBackbone / isConnectedWithoutAnyCenter; generateBigCityHubs"
  - phase: 23 (plan 04)
    provides: "continentalTopology flag + centerOf(spoke) engine flow + buildRoutes(topology) generalization (legacy byte-identical when off)"
provides:
  - "EMPIRICAL_CENTER_COUNT=6 — the empirically-chosen regional-center count (NET-02), recorded in a committed checksummed partition snapshot"
  - "center-partition.snapshot.json — chosen count + rationale + center ids + spoke->center map + backbone leg ids + antiSpof + hubsChecksum + partitionChecksum"
  - "deriveCenterPartition() + partitionChecksum() — pure re-derivation helpers (shared by snapshot + drift guard)"
  - "DET-01 two-part flags-off gate for continentalTopology (false===absent AND absent=>3920accc 10k golden)"
  - "new continental golden 8f91b13f... on a fixed 14-hub fixture (reproducibility-first, T-23-12)"
  - "dataset + partition drift guard (hub-dataset-drift.unit.test.ts) — any data/partition change is a red test"
affects: [24-28 (read this topology + the committed center count/partition + the determinism keystone)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reproducibility-FIRST golden capture: assert two in-process derivations hash identically BEFORE asserting the committed hash (never bake a non-reproducible flake, T-23-12)"
    - "Committed checksummed decision snapshot + a drift-guard test re-deriving its checksum (mirrors the road-geometry hub-checksum drift guard) — a silent re-route becomes a visible red diff"
    - "Single pure re-derivation helper (deriveCenterPartition) shared by the snapshot generator AND the drift guard so the committed artifact is provably reproducible"
    - "Empirical parameter chosen from a real run over committed metrics, then recorded with rationale — auditable, not guessed"

key-files:
  created:
    - packages/simulation/src/network/center-partition.snapshot.json
    - packages/simulation/test/hub-dataset-drift.unit.test.ts
    - packages/simulation/test/continental-determinism.unit.test.ts
  modified:
    - packages/simulation/src/network/centers.ts
    - packages/simulation/test/determinism.unit.test.ts
    - packages/simulation/scripts/copy-assets.mjs

key-decisions:
  - "Center count = 6 (option centers-6, the research default) chosen empirically from a real continental run (seed 1234, 6000 ticks, induction+consolidation) over the 92-hub dataset: best fan-out balance (max 22/center, spread 13 vs 27 at 4/5), cheap mesh (30 directed legs), every spoke->center leg under the 2500km cap (max 1545km, 0 orphans), anti-SPOF passes, avoids the thin 1-4-spoke centers at 7/8"
  - "The new continental golden hashes the deterministic continental TOPOLOGY ARTIFACT (centers+assignment+backbone+Route[]+transit) over a fixed 14-hub fixture — NOT a full 92-hub simulate run (the perf concern CONTEXT explicitly defers); fast + reproducible"
  - "deriveCenterPartition is the single re-derivation source of truth for both the committed snapshot AND the drift guard, so the artifact is provably reproducible"
  - "centerCount >= 2 enforced (deriveCenterPartition throws on count<1; clamp in pickRegionalCenters) — the network never collapses to a single primary center"

patterns-established:
  - "Reproducibility-first golden capture (T-23-12 anti-flake)"
  - "Committed decision snapshot + drift-guard re-derivation (T-23-14 supply-chain-of-data integrity)"

requirements-completed: [HUB-01, NET-02, DET-01]

# Metrics
duration: ~70min
completed: 2026-06-26
---

# Phase 23 Plan 05: Determinism Keystone — Empirical Center Count + Continental Golden + Drift Guard Summary

**The Phase-23 determinism keystone: the regional-center count is chosen empirically (6) from a real continental run and recorded in a committed checksummed partition snapshot, the DET-01 two-part flags-off gate proves `continentalTopology:false === absent` AND `absent => the seed-42 10k golden 3920accc...` is byte-identical, the continental model gets its own reproducibility-first golden `8f91b13f...` on a small 14-hub fixture, and a dataset/partition drift guard makes any data or re-route change a red test.**

## Performance

- **Duration:** ~70 min
- **Started:** 2026-06-26 (~12:04Z)
- **Completed:** 2026-06-26
- **Tasks:** 4 + 1 resolved checkpoint (checkpoint:decision — center count, pre-authorized "decide empirically")
- **Files:** 6 (3 created, 3 modified)

## The Resolved Checkpoint — Empirical Center Count (NET-02)

The plan's `checkpoint:decision` (the regional-center count, deliberately deferred to this phase to be chosen empirically) was **pre-authorized** by the user ("let Phase A decide empirically") and resolved **autonomously** from a real continental run over the committed 92-hub dataset (seed 1234, 6000 ticks, `continentalTopology` ON, induction + consolidation ON), measuring candidate counts **4, 5, 6, 7, 8**:

| count | centers | backbone legs (n·(n-1)) | anti-SPOF | fan-out min/med/max (spread) | max spoke→center leg | over-cap (2500km) |
|------:|--------:|------------------------:|:---------:|:----------------------------:|---------------------:|------------------:|
| 4 | LAX, ORD-il, NYC, HOU | 12 | true | 17 / 22 / 27 (10) | 1556 km | 0 |
| 5 | + PHX | 20 | true | 9 / 17 / 27 (18) | 1556 km | 0 |
| **6** | **+ JAX** | **30** | **true** | **9 / 13 / 22 (13)** | **1545 km** | **0** |
| 7 | + Columbus | 42 | true | 4 / 13 / 18 (14) | 1545 km | 0 |
| 8 | + Indianapolis | 56 | true | 1 / 12 / 18 (17) | 1545 km | 0 |

**Chosen: 6 centers** (`az-phoenix, ca-los-angeles, fl-jacksonville, il-chicago, ny-new-york-city, tx-houston`). Rationale:
- **Bounded, balanced fan-out** — max 22 spokes/center (vs 27 at 4/5), the healthiest balance (median 13, spread 13).
- **Cheap near-full mesh** — 30 directed legs, far under the ≤56 (n=8) envelope; ≤2-hop coast-to-coast.
- **Every spoke→center leg well under the 2500 km cap** — max 1545 km, **0 over-cap orphans**.
- **Anti-SPOF passes; never a single primary** (centerCount ≥ 2 enforced).
- **Avoids over-fragmentation** — at 7/8 a thin 1–4-spoke center appears (weak consolidation locality).

Note on the trailer-fill proxy: under the engine's documented over-carry consolidation cadence (at most one held-back package per spoke arrival), spoke-origin consolidation manifests are single-package across **all** counts (fill ≡ 1.00) — so trailer-fill does not discriminate between counts here; the discriminating metrics are fan-out balance, leg length under cap, mesh cost, and anti-fragmentation. The default of 6 is now empirically validated, not merely inherited.

## Accomplishments

- **NET-02 — empirical center count recorded.** `EMPIRICAL_CENTER_COUNT = 6` (engine default = this const), with a one-line rationale comment citing the run metrics, plus a committed `center-partition.snapshot.json` capturing the chosen count, rationale, capture env, the 6 center ids, the full 86-pair spoke→center assignment, the 30 directed backbone leg ids, `antiSpof:true`, `hubsChecksum=66ec8b81`, and `partitionChecksum=883c337b`.
- **HUB-01 / T-23-14 — dataset + partition drift guard.** `hub-dataset-drift.unit.test.ts` re-derives `hubCoordsChecksum(generateBigCityHubs())` (== `66ec8b81`) and `deriveCenterPartition(6)` (== `883c337b` + the exact assignment map / center ids / backbone), re-asserts the HUB-01/02/03 invariants (92 hubs in [80,130], continental envelope, unique ids), and proves the network never collapses to a single primary. **Proven to go RED on a corrupted checksum and GREEN when restored.**
- **DET-01 — two-part flags-off gate (continental).** Added to `determinism.unit.test.ts`: (a) `continentalTopology:false` is byte-identical to the flag being absent (short run + the 10k run), and (b) the flag ABSENT ⇒ the seed-42 10k golden is byte-identical to `3920accc...` — the non-negotiable regression witness that the whole Phase-23 generalization never moved the legacy stream.
- **DET-01 — new continental golden (reproducibility-first).** `continental-determinism.unit.test.ts` hashes the deterministic continental topology artifact over a fixed 14-hub fixture (centerCount=4) to `8f91b13f06e8481b5d80f0beb3c36b9307abad21242bdc1696b8769175db6644`; same-seed reproducibility is asserted BEFORE the golden is checked (T-23-12), the golden ≠ the legacy golden, and a sanity check confirms the full-dataset continental engine stream genuinely differs from the legacy stream.

## Task Commits

Each task was committed atomically:

1. **Checkpoint (resolved autonomously) + Task 1: empirical center count + partition snapshot** — `2a15755` (feat)
2. **Task 2: dataset + partition drift guard** — `615b6b8` (test)
3. **Task 3: DET-01 two-part gate + new continental golden** — `bcb2cca` (test)
4. **Task 4 deviation: copy dataset into dist for built continental consumers** — `567806f` (fix)

**Plan metadata:** (final docs commit — this SUMMARY + STATE + ROADMAP)

_The center-count checkpoint was pre-authorized ("decide empirically") and resolved in Task 1's commit (the snapshot is the resume-signal/decision record). Tasks 2 & 3 are `type=tdd`; both are GREEN-by-construction verification tests against the artifacts committed in Task 1 / the flag landed in 23-04 (see Deviations) — committed as `test`._

## Files Created/Modified

- `packages/simulation/src/network/centers.ts` *(modified)* — `EMPIRICAL_CENTER_COUNT=6` (DEFAULT_CENTER_COUNT now references it), `CenterPartition` interface, `partitionChecksum()` (FNV-1a over the sorted assignment), `deriveCenterPartition()` (the shared pure re-derivation; throws on count<2).
- `packages/simulation/src/network/center-partition.snapshot.json` *(created)* — the committed empirical decision + full checksummed partition.
- `packages/simulation/test/hub-dataset-drift.unit.test.ts` *(created, 12 tests)* — the dataset + partition drift guard.
- `packages/simulation/test/continental-determinism.unit.test.ts` *(created, 7 tests)* — the new continental golden (reproducibility-first) + the continental-vs-legacy sanity.
- `packages/simulation/test/determinism.unit.test.ts` *(modified, +4 tests)* — the two-part `continentalTopology` flags-off gate (false===absent short + 10k; absent=>3920accc 10k).
- `packages/simulation/scripts/copy-assets.mjs` *(modified)* — copies `us-big-cities.generated.json` into `dist/network/` (Rule 2 fix, below).

## Decisions Made

- **Center count = 6** — see "The Resolved Checkpoint" above (empirically validated, recorded in the committed snapshot).
- **The continental golden hashes the topology artifact over a fixed 14-hub fixture, not a full simulate run** — CONTEXT defers the ~92-hub `simulate` golden as a perf concern; the topology artifact (centers + assignment + backbone + Route[] + transit) is the continental model's distinguishing, fast, reproducible output. A separate sanity test asserts the full-dataset continental engine stream differs from the legacy stream.
- **`deriveCenterPartition` is the single re-derivation source of truth** for both the snapshot generator and the drift guard, guaranteeing the committed artifact is reproducible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `us-big-cities.generated.json` was not copied into `dist/` for built continental consumers**
- **Found during:** Task 4 (full phase gate — inspecting the build's `copy-assets` step).
- **Issue:** `copy-assets.mjs` copied only `road-geometry.generated.json` into `dist/network/`. `generateBigCityHubs()` (the continental topology's root data dependency, added in 23-03) reads `us-big-cities.generated.json` relative to the COMPILED module (`dist/network/`). A built consumer enabling `continentalTopology` would throw `"malformed or missing hubs[]"`. Pre-existing gap from 23-03 (the flag is off by default and no built consumer enables it yet — so not a current regression), but Phases 24–28 read this topology, so the built artifact must be self-contained.
- **Fix:** `copy-assets.mjs` now copies BOTH datasets into `dist/network/` after `tsc -b`, completing the committed-asset pattern road-geometry already establishes.
- **Files modified:** `packages/simulation/scripts/copy-assets.mjs`
- **Verification:** Rebuilt; `dist/network/us-big-cities.generated.json` present; `import('./dist/network/hubs.js').generateBigCityHubs()` loads 92 hubs from the built artifact. The `center-partition.snapshot.json` is test-only (read from `src/`) and deliberately NOT copied.
- **Committed in:** `567806f`

### Process note (TDD gate)

Tasks 2 & 3 are declared `type=tdd`, but both are **verification tests against artifacts committed earlier in this plan** (Task 1's snapshot / the 23-04 `continentalTopology` flag), so their natural state is GREEN-by-construction, not RED-then-GREEN. To honor the spirit of the TDD gate, the **drift guard was explicitly proven to FAIL on a corrupted checksum and PASS when restored** (the real guard property), and the **continental golden asserts same-seed reproducibility BEFORE the hash is asserted** (T-23-12 — a non-reproducible hash could never have been baked in). Both are committed as `test`. No production behavior depends on them being RED first; they are guards over already-correct committed data.

---

**Total deviations:** 1 auto-fixed (1 missing-critical, Rule 2).
**Impact on plan:** The fix makes the built `@mm/simulation` artifact self-contained for the continental path (needed by Phases 24–28); no scope creep, no determinism assertion weakened. Every stated acceptance criterion is met.

## Full Phase Gate Results (Task 4)

Run one package at a time (per the v2.1 OOM lesson), cleaning up between:

| Package | build | typecheck | lint | unit tests |
|---------|:-----:|:---------:|:----:|:----------:|
| @mm/simulation | ✅ | ✅ | ✅ | **370 pass** (29 files) |
| @mm/projections | ✅ | ✅ | ✅ | **122 pass** (16 files) |
| @mm/optimizer | ✅ | ✅ | ✅ | **178 pass** (19 files) |
| @mm/web | ✅ (tsc -b + vite build) | ✅ | — | (web lane not in this gate) |

- **typecheck** is a single root `tsc -p tsconfig.eslint.json --noEmit` covering every package incl. `@mm/web` — **exit 0**.
- **Total unit tests:** 670 pass across the three node packages.
- **Keystone tests** (consolidated re-run): `determinism.unit.test.ts` (22) + `continental-determinism.unit.test.ts` (7) + `hub-dataset-drift.unit.test.ts` (12) = **41 pass**.
- No determinism assertion was weakened to pass a gate. The seed-42 10k golden `3920accc...` is byte-identical.

## Issues Encountered

- The repo's vitest projects live in a root config; per-file runs need `pnpm exec vitest run --project unit "<path>"` (the bare `pnpm --filter ... exec vitest run <filter>` form errored on the project matrix). Used the root `--project unit` form throughout.

## Threat Model Coverage

- **T-23-12 (Tampering — a non-reproducible golden baked in):** mitigated — the continental golden asserts same-seed in-process reproducibility BEFORE the committed hash; capture-env note (`x86_64 darwin, node v23`) carried next to the constant.
- **T-23-13 (Tampering — flags-off drift undetected):** mitigated — the DET-01 two-part gate (`continentalTopology:false === absent` AND `absent => 3920accc...`) is in the unit gate; any drift is a red test.
- **T-23-14 (Tampering — silent center-count / partition change):** mitigated — the committed `center-partition.snapshot.json` + the drift-guard test re-deriving both the dataset and partition checksums; proven to go red on a corrupted checksum.

## Known Stubs

None. The center count is a real empirical decision recorded in a committed checksummed snapshot; the goldens are reproducible and committed; the drift guard is wired to the live re-derivation. No placeholder/empty data.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 23 is COMPLETE: the continental multi-center topology is generalized, flag-gated (off by default, byte-identical legacy replay proven), empirically parameterized (6 centers, committed + checksummed), and witnessed by the DET-01 two-part gate + the new continental golden + the drift guard.
- Phases 24–28 read this topology, the committed center count/partition, the per-center scope partition (23-04), and inherit the determinism keystone (the seed-42 golden `3920accc...` is the regression boundary; the continental golden `8f91b13f...` is the continental-model boundary).
- The built `@mm/simulation` artifact is now self-contained for the continental path (the dataset is copied into `dist/`).

## Self-Check: PASSED

---
*Phase: 23-multi-center-topology*
*Completed: 2026-06-26*
