---
phase: 25-coordination-centers
plan: 03
subsystem: simulation
tags: [event-sourcing, coordination, handshake, feasibility, determinism, alert-feed, audit-timeline, demo-moment]

# Dependency graph
requires:
  - phase: 25-coordination-centers (plan 01)
    provides: "ActionSuggested/SuggestionAccepted/SuggestionRejected closed-union events + the hos|fuel|dock|infeasible reasonCode enum + scope-neutral classification"
  - phase: 25-coordination-centers (plan 02)
    provides: "pendingSuggestionsByTarget populated in the stepCoordinators pass one queue-seq BEFORE stepAgents at a shared tick (the same-tick handshake precondition); CoordinatorSuggestion union"
  - phase: 24-ooda-step-agents (plan 03)
    provides: "truckLegFeasibility/hubDockFeasibility — the agent's binding local feasibility verdict (the un-overridable accept/reject basis); canonicalizeOodaPayload; the stepAgents DECIDE+ACT loop + the existing binding events (TrailerDiverted / dispatchHubConsolidation)"
provides:
  - "arbitrateSuggestion — the PURE accept/reject contract: maps (suggestion, feasibility verdict) -> accept(+bindingKind) | reject(reasonCode) on the closed enum; HOS>fuel>dock priority; hold always feasible (COORD-05 substrate)"
  - "the same-tick handshake in stepAgents: each agent drains pendingSuggestionsByTarget, arbitrates against its OWN verdict, emits SuggestionAccepted + the EXISTING binding event | SuggestionRejected + reasonCode; an accepted suggestion suppresses the autonomous Act (no double-emit)"
  - "COORD-03 reject-with-reason surfacing: SuggestionRejected folds into the exception/alert feed (coordination-rejected kind, human label) AND the audit timeline (reasonCode + captured rationale) — the headline smart-and-honest demo moment"
affects: [25-04 anti-oscillation guards (build on this raw accept/reject handshake), 25-05 coordinator-on golden + continuation serialization]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pure arbitration leaf (handshake.ts) that READS the agent's authoritative feasibility verdict and never recomputes it — the un-overridable contract (24-03) expressed as a total function"
    - "same-tick drain-arbitrate-act-clear handshake hooked into the existing agent DECIDE+ACT loop; accepted-suggestion precedence over the autonomous Act (deterministic, no double-emit)"
    - "reuse the existing exception/alert feed + audit timeline for a new event class by widening ExceptionKind / AuditTimelineEntry with null-defaulted optional-style fields, mapping the new kind onto an existing wire kind (no new UI panel, no DB migration)"

key-files:
  created:
    - packages/simulation/src/coordinator/handshake.ts
    - packages/simulation/src/coordinator/handshake.unit.test.ts
  modified:
    - packages/simulation/src/coordinator/index.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/test/coordinator-engine.unit.test.ts
    - packages/projections/src/reducers/exceptions.ts
    - packages/projections/test/exceptions.unit.test.ts
    - packages/projections/src/reducers/audit-timeline.ts
    - packages/projections/src/reducers/audit-timeline.test.ts
    - packages/projections/src/reducers/index.ts
    - packages/projections/src/index.ts
    - packages/projections/src/runner/inline.ts
    - packages/projections/src/runner/catchup.ts
    - packages/api/src/ws/snapshots.ts
    - packages/api/src/ws/exception-mapping.test.ts
    - packages/api/src/routes/exceptions.ts
    - packages/api/src/kpis/compute-kpis.test.ts

