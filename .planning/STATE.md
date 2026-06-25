---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Complete Simulation Model
status: executing
stopped_at: roadmap written for v2.0 (Phases 19–22)
last_updated: "2026-06-25T02:09:52.087Z"
last_activity: 2026-06-25 -- Phase 21 planning complete
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 22
  completed_plans: 7
  percent: 32
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-22)

**Core value:** Generate route-aware, LIFO-correct trailer load plans that minimize blocked-freight rehandle and continuously repair them as conditions change — demonstrated live over a simulated USA hub network.
**Current focus:** v2.0 Complete Simulation Model — Phase 19 ✅ complete (continuous operation + resumable engine + bounded retention). Phase 20 (External Induction) is next.

## Current Position

Phase: 21 — Bidirectional Freight / Consolidation (next)
Plan: —
Status: Ready to execute
Last activity: 2026-06-25 -- Phase 21 planning complete

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Phase 2 ✅ 2026-06-19]: Load Planning COMPLETE. Delivered AGG-01..04, LOAD-01..10. New pure packages @mm/aggregation (load-block aggregation/split/priority) and @mm/load-planner (canonical LIFO invariant single-source, independent virtual-unload validator, greedy planner, partial-LIFO, rehandle+utilization scoring with FeasibilityResult≠ScoreResult P2 separation, FIFO baseline, explainable rationale) + @mm/api POST /plan. Keystone golden reversed-plan fixture + planner-vs-validator property test. Adversarial review fixed a latent Phase-1 turbo-build cycle (event-store↔api) + a splitBlock duplicate-id MEDIUM. Carried LOW debt (keyId separator, docstring) in 02-REVIEW.md.
- [Lesson]: Gate runs MUST include turbo `pnpm build` (not just `pnpm -r build`) — the recursive build tolerated a workspace cycle that turbo rejects; caught only in Phase-2 review.
- [Phase 1 ✅ 2026-06-19]: Operational Data Foundation + Live Map Spike COMPLETE. Delivered FND-01..08, SIM-01/02, VIZ-01. TS/Node monorepo (pnpm+Turborepo): @mm/domain (build-gated closed event union + zod), @mm/event-store (append-only + optimistic concurrency + gap-free global order), @mm/projections (pure reducers + FND-04 golden-replay keystone), @mm/simulation (10 US hubs, seeded deterministic stream), @mm/api (Fastify queries + catch-up projections + ws), @mm/web (OpenLayers+OSM live map). Built via rival subagents in worktrees + judge + adversarial review. Carried LOW debt documented in 01-REVIEW.md. M-1/M-2 readAll cursor: low-water-mark guard added now; revisit if Phase 4 optimizer becomes a concurrent writer.
- [Roadmap]: 5-phase MVP — foundation → load planning → RFID validation → rolling optimizer → sim/viz wrapper.
- [Phase 1]: Pull the simulation engine (SIM-01/02) and a thin geo-only map slice (VIZ-01) into Phase 1 — the sim is the only data source for everything, and the early map slice de-risks the OpenLayers centerpiece before the optimizer lands.
- [Phase 2]: Load planner is the "if all else fails" deliverable; independent LIFO validator + naive baseline (LOAD-09) designed in here, sharing KPI plumbing for the eventual before/after "money slide."
- [Phase 4]: Custom min-cost flow + VRPTW in TS (no maintained JS lib) with glpk.js held as a correctness oracle — concentrated engineering risk; flagged for /gsd-research-phase.
- [v2.0 2026-06-24]: Three design decisions resolved: (1) PackageInducted COEXISTS with PackageCreated; (2) spoke→spoke freight routes via center hub; (3) optimizer picks up inducted freight automatically via hub_inventory projection. Zero new runtime dependencies.

### Pending Todos

- [RESOLVED 2026-06-21] The `*.test.tsx`-never-run gap is FIXED (branch feature/test-coverage-90): added a jsdom (`ui`) + Browser-Mode (`browser`, Playwright/Chromium) Vitest project + RTL + MSW; `test:all` now runs the jsdom lane, `test:browser` runs the map. Plus the honest cross-package coverage fix (`pnpm coverage` + `vitest.coverage.config.ts` aliasing `@mm/*`→src). Result: 78%→**95.2% lines / 94.0% stmts / 95.5% fn**, every package ≥91.7%, web 19%→93.3%.
- [optional follow-up] `wsClient.ts` raw-socket connect path still 56% (the WsProvider render test drives a test context, not a live socket), and overall **branch** coverage is 82% (lines/stmts/fn are 94–95%). A focused top-up would close both if a 90% *branch* bar is wanted.
- [RESOLVED v1.1 2026-06-22] The "realistic time model" candidate shipped: (a) optimizer now consumes expected dwell/transit (OPT-09/10), (b) distinct center-hub re-dispatch dwell modeled (TIME-02 `dwellCenter`), (c) transit distance-derived from ORS `duration_s` (TIME-01).

### Blockers/Concerns

None — v1.2 shipped clean. v2.0 roadmap research confirmed zero new runtime dependencies. Phase 21 (FLOW-*) is the highest-integration phase; the `PlanSuperseded`/supersession-aware `PlanAccepted` design decision must be resolved during Phase 21 planning. Detection-cost-scales-with-state tech debt will be addressed in Phase 21 via `is_active` filter.

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260621-0fy | UI speed-of-time gauge (live sim-speed control + clock fix) | 2026-06-21 | 1154ddd | Verified | [260621-0fy-sim-speed-gauge](./quick/260621-0fy-sim-speed-gauge/) |
| 260621-j57 | Seeded log-normal dwell + transit timing (realistic right-skew, deterministic) | 2026-06-21 | b52d762 | Done | [260621-lognormal-timing](./quick/260621-lognormal-timing/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-06-24
Stopped at: roadmap written for v2.0 (Phases 19–22)
Resume file: None

## Operator Next Steps

- v2.0 roadmap created 2026-06-24 (Phases 19–22). Next: `/gsd-plan-phase 19`
