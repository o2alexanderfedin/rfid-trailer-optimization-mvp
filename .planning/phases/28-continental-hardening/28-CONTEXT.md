# Phase 28: Continental Hardening (DET-02) - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning
**Mode:** Infrastructure / determinism-test consolidation (no user-facing behavior — discuss is a grounded scope lock, not a grey-area Q&A)

<domain>
## Phase Boundary

Consolidate the v3.0 determinism guarantees into ONE auditable gate (DET-02). The milestone's keystone —
flags-off byte-identical to `3920accc…`, each new model's own reproducibility-first golden,
agent-order-shuffle, N-agent-RNG-decorrelation, continuation-equivalence — already exists in pieces and is
green. This phase closes the **2 real coverage gaps** and **consolidates the scattered audit** into a
single home, so the keystone is verifiable in one place.

**NO new model, NO golden changes.** All 5 goldens stay byte-identical: `3920accc` (flags-off),
`94689f99` (OODA-on), `edfa5a6d` (coordinator-on/rule-based), `162efbd8` (optimizer-on/divergent),
`8f91b13f` (continental fixture). New tests assert relative equivalence / shuffle-invariance; they do NOT
bake new goldens. Re-verify the flags-off + all on-goldens after every change.

In scope: DET-02. Out of scope: the v3.0 demo go-live (`.planning/v3.0-GO-LIVE.md`, milestone-end);
any new feature.
</domain>

<decisions>
## Implementation Decisions (locked from the determinism-test inventory)

### Gap 1 — Coordinator per-center agent-order-shuffle batch test (GAP-TO-ADD)
- OODA agents already have it (`ooda-determinism.unit.test.ts:49-105`: shuffle/reverse/rotate the per-pass
  agent input → byte-identical sorted batch via `sortAgentsByStableId`). The **coordinator** per-center
  iteration has NO equivalent batch-shuffle test (only a per-center RNG stable-id-keyed property in
  `coordinator.unit.test.ts:109-115`).
- Add a coordinator agent-order-shuffle test mirroring the OODA one: shuffle the per-tick center/coordinator
  set, assert the emitted suggestion batch is byte-identical (the engine already sorts by centerId before
  `stepCoordinators`). Reuse `deriveCoordinatorRng` + the existing sorted-iteration.

### Gap 2 — `continentalTopology` continuation-equivalence (GAP-TO-ADD)
- The 4 existing continuation suites cover v2.0-ALL_ON, OODA-on, coordinator-on, optimizer-on (chunked ==
  all-at-once, chunks 1/7/23/500). **No continuation test drives `continentalTopology: true`** (the only
  uncovered v3.0 flag combo). `continental-determinism.unit.test.ts` only hashes a static topology artifact.
- Add a `continental-continuation.unit.test.ts` mirroring `ooda-continuation.unit.test.ts`: chunked ==
  all-at-once with `continentalTopology: true` ALONE and STACKED with oodaAgents/coordinators/optimizer,
  chunks 1/7/23/500. (Use the continental hub fixture / a seed that exercises cross-center flow.)

### Consolidation — one auditable home + DRY golden constants (the bulk of the phase)
- **Single source of truth for the 5 golden SHAs:** extract them (with their scope + capture provenance)
  into ONE canonical module (e.g. `packages/simulation/test/goldens.ts` or a `det-audit` file) and import
  them everywhere. Removes the duplicated string literals currently copy-pasted across `determinism`,
  `ooda-determinism`, `coordinator-determinism`, `coordinator-optimizer-determinism`,
  `continental-determinism`, and the scattered copies in `coordinator-engine`/`ooda-engine` tests
  (duplication that can silently drift). Tests assert the hash, so a refactor typo fails loudly.
- **Pull `162efbd8` (and `94689f99`/`edfa5a6d`/`8f91b13f`) into the master gate's home** so "all goldens
  audited in ONE place" holds — today `determinism.unit.test.ts` has the two-part flags-off gate for every
  flag but the optimizer divergent golden lives only in its own file.
