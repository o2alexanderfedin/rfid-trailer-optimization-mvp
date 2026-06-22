---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Realistic Time Model + Hardening
status: planning
last_updated: "2026-06-22T00:20:43.053Z"
last_activity: 2026-06-22
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-20)

**Core value:** Generate route-aware, LIFO-correct trailer load plans that minimize blocked-freight rehandle and continuously repair them as conditions change — demonstrated live over a simulated USA hub network.
**Current focus:** v1.1 "Realistic Time Model + Hardening" — defining requirements (optimizer consumes log-normal timing, distance-derived transit, center dwell, road-following routes, client hardening). v1.0 MVP shipped + archived (2026-06-20; main @ v1.0.0).

## Current Position

Phase: 6 of 8 — Realistic Geography & Time Model (ready to plan)
Plan: —
Status: Roadmap complete — ready to plan Phase 6
Last activity: 2026-06-21 — v1.1 roadmap created (Phases 6–8); research + requirements committed

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

### Pending Todos

- [RESOLVED 2026-06-21] The `*.test.tsx`-never-run gap is FIXED (branch feature/test-coverage-90): added a jsdom (`ui`) + Browser-Mode (`browser`, Playwright/Chromium) Vitest project + RTL + MSW; `test:all` now runs the jsdom lane, `test:browser` runs the map. Plus the honest cross-package coverage fix (`pnpm coverage` + `vitest.coverage.config.ts` aliasing `@mm/*`→src). Result: 78%→**95.2% lines / 94.0% stmts / 95.5% fn**, every package ≥91.7%, web 19%→93.3%.
- [optional follow-up] `wsClient.ts` raw-socket connect path still 56% (the WsProvider render test drives a test context, not a live socket), and overall **branch** coverage is 82% (lines/stmts/fn are 94–95%). A focused top-up would close both if a 90% *branch* bar is wanted.
- [v1.1 candidate — "realistic time model"] Dwell + transit are now seeded **log-normal** (260621-j57), but: (a) the optimizer still does NOT consume dwell/transit (time-expanded graph uses 15-min steps; populate `serviceMin`/wait-edge weights from the timing draws); (b) no distinct CENTER-hub dwell site exists in the modeled cycle (center arrival is a terminal unload) — `dwellCenter` is wired but unused until a center re-dispatch is modeled; (c) transit is randomized around a median, not yet **distance-derived** (pairs with the ORS road-directions idea).

### Blockers/Concerns

None — all v1.0 phase blockers resolved at ship. (Phase 4 settled on custom SSP min-cost-flow + VRPTW with a glpk.js correctness oracle; Phase 5 OpenLayers perf resolved via flat-heap postrender animation, soak-proven.) Carried technical debt is tracked in PROJECT.md and `milestones/v1.0-MILESTONE-AUDIT.md`.

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

Last session: 2026-06-21 — three merges to develop: (1) UI speed-of-time gauge (quick task 260621-0fy); (2) test coverage 78%→95.2% lines (v8 attribution fix + jsdom/Browser-Mode/MSW web harness, 14 tests); (3) seeded log-normal dwell+transit timing (260621-j57) replacing fixed 10/30-tick constants — dedicated timing RNG keeps it orthogonal to RFID/over-carry; deterministic; scenario-reopt keystone re-baselined + strengthened. Gate green: 1149 tests / 117 files.
Stopped at: log-normal timing merged to develop; between milestones; awaiting /gsd-new-milestone to scope v1.1 (realistic-time-model items queued in Pending Todos)
Resumed: 2026-06-21 — /gsd-resume-work; verified clean between-milestones state (gate green, no incomplete work); presenting v1.1 scoping path.
Resume file: .continue-here.md (root)

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
