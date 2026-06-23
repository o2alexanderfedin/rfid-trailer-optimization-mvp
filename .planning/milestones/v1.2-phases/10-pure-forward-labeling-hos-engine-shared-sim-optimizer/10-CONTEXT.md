# Phase 10: Pure forward-labeling HOS engine - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — pure logic module + tests; grounding-enriched)

<domain>
## Phase Boundary

Implement the **pure, deterministic forward-labeling HOS engine** in `@mm/domain` — the single source of truth consumed (DRY) by both the simulator (Phase 11) and the optimizer (Phase 16). This phase delivers ONLY the pure module + its tests.

**In scope:** a pure function that, given an `HosClock` + an `HosConfig` + a driving leg of N minutes (and "now"), returns the legal sequence of duty segments (drive / insert 30-min break / insert 10h off-duty rest / apply sleeper-berth split) and the updated `HosClock`; plus `remainingLegalDriveMinutes` and a "may drive now" predicate. No RNG, no I/O, no side effects.

**OUT of scope (later phases):** sim emitting events / accruing the clock (Phase 11), relay (Phase 12), optimizer consuming it as rest-as-serviceMin + hard gate (Phase 16). This phase only builds and unit/property-tests the engine.
</domain>

<decisions>
## Implementation Decisions

### Forward-labeling engine (HOS-02)
- Pure module in `@mm/domain` (extend `hos.ts` or a sibling `hos-engine.ts` — Claude's discretion, follow existing conventions). Signature roughly: `applyDrivingLeg(clock: HosClock, config: HosConfig, legMinutes: number, now/occurredAt): { segments: DutySegment[]; clock: HosClock }`, where each segment is `{ kind: 'drive'|'break'|'rest'|'sleeper', minutes }`. **Identical inputs → identical output** (property test).
- Forward-labeling "rest-as-time" sweep: walk the leg minute-budget forward, inserting a 30-min break when `sinceLastBreakMin` would exceed `breakAfterDriveMin` (480), and a 10h off-duty rest when `driveTodayMin` would exceed `maxDriveMin` (660) or the 14h window deadline is hit; rest resets the per-shift clocks per FMCSA.

### Clock arithmetic (HOS-03)
- `remainingLegalDriveMinutes(clock, config, now) = clamp_≥0( min( maxDriveMin − driveTodayMin, dutyWindowDeadline − now, breakAfterDriveMin − sinceLastBreakMin ) )`.
- `dutyWindowDeadline = comeOnDutyAt + dutyWindowMin` (840). **The 14h window is ELAPSED wall-clock — it does NOT pause for breaks/dwell/rest.** This is the prime correctness trap → an explicit unit test must prove a break does not extend the window.
- "may drive now" iff `remainingLegalDriveMinutes > 0` AND `weeklyOnDutyMin < weeklyCapMin` (4200).

### Full-FMCSA provisions
- Weekly 70h/8-day cap (`weeklyCapMin=4200`) + 34h restart (`restartMin=2040`) reset of the weekly counter.
- **Sleeper-berth splits (7/3 and 8/2):** the highest-complexity element — a qualifying sleeper period pairs with a second qualifying off-duty period to satisfy the 10h reset without a single continuous 10h block, and the paired sleeper period does NOT count against the 14h window. Implement the pairing logic; test both 7/3 and 8/2.

### Determinism & purity
- Pure, integer-minute, no RNG, no clock reads — all time passed in as args (`occurredAt`/`now`). This is what lets Phase 11 (sim) and Phase 16 (optimizer) reuse it deterministically.

### Claude's Discretion
Exact types for `DutySegment`, module/file layout, and test structure — follow `@mm/domain` conventions. **TDD mandatory:** property test (determinism) + boundary tests per limit + the 14h-no-pause test + sleeper-split tests, written first.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 9 + grounding)
- `packages/domain/src/hos.ts` — Phase 9 added `Driver`, `HosClock`, `HosConfig`, `DEFAULT_HOS_CONFIG` (constants: maxDriveMin=660, dutyWindowMin=840, breakAfterDriveMin=480, minBreakMin=30, resetOffDutyMin=600, weeklyCapMin=4200, restartMin=2040, sleeper-split params). Build the engine on these.
- `packages/domain/src/timing.ts` — `expectedMinutes` / `TimingConfig` pure-function pattern to mirror.
- `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` — "Recommended HOS Engine Design" + the FMCSA rule numbers + the 14h-elapsed-window trap.

### Established Patterns
- Pure functions, integer arithmetic, strict TS (no `any`), zod where schema validation is needed, exhaustive unit + property tests.
</code_context>

<specifics>
## Specific Ideas

Reqs: **HOS-02, HOS-03** (see `.planning/REQUIREMENTS.md`). Full FMCSA detail + the recommended single-engine design: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md`. The engine must be the DRY source for sim (Phase 11) AND optimizer (Phase 16) — design the signature so the optimizer can call it for "rest-as-time" feasibility without modification.
</specifics>

<deferred>
## Deferred Ideas

- Sim accrual + event emission + 5th RNG substream + golden → Phase 11.
- Optimizer rest-as-serviceMin fold + hard feasibility gate → Phase 16.
</deferred>
