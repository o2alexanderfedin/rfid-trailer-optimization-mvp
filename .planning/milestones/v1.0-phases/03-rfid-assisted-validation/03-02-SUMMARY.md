# Plan 03-02 Summary — Sensor fusion (pure) `@mm/sensor-fusion`

**Requirements:** SNS-01 (confidence-scored RSSI→likelihood), SNS-03 (Bayesian zone estimate)
**Type:** TDD · **Status:** complete · **Module:** new PURE package `@mm/sensor-fusion` (imports ONLY `@mm/domain`)

## What this plan delivers

The OBSERVED-evidence engine of the two-layer (planned vs observed) Phase-3 design, and the home of the
anti-P5b defense. A pure, deterministic pipeline: raw reads → dwell-windowed observations → Bayesian zone
posterior → a §8.4 `ZoneEstimate`. No wall clock, no RNG; same input ⇒ same output.

## Exported surface (Plan 04 detection + Plan 05 read model build against these)

### Types
- `Zone = "rear" | "middle" | "nose"` — 3-zone discriminant, defined LOCALLY (no `@mm/load-planner` dep). `ZONES` is the canonical rear→nose order.
- `ReaderType = "dock-portal" | "trailer-antenna"` — reliability classes.
- `ZoneDistribution = Readonly<Record<Zone, number>>` — a normalized belief over zones.
- `ZoneTransitionMatrix = Readonly<Record<Zone, ZoneDistribution>>` — the row-stochastic Markov prior.
- `FusionConfig` — all tunables (see below); `DEFAULT_FUSION_CONFIG` is the documented default.
- `RfidRead` — a raw read: `@mm/domain.RfidObserved` payload fields (`tagId, readerId, antennaId, rssi, trailerId, hubId`) PLUS engine metadata the domain envelope keeps at persistence: `readerType`, `dwellWindowId`, EXPLICIT `observedAt` (ISO-8601 — no clock read), `perReadConfidence`.
- `WindowedObservation` — `{ tagId, readerId, dwellWindowId, antennaId, trailerId, hubId, readerType, aggregatedRssi, readCount, lastObservedAt }` — ONE per dwell group.
- `FusionInput` — `{ packageId, prior: ZoneDistribution, trailerId?, lastReliableCheckpoint?, lastObservedAt? }`.
- `ZoneEstimate` (spec §8.4) — `{ packageId, trailerId, estimatedZone: Zone, confidence: number, posterior: ZoneDistribution, lastReliableCheckpoint: string | null, lastObservedAt: string }`. `confidence` is STRICTLY `< 1.0` and `<= confidenceCeiling`.

### Functions
- `rssiToLikelihood(rssi: number, readerType: ReaderType, config: FusionConfig): number` — monotonic non-decreasing clamped ramp, reader-type weighted, capped in `[minLikelihood, maxLikelihood]` (default `[0.05, 0.85]`). A single strong RSSI can never reach 1.0 (SNS-01).
- `windowObservations(reads: readonly RfidRead[], config: FusionConfig): readonly WindowedObservation[]` — collapses each `(tagId, readerId, dwellWindowId)` group into ONE observation; `aggregatedRssi` = the `config.aggregationPercentile`-th percentile (default 90th, NOT the mean — multipath drops skew the mean); `readCount` = read-rate density; output is DETERMINISTIC, key-sorted (anti-P5b dwell collapse).
- `fuseZone(input: FusionInput, windowedObs: readonly WindowedObservation[], config: FusionConfig): ZoneEstimate` — per observation: Markov transition prior → capped, density-weighted per-zone likelihood → Bayesian update → normalize → entropy-floor blend. ONE update per window. Empty obs ⇒ the prior-derived estimate unchanged (SNS-03).
- `percentile(values, p)` — the robust linear-interpolation percentile helper (exported for reuse/testing).

## `DEFAULT_FUSION_CONFIG` (concrete params, straight from the Google AI Mode consult)
- `maxLikelihood: 0.85`, `minLikelihood: 0.05` — the per-read likelihood CAP / floor (anti-P5b).
- `entropyFloor: 0.02` — within the prescribed 1–5% band; blends uniform uncertainty each step so no zone ever reaches 1.0.
- `aggregationPercentile: 90`, RSSI band `[-90, -45] dBm`, `readCountSaturation: 40`.
- `readerTypeWeights: { "dock-portal": 1.0, "trailer-antenna": 0.7 }`.
- `zoneTransition` — Markov matrix with near-zero (`transitionFloor: 0.002`) mass on impossible rear↔nose jumps.
- `confidenceCeiling = (1 - entropyFloor) + entropyFloor/3 ≈ 0.9867` — the hard upper bound the posterior can never exceed.
- `readerZoneEvidence: {}` — caller maps `readerId → Zone`; unmapped readers contribute diffuse evidence.

