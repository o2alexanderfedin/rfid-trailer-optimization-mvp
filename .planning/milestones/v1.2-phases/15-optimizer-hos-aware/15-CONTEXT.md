# Phase 15: Optimizer HOS-aware - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; optimizer SOFT-awareness — default reproduces prior plans)

<domain>
## Phase Boundary

Make the rolling-horizon optimizer **aware** of driver Hours-of-Service: feed `DriverStatus` (Phase-13) into the rolling-epoch snapshot, and add a **soft** `restCost` objective term that prefers assigning drivers with more remaining legal hours. **Soft only** — the default weight must reproduce prior plans exactly (glpk oracle + planner-vs-validator stay green). Hard enforcement is Phase 16.

**In scope:** OPT-HOS-01. **OUT of scope:** hard HOS feasibility gate + rest-as-serviceMin + relay recommendation (Phase 16); UI (17).
</domain>

<decisions>
## Implementation Decisions

### Driver status into the snapshot (OPT-HOS-01)
- Extend the rolling-epoch snapshot builder (`packages/api/src/optimizer/twin-snapshot.ts`) to read Phase-13 `driver_status` (+ `driver_assignment` / `trailer_state.driver_id`) and attach per-driver remaining-legal-drive info to the `TwinSnapshot` (carry it on `rolling/twin.ts` / `rolling/types.ts`). Use the Phase-10 engine for any derived remaining-minutes (reuse).

### Soft restCost objective (OPT-HOS-01)
- Add a `restCost` weight in `objective/weights.ts` + term in `objective/objective.ts` that **soft-prefers** drivers with more remaining hours (e.g. penalize assigning a low-remaining-hours driver). 
- **Default weight = 0** (or otherwise neutral) so the objective value + selected plans are **byte-identical to pre-Phase-15** → `glpk` LP oracle cross-check, `planner-vs-validator` property tests, `select-plan`, and all existing optimizer tests stay green. A non-default weight changes preference; add a focused test proving the soft preference works when the weight is raised.

### Determinism / purity
- The optimizer is **pure — it never draws RNG**. Keep it that way (integer costs, sorted-by-id determinism). No `Date.now()`. DriverStatus is read deterministically from the projection.

### Claude's Discretion
Exact restCost formula, where on the snapshot the driver info lives, weight default representation — follow `objective/weights.ts` + `rolling/twin.ts` conventions. **TDD mandatory**: a test that the default weight reproduces prior plans/objective, and a test that raising the weight shifts preference toward more-rested drivers.
</decisions>

<code_context>
## Existing Code Insights

### Reuse / analogs
- `packages/optimizer/src/rolling/epoch.ts` (rolling-horizon loop), `rolling/twin.ts` + `rolling/types.ts` (TwinSnapshot / TwinTrailer / TwinStop shapes).
- `packages/optimizer/src/objective/objective.ts` + `weights.ts` + `types.ts` + `select-plan.ts` — the weighted objective + plan selection (where `restCost` plugs in).
- `packages/api/src/optimizer/twin-snapshot.ts` — builds the snapshot from projections (where DriverStatus is read in); `rolling-service.ts`, `live-loop.ts`.
- Phase-13 `driver_status` / `driver_assignment` projections; `@mm/domain` Phase-10 `remainingLegalDriveMinutes`.
- The `glpk.js` LP oracle cross-check tests + `planner-vs-validator` property tests — the regression guards that MUST stay green with the default weight.

### Established Patterns
- Pure optimizer, integer arithmetic, sorted-by-id determinism, weighted objective with named weights, glpk oracle cross-check on many instances. Driver events were no-op in the optimizer's `scope.ts` switch (Phase 9) — wire real DriverStatus consumption here.
</code_context>

<specifics>
## Specific Ideas

Req: **OPT-HOS-01**. Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` (optimizer integration row — "soft restCost weight, default 0"). The single most important regression guard: **default weight ⇒ prior plans byte-identical ⇒ glpk oracle + planner-vs-validator green.** This phase is the safe stepping-stone before Phase 16 hard enforcement.
</specifics>

<deferred>
## Deferred Ideas
- Hard HOS gate (rest-as-serviceMin in feasibility + reject illegal legs + insertRest/relay recommendation) → Phase 16.
</deferred>