key-decisions:
  - "arbitrateSuggestion is a PURE leaf that READS the agent's feasibility verdict (never recomputes) — the un-overridable contract; HOS>fuel for reroute, dock for consolidate/dispatch, hold ALWAYS accepted (bindingKind none — the COORD-05 feasible no-op substrate)"
  - "precedence: an ACCEPTED suggestion suppresses the agent's autonomous Act that tick (deterministic, witnessed by the at-most-one-TrailerDiverted-per-(trailer,instant) test, T-25-12); a REJECT does NOT suppress (the truck still rests/refuels autonomously)"
  - "the handshake drains BEFORE the autonomous anything-to-decide guard so a hub/truck with nothing autonomous to do still consumes + honestly rejects/accepts a coordinator advice; pending entry deleted after consumption (within-tick lifecycle)"
  - "an accepted reroute REUSES the exact TrailerDiverted construction (+canonicalizeOodaPayload) with reason 'next-hub-congested'; accepted consolidate/dispatch route through the existing dispatchHubConsolidation; hold emits SuggestionAccepted but no binding event — NO new binding path (the must-have)"
  - "SuggestionRejected severity = warning (NOT info) so a coordination reject — an HONEST decline, not a low-confidence detection fault — never inflates the false-positive-rate numerator (lowConfidenceExceptions counts only info detections); it DOES appear in totalExceptions + the feed"
  - "coordination-rejected ExceptionKind keyed by suggestionId (coordinationRejectId); closed reasonCode->label map (won't divert: HOS / won't divert: fuel / won't dispatch: dock full / declined: infeasible)"
  - "COORD-03 reuses the existing feed + timeline with NO new UI panel: the api ws layer maps coordination-rejected -> the existing blockedFreight wire kind, surfacing the label as the alert reason; no new wire enum, no frontend change"
  - "the rich reject-correlation fields (reasonCode/suggestionId/label) are an in-memory reducer enrichment this plan — NO DB migration; the DB-backed inline/catchup read paths set them null (the persisted row carries kind + recommended_action=label), the live event-stream/ws demo path carries full fidelity"

patterns-established:
  - "widening a closed projection type (ExceptionKind / OpenException / AuditTimelineEntry) cascades through pnpm typecheck to every DB runner + api consumer — the exhaustiveness gate surfaces them; fix the read paths to null-default and the write paths to persist via existing columns (no migration)"

requirements-completed: [COORD-02, COORD-03]

# Metrics
duration: 18min
completed: 2026-06-27
---

# Phase 25 Plan 03: Same-Tick Accept/Reject Handshake + Visible Reject-With-Reason Summary

**The same-tick accept/reject HANDSHAKE (COORD-02 consume half) — each agent drains `pendingSuggestionsByTarget`, arbitrates each coordinator suggestion against its OWN binding feasibility verdict (24-03) via the pure `arbitrateSuggestion` (accept → `SuggestionAccepted` + the EXISTING binding event / reject → `SuggestionRejected` + reasonCode) — plus the visible REJECT-WITH-REASON (COORD-03) surfaced in the existing alert/exception feed AND audit timeline ("won't divert: HOS/fuel"), the headline smart-and-honest demo moment; flag-off golden still `3920accc…`.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-06-27T00:29:34Z
- **Completed:** 2026-06-27T00:47:08Z
- **Tasks:** 3 (Task 1 + Task 3 TDD RED→GREEN; Task 2 wiring with co-authored integration assertions)
- **Files modified:** 17 (2 created, 15 modified)

## Accomplishments

