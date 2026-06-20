---
phase: 04-rolling-optimizer
plan: 06
subsystem: api
tags: [rolling-optimizer, event-sourcing, structuredClone, idempotency, freeze-window, fastify, postgres]

requires:
  - phase: 01-operational-data-foundation
    provides: "event store (appendWithRetry + ConcurrencyError optimistic concurrency), domain PlanGenerated/PlanAccepted events"
  - phase: 02-load-planning
    provides: "validatePlan HARD feasibility gate + scorePlan (REUSED, not re-implemented)"
  - phase: 04-rolling-optimizer (plans 01-05)
    provides: "time-expanded graph, min-cost flow, VRPTW routeTrailers, §12 objective + selectPlan, localRepair"
provides:
  - "detectAffectedScope: OPT-05 scoped rolling epoch (affected hubs/trailers only, never the whole network)"
  - "buildTwin: OPT-04 structuredClone planning-twin sandbox (zero side effects until accept)"
  - "scopeHash + isFrozen: OPT-06 (epochId, scopeHash) idempotency key + freeze-window predicate"
  - "runEpoch: the PURE rolling-epoch core composing plans 02-05"
  - "RollingOptimizerService: the ONLY stateful shell — memoized, appends ONE PlanAccepted on accept"
  - "GET /optimizer/recommendations endpoint (plan + objective breakdown + recommendations)"
affects: [phase-05-simulation, optimizer-tuning]

tech-stack:
  added: ["@mm/optimizer wired into @mm/api"]
  patterns:
    - "PURE core + thin stateful shell (the shell is the only side-effecting part)"
    - "structuredClone sandbox for zero-side-effect evaluation"
    - "canonical (key-sorted) JSON + sha256 for a stable idempotency hash"
    - "memoize by ${epochId}:${scopeHash} ⇒ identical input commits at most once"

key-files:
  created:
    - packages/optimizer/src/rolling/types.ts
    - packages/optimizer/src/rolling/scope.ts
    - packages/optimizer/src/rolling/twin.ts
    - packages/optimizer/src/rolling/freeze-idempotency.ts
    - packages/optimizer/src/rolling/epoch.ts
    - packages/api/src/optimizer/rolling-service.ts
    - packages/api/src/routes/optimizer.ts
    - packages/api/test/optimizer-rolling.int.test.ts
  modified:
    - packages/optimizer/src/rolling/index.ts
    - packages/api/src/server.ts
    - packages/api/src/index.ts
    - packages/api/package.json
    - packages/api/tsconfig.json

key-decisions:
  - "runEpoch is a PURE function (data in/data out); the RollingOptimizerService is the only stateful, IO-bearing part — so the optimizer stays replay-identical and idempotent."
  - "The twin carries its OWN minimal block/stop shapes (TwinBlock/TwinStop) rather than the full domain LoadBlock — DIP/KISS, a small self-describing rolling contract."
  - "scopeHash = sha256 of canonical (recursively key-sorted) JSON of (scope, twinSnapshot) — key-order-independent, so logically-identical input always memoizes to one commit."
  - "Determinism preserved: occurredAt is new Date(nowMin*60000).toISOString() — a pure function of the sim/event clock, never Date.now(); no Math.random anywhere."
  - "On accept the shell appends PlanGenerated + PlanAccepted atomically via appendWithRetry (Phase-1 optimistic-concurrency, retry-on-ConcurrencyError) — the optimizer is a well-behaved concurrent writer."

patterns-established:
  - "Anti-P7 (thrash): freeze window + (epoch,scopeHash) memoization + deterministic planId tie-break."
  - "Anti-P2 (feasibility-in-score): routeTrailers' HARD verdict stays a separate FeasibilityResult; selectPlan gates on it FIRST, objective sees only metrics."

requirements-completed: [OPT-04, OPT-05, OPT-06]

duration: ~50min
completed: 2026-06-19
---

# Phase 4 Plan 06: Rolling shell + twin sandbox + freeze/idempotency + API — Summary

**A scoped rolling-horizon epoch loop evaluates candidates on a structuredClone twin with ZERO side effects until accept (then exactly one PlanAccepted), honors freeze windows, and is byte-identical-idempotent per (epochId, scopeHash) — proven against the shared Postgres and exposed via GET /optimizer/recommendations.**

## Accomplishments

- **OPT-05 scoped epoch** — `detectAffectedScope(events, epoch)` collects only the hubs/trailers the new events reference (sorted/deduped, deterministic) and bounds the horizon from `epoch.nowMin` (sim/event time). A 10-hub network with events touching 2 yields a scope of those 2.
- **OPT-04 twin sandbox** — `buildTwin(scope, snapshot)` returns a `structuredClone` of the scoped slice; mutating the twin never reaches the source. Proven on the real store: 5× `runEpoch` evaluations append ZERO events.
- **OPT-06 keystone** — `scopeHash` (canonical JSON + sha256) is key-order-independent; identical `(epoch, input, weights)` ⇒ byte-identical `EpochResult`. `isFrozen` freezes trailers departing within `[now, now+freezeWindowMin]`; a frozen trailer's plan is untouched (`accepted = null`).
- **runEpoch** — a readable PURE pipeline: `detectAffectedScope → buildTwin → (per trailer: isFrozen? routeTrailers → objective) → selectPlan → PlanGenerated + (maybe) PlanAccepted`. Reuses plans 02-05; re-implements no feasibility/scoring.
- **RollingOptimizerService** (the ONLY stateful shell) — memoizes by `${epochId}:${scopeHash}`, and on accept appends ONE `PlanAccepted` (+ the `PlanGenerated` record) via `appendWithRetry`. Idempotent: feeding the same epoch twice appends the plan once.
- **GET /optimizer/recommendations** — returns the latest epoch's plan + objective breakdown + per-trailer recommendations; 204 before the first epoch.

## Verification (all GREEN)

- `pnpm install`, `pnpm build` (turbo, FULL TURBO), `pnpm -r build` — pass.
- `pnpm lint` — clean.
- `pnpm test:all` (MM_PG_URL set, per-run isolated DB) — **443 tests / 58 files pass**, all prior endpoints green.
- Rolling unit tests: 23 pass (scope, twin, freeze/idempotency, epoch).
- Integration (shared PG): 5 pass — zero side effects until accept; exactly one PlanAccepted on accept; idempotent per (epoch,scope); endpoint 204→200.
- Determinism gate: no real `Date.now()`/`Math.random()` call sites in optimizer src (matches are doc-comment prose only, as in pre-existing files).

## Notes / carried risks

- `runEpoch`'s pure core anchors `churnVsPrevious = 0` (a fresh epoch has no prior plan in-core); cross-epoch churn folding is a natural extension point for the shell once it carries the prior accepted plan.
- The twin snapshot is supplied to the service per epoch (DIP); wiring it from the live projections (a `buildTwinSnapshot(db)` reader) is the next integration step for the demo driver.