## Anti-P5b keystone (`test/confidence-cap.keystone.test.ts`) — proven behavior
- N = 1, 5, 20, 100, 100000 identical strong same-tag/same-dwell reads ALL collapse to ONE window ⇒ identical fused confidence **0.830** (governed by `maxLikelihood`). Confidence does NOT climb with N.
- Even the pathological double-count path (100 separate windows) is bounded at **0.962 ≤ ceiling 0.987 < 1.0** by the entropy floor — belt-and-suspenders.
- The collapse is load-bearing: the correct single-window confidence is strictly less than the naive double-count.

## Gates (all green)
- `pnpm install`, turbo `pnpm build` (9 pkgs, no cycles), `pnpm -r build`, `pnpm lint`, `pnpm test:all` (368 tests, incl. real-Postgres integration via Testcontainers/OrbStack).
- Purity audit: no `Date.now`/`Math.random` in src or test; no `any`; only `@mm/domain` workspace dep (downward-only).
- 24 new sensor-fusion tests; all prior phase tests remain green.

## Integration into `feature/phase-3-rfid-assisted-validation`

- **Winner:** rival #1 (`wt/p3-02-r1`), source sha `ec6e1a7ac764704558b0b5456852ff804ab815f2`. Merged `--no-ff` (merge commit `a79f9e1`). No conflicts; clean recursive merge.
- **Shipped:** new pure package `@mm/sensor-fusion` (`rssiToLikelihood`, `windowObservations`, `fuseZone`, `percentile`, `ZoneEstimate` §8.4) satisfying **SNS-01** (confidence-scored RSSI→likelihood, single read can never reach 1.0) and **SNS-03** (Bayesian zone estimate, empty observations ⇒ prior-derived estimate). Registered in `tsconfig.eslint.json` path map and `pnpm-lock.yaml`.
- **Post-merge gate results (re-verified at integration, ALL GREEN):**
  - `pnpm install` — lockfile up to date, clean.
  - `pnpm build` (turbo) — 9/9 tasks, FULL TURBO, no cycles.
  - `pnpm -r build` — all 9 packages Done incl. `@mm/sensor-fusion`.
  - `pnpm lint` — clean (eslint, no warnings).
  - `pnpm test:all` — **368/368 tests passed across 46 files** (incl. Testcontainers/OrbStack Postgres integration).
  - No merge-only breakage; no test weakened.
- **Pushed:** `origin/feature/phase-3-rfid-assisted-validation` at `a79f9e1`.
- **Cleanup:** rival worktrees `p3-02-r1`/`p3-02-r2` removed + pruned; branches `wt/p3-02-r1`/`wt/p3-02-r2` deleted.

### Carried risks (from judge; narrow win over rival #2)
- **Narrow margin (criterion-weighting sensitivity):** both rivals were production-quality and fully green. A different weighting of architecture (criterion 4) over keystone-faithfulness could have favored R2.
- **YAGNI smell (LOW):** `RfidRead.perReadConfidence` is defined and carried through but never consumed by the engine. Candidate for removal or wiring-in.
- **Faithfulness gap (LOW):** `lastReliableCheckpoint` is only passed through from the caller, not derived from observations. The plan hints at deriving it; rival #2 did derive it. Consider deriving it in a follow-up if Plan 04/05 needs it.
- **Adapter-seam coupling (watch for Plans 04/05):** R1 uses indexed-access type coupling in `window.ts` rather than R2's single `@mm/domain` import point. If downstream integration weight rises, reconsider the seam. R2's clamp-to-0.85 / shrink-to-0.5 design was more conservative for downstream consumers but deviated from the plan's literal "confidence = posterior probability" / "floor = minLikelihood" wording.
- **Anti-P5b guarantee is safe either way:** both keystones verified to hold at N=100,000 — the core anti-double-count defense holds regardless of which rival shipped.