- **`arbitrateSuggestion` — the un-overridable feasibility contract as a pure function (Task 1).** It maps a `(suggestion, verdict)` pair to `{ accepted:true, bindingKind }` | `{ accepted:false, reasonCode }` on the closed `hos|fuel|dock|infeasible` enum. It READS the agent's authoritative verdict (24-03) and NEVER recomputes feasibility — a coordinator cannot force an infeasible action. Priority mirrors the 24-03 ladder: HOS (`mustRest`/`!canDrive`) outranks fuel (`mustRefuel`) for a reroute; the dock verdict gates consolidate/dispatch; a `hold` is ALWAYS accepted (the COORD-05 feasible no-op substrate). 11 unit tests (incl. the HOS>fuel priority + closed-enum + purity properties).
- **The same-tick handshake wired into `stepAgents` (Task 2, COORD-02 consume half).** For each agent (truck and hub), the engine computes the agent's own binding verdict (`truckLegFeasibility`/`hubDockFeasibility`, the SAME shared HOS limits + fuel threshold + frozen virtual clock the autonomous Decide uses), drains `pendingSuggestionsByTarget.get(stableId)` in its stable-ordered list, and for each arbitrates → emits `SuggestionAccepted` + the EXISTING binding event (reroute → `TrailerDiverted` via `canonicalizeOodaPayload`; consolidate/dispatch → `dispatchHubConsolidation`; hold → no binding event) OR `SuggestionRejected` + reasonCode, on the agent's OWN stream. The pending entry is cleared after consumption.
- **No double-emit; deterministic precedence (T-25-12).** An ACCEPTED suggestion suppresses the agent's autonomous Act that tick (the suggestion-driven Act replaces it); a REJECT leaves the autonomous Act intact (an HOS-out truck still rests). Witnessed by the at-most-one-`TrailerDiverted`-per-`(trailer, instant)` integration assertion.
- **Visible reject-with-reason — the demo moment (Task 3, COORD-03).** `SuggestionRejected` now folds into the exception/alert feed as a `coordination-rejected` row carrying `{ reasonCode, suggestionId, label }` (closed label map: "won't divert: HOS" / "won't divert: fuel" / "won't dispatch: dock full" / "declined: infeasible"), AND into the audit timeline as a row carrying the reasonCode + captured rationale (anti-repudiation T-25-11). `SuggestionAccepted` + `ActionSuggested` stay no-ops in the feed; `ActionSuggested` stays a no-op in the timeline.
- **False-positive-rate semantics preserved.** A coordination reject is an HONEST decline, not a low-confidence detection — severity `warning` (not `info`), so it never enters the `lowConfidenceExceptions` numerator. The detection FP-rate is provably unchanged when rejects are mixed into the feed (a first-class test).
- **Determinism keystone HELD.** Flag-off seed-42 10k golden byte-identical to `3920accc…`; OODA-on golden `94689f99…` unchanged; the coordinator-on run is reproducible (same seed twice ⇒ byte-identical). All `occurredAt` from the virtual clock (no `Date.now`); accept/reject payloads carry only ids + the closed enum (no new hashed-payload canonicalizer needed). Under the natural all-on stack (seed 42 / 6000 ticks) the engine consumes all 10,372 suggestions: **9,374 accepted + 998 rejected** (all `dock` rejects in this scenario).

## Task Commits

1. **Task 1 (TDD): pure `arbitrateSuggestion`** — `e8eaaa1` (feat) — 11 unit tests GREEN; typecheck clean
2. **Task 2: wire the same-tick handshake into `stepAgents`** — `9312ed5` (feat) — 18 integration tests GREEN (7 new handshake assertions); flag-off golden unchanged; same-seed byte-identical; typecheck clean
3. **Task 3 (TDD): COORD-03 reject-with-reason surfacing in the feed + audit timeline** — `cf778fe` (feat) — 57 reducer+api tests GREEN; typecheck + lint clean

_Note: Tasks 1 and 3 followed RED (a failing test proven) → GREEN. Task 2 is engine wiring with co-authored integration assertions, committed at GREEN._

## Files Created/Modified

**Created:**
- `packages/simulation/src/coordinator/handshake.ts` — `arbitrateSuggestion` + `SuggestionArbitration`/`SuggestionBindingKind`/`SuggestionRejectReason` (the pure un-overridable contract)
- `packages/simulation/src/coordinator/handshake.unit.test.ts` — 11 tests (per-kind × verdict, HOS>fuel priority, closed enum, purity)