- **Consolidate the cross-arch capture-env + integer-LUT contingency notes** (currently scattered across 4
  files' inline comments) next to the canonical golden constants — a single documented provenance block
  (x86_64 vs arm64 per golden; the log-normal-sampler → integer-LUT fallback "only if the hash fails on CI").
- Keep the existing two-part flags-off gate (`flag:false===absent` AND `absent⇒3920accc`) for all 4 v3.0
  flags consolidated in the master file; dedupe the redundant copies in `coordinator-engine`/`ooda-engine`.

### Capture protocol script (recommended — Claude's discretion)
- The reproducibility-first protocol (in-process ×2 is codified in tests; the "2 separate node processes"
  half is comment-only) has no reusable script. Add a small committed `scripts/capture-golden.ts` (or
  similar) that runs a scenario in 2 separate node processes + in-process twice and prints/asserts the
  matching SHA — so any future golden recapture is a one-command, protocol-correct step. KISS; ~40 LOC.

### Claude's Discretion
- Exact file names/locations for the new tests + the canonical goldens module + the capture script; whether
  the consolidated audit is a new `det-audit.unit.test.ts` or an extension of `determinism.unit.test.ts`;
  the continental continuation seed/fixture + horizon — at Claude's discretion following the existing
  determinism-test patterns, subject to: NO golden changes, all 5 goldens stay byte-identical, flags-off
  two-part gate intact.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets (from the determinism-test inventory)
- `packages/simulation/test/ooda-determinism.unit.test.ts:49-105` — the agent-order-shuffle template
  (to mirror for coordinators); `:110-149` — N-agent decorrelation (already covers OODA).
- `packages/simulation/test/ooda-continuation.unit.test.ts` — the continuation template (to mirror for
  continental); also `coordinator-continuation` / `coordinator-optimizer-continuation` / `continuation-adversarial`.
- `packages/simulation/test/determinism.unit.test.ts` — the master two-part flags-off gate (L212-492) +
  the canonical `3920accc` + cross-arch/LUT note (L116-122). The consolidation home.
- Golden literals to dedupe: `3920accc` (all 5 files), `94689f99`, `edfa5a6d`, `162efbd8`, `8f91b13f`;
  redundant two-part copies in `coordinator-engine.unit.test.ts` + `ooda-engine.unit.test.ts`.
- `sortAgentsByStableId` (`engine.ts:1986`), `deriveCoordinatorRng` (`coordinator/rng.ts`),
  `deriveAgentRng` (`ooda/rng.ts`) — the determinism primitives the new tests exercise.

### Established Patterns
- Reproducibility-first capture (in-process ×2 + 2 node processes BEFORE baking); relative chunked==all-at-once
  continuation; shuffle-invariant sorted batch; two-part flags-off gate per flag; canonicalized hashed payloads.

### Integration Points
- New `continental-continuation.unit.test.ts` + a coordinator agent-order-shuffle test (in or beside
  `coordinator-determinism.unit.test.ts`); a canonical `goldens.ts` imported by all det test files; an
  optional `scripts/capture-golden.ts`. No production-code changes expected (test/consolidation only).
</code_context>

<specifics>
## Specific Ideas
- This is the milestone's keystone closeout: after it, the whole v3.0 determinism story is one green,
  auditable gate. Net-new work is intentionally tiny (2 tests + 1 DRY consolidation + 1 small script) —
  the inventory proved most of DET-02 already exists and is green.
- Suggested plan grouping: (1) coordinator agent-order-shuffle test; (2) continental continuation test;
  (3) consolidate goldens + provenance + dedupe two-part copies (the DRY refactor); (4) optional capture
  script. All independent except (3) touches the files the others live in — sequence (3) last or first
  deliberately to avoid churn.

## Deferred Ideas
- v3.0 demo go-live (wire flags into the live driver + smoke-test) → `.planning/v3.0-GO-LIVE.md` (milestone end).
- Standalone cross-arch CI matrix (actually running goldens on x86_64 AND arm64 in CI) → future; v3.0 ships
  the documented LUT contingency, not a live cross-arch CI job.
</specifics>

<deferred>
## Deferred Ideas
See <specifics> "Deferred Ideas" — v3.0 demo go-live (`.planning/v3.0-GO-LIVE.md`) and a standalone
cross-arch CI matrix.
</deferred>