**Modified:**
- `packages/simulation/src/coordinator/index.ts` — export the handshake surface
- `packages/simulation/src/engine.ts` — the same-tick drain/arbitrate/act/clear handshake in `stepAgents` (truck + hub branches); `emitSuggestionAccepted`/`emitSuggestionRejected`; `suggestedToCoordinatorSuggestion` + `emitAcceptedDivert` adapters; `truckLegFeasibility`/`hubDockFeasibility`/`arbitrateSuggestion` imports
- `packages/simulation/test/coordinator-engine.unit.test.ts` — 7 new handshake assertions (consume-all, accept/reject mix, closed reasonCode, target-stream + validateEvent, suggestionId correlation, no-double-emit, same-seed byte-identical)
- `packages/projections/src/reducers/exceptions.ts` — `coordination-rejected` kind + `coordinationRejectId` + `COORDINATION_REJECT_LABELS` + the `SuggestionRejected` fold; `OpenException` gains `reasonCode`/`suggestionId`/`label`
- `packages/projections/src/reducers/audit-timeline.ts` — `SuggestionRejected`/`SuggestionAccepted` row builders + render fns; `AuditTimelineEntry` gains `reasonCode`
- `packages/projections/src/reducers/{exceptions.test (test/),audit-timeline.test}.ts` — COORD-03 fold tests
- `packages/projections/src/reducers/index.ts`, `packages/projections/src/index.ts` — re-export the new exceptions surface
- `packages/projections/src/runner/inline.ts`, `packages/projections/src/runner/catchup.ts` — persist + read coordination rejects (rich fields null on the DB path; existing columns used — no migration)
- `packages/api/src/ws/snapshots.ts` — `coordination-rejected` → `blockedFreight` wire kind; the label surfaces as the alert `reason`, suggestionId as `entityId`
- `packages/api/src/ws/exception-mapping.test.ts`, `packages/api/src/routes/exceptions.ts`, `packages/api/src/kpis/compute-kpis.test.ts` — wire-mapping coverage + DTO widening + fixture fields

## Decisions Made

See `key-decisions` frontmatter. Highlights: `arbitrateSuggestion` reads (never recomputes) the agent's verdict; accepted-suggestion precedence suppresses the autonomous Act (no double-emit); reject severity = `warning` to protect the detection FP-rate; reuse the existing feed/timeline with NO new UI panel (map onto the existing `blockedFreight` wire kind) and NO DB migration (rich fields in-memory-only this plan).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widening the closed projection types cascaded to DB runners + api consumers**
- **Found during:** Task 3 (the `pnpm typecheck` exhaustiveness gate)
- **Issue:** Adding `coordination-rejected` to `ExceptionKind` and the new fields to `OpenException`/`AuditTimelineEntry` broke compilation in five downstream consumers that construct or map these types: `projections/src/runner/inline.ts` (the exceptions partial-load + write + `readOpenExceptions` + `EXCEPTION_KINDS` set), `projections/src/runner/catchup.ts` (the audit-timeline DB reads), `api/src/ws/snapshots.ts` (the `exceptionKindToWire` exhaustive switch + `ExceptionItem` construction), `api/src/ws/exception-mapping.test.ts` (the `Record<ExceptionKind,…>` map), and `api/src/routes/exceptions.ts` + `api/src/kpis/compute-kpis.test.ts` (the DTO + a fixture literal).
- **Fix:** Updated the DB read paths to null-default the in-memory-only rich fields (no DB migration); added `SuggestionRejected` to the inline write path (`affectedExceptionId` + persist via existing columns) so the DB feed is consistent; mapped `coordination-rejected → blockedFreight` in the wire layer (CONTEXT decision: no new UI panel) with the label surfaced as the alert reason; widened the exceptions route DTO + query enum; added the missing fixture fields. Re-exported `coordinationRejectId`/`COORDINATION_REJECT_LABELS`/`CoordinationRejectReason` from both projection indexes.
- **Files modified:** inline.ts, catchup.ts, snapshots.ts, exception-mapping.test.ts, exceptions.ts (route), compute-kpis.test.ts, reducers/index.ts, src/index.ts
- **Verification:** `pnpm typecheck` clean; `pnpm lint` clean on @mm/projections + @mm/api + @mm/simulation; 57 affected unit tests GREEN
- **Committed in:** `cf778fe` (with Task 3)

**Total deviations:** 1 auto-fixed (1 blocking, from my own type-widening). No Rule 4 architectural decisions were needed — the no-migration / reuse-existing-wire-kind choices kept the change contained (the alternative, a DB column + new wire enum + frontend panel, was explicitly out of scope per CONTEXT "no new UI panel").

## Issues Encountered

- **`targetAgentId` is not in the `SuggestionRejected` payload nor the reducer signature.** The plan's interface notes asked the reject row to carry `targetAgentId`, but the event payload carries only `{ suggestionId, reasonCode, occurredAt }` and the reducer sees only `(event, occurredAt)` — the agent identity lives on the event's STREAM (`trailer-<id>`/`hub-<id>`), not the payload. Decision: surface `reasonCode` + `suggestionId` + `label` (all available); `targetAgentId` is null in the reducer rows (the stream carries it; the ws layer falls back to `suggestionId` for `entityId`). No code-path could honestly reconstruct it without threading the streamId through the reducer (out of scope).
- **The natural all-on scenario yields only `dock` rejects.** Reroute suggestions in the seed-42 run all landed on feasible trucks, so the engine-level reject mix is all `dock` (998). The HOS/fuel un-overridable-contract witness is fully covered at the unit level (Task 1: `arbitrateSuggestion(reroute, HOS_OUT) → "hos"`, `(reroute, FUEL_OUT) → "fuel"`), which the engine wires verbatim — the authoritative gate. Not a logic gap; scenario-shaping.

## Known Stubs

None that prevent the plan goal. The rich reject-correlation fields (`reasonCode`/`suggestionId`/`label`) are null on the DB-backed read paths (inline/catchup) by design — the live event-stream / ws demo path (which surfaces the COORD-03 alert) carries them at full fidelity; persisting them is deferred (would need a DB migration, out of this plan's scope). The 5 anti-oscillation guards + anti-livelock are Plan 04 (this plan is the raw accept/reject + alert, as scoped).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 04 (COORD-04 guards + COORD-05 anti-livelock)** builds on this raw handshake: the 5 guards (hysteresis dead-band, seeded-jitter backoff, sim-time TTL, single-owner lease, reject-path pruning) harden the accept/reject loop established here; the seeded `deriveCoordinatorRng` substream + `ttlSimMs` + the reject `reasonCode`/`suggestionId`/`kind` keys are all in place. The hold-always-accepted feasible no-op (the COORD-05 substrate) is implemented in `arbitrateSuggestion`.
- **Plan 05** captures the coordinator-on golden (reproducibility-first), extends the salt-collision Set to size 10, adds the `coordinator/**` ESLint purity guard (handshake.ts is already pure), and serializes `pendingSuggestionsByTarget` into `SerializedWorldState` for continuation-equivalence.
- No blockers. Determinism keystone held: flag-off `3920accc…` + OODA-on `94689f99…` byte-identical; coordinator-on same-seed reproducible; `pnpm typecheck` + `pnpm lint` clean; 507 simulation + 132 projections + 260 domain + 312 api unit tests GREEN.

## Self-Check: PASSED

- Created files verified on disk (below)
- Task commits verified in git log (below)
- Gates: `pnpm typecheck` CLEAN; `pnpm lint` exit 0 on @mm/simulation + @mm/projections + @mm/api; 507 simulation + 132 projections + 260 domain + 312 api unit tests GREEN; determinism keystone — flag-off seed-42 10k golden `3920accc…` + OODA-on `94689f99…` byte-identical; coordinator-on same-seed byte-identical

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
