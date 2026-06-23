# Phase 16: Optimizer HOS-enforced - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; HIGHEST-RISK slice — hard optimizer enforcement)

<domain>
## Phase Boundary

Make the optimizer **hard-enforce** driver HOS: a driving leg the assigned driver cannot legally complete is **infeasible**; rest folds in as service time; and when an assignment is HOS-infeasible the optimizer surfaces an **insert-rest / driver-relay recommendation** through the existing local-repair → `EpochRecommendation` path. Reuse the Phase-10 engine and the Phase-2 LIFO validation-gate pattern. Stay pure/deterministic; keep the glpk oracle + planner-vs-validator green.

**In scope:** OPT-HOS-02 (rest-as-`serviceMin` + hard feasibility gate), OPT-HOS-03 (insertRest/relay recommendation). **OUT of scope:** UI (17), README (18).
</domain>

<decisions>
## Implementation Decisions

### Rest-as-time + hard gate (OPT-HOS-02)
- Add an **optional** `restMin` to `Stop` (`vrptw/types.ts`) and fold it into the existing `serviceMin` computation in `vrptw/feasibility.ts` — **rest-as-time, NO new graph edge kind** (KISS). When the Phase-10 engine says a leg requires a 30-min break / 10h rest before/within it, that time is added as service.
- Add a **hard gate** in `vrptw/route-trailers.ts` (and/or `feasibility.ts`): a route leg the assigned driver **cannot legally complete** (per the Phase-10 `applyDrivingLeg`/`remainingLegalDriveMinutes` against the `TwinDriver` from Phase 15) is rejected as **infeasible** — mirroring the proven Phase-2 LIFO HARD/SOFT validation-gate pattern (separate feasibility from score; never fold feasibility into the objective).
- Reuse the SAME Phase-10 HOS engine the sim uses (DRY).

### Graceful infeasibility + recommendation (OPT-HOS-03)
- When HOS makes an assignment infeasible, do NOT crash the epoch: `repair/local-repair.ts` produces an **`insertRestStop`** (or driver-relay) recommendation, surfaced through the existing `localRepair → EpochRecommendation` path (`rolling/epoch.ts`). The recommendation is explainable (which driver, which leg, why infeasible).

### 🔑 Regression invariants (critical)
- The hard gate activates ONLY when a `TwinDriver` with HOS context is present on the trailer. Existing optimizer test instances / the **glpk LP oracle** (min-cost-flow subproblem — separate from VRPTW route feasibility) and the **planner-vs-validator** property test have no such driver context → they MUST stay green UNCHANGED. Verify explicitly.
- Pure & deterministic: integer arithmetic, sorted-by-id determinism, **no RNG, no `Date.now()`**. Same inputs → same plan + same recommendations.

### Claude's Discretion
Exact `restMin` placement, gate location (feasibility vs route-trailers), recommendation payload shape — follow `vrptw/feasibility.ts` + `repair/local-repair.ts` + the Phase-2 LIFO-gate conventions. **TDD mandatory**: (a) a leg the driver can't legally finish is rejected as infeasible; (b) rest folds into serviceMin correctly; (c) an HOS-infeasible assignment yields an insertRest/relay EpochRecommendation; (d) glpk oracle + planner-vs-validator unchanged + green; (e) determinism holds.
</decisions>

<code_context>
## Existing Code Insights

### Reuse / analogs
- `packages/optimizer/src/vrptw/feasibility.ts` (`serviceStart = max(arrival, windowStart)`, `departure = serviceStart + serviceMin`), `vrptw/route-trailers.ts` (route construction + gating), `vrptw/types.ts` (`Stop`).
- `packages/optimizer/src/repair/local-repair.ts` + `rolling/epoch.ts` (`EpochRecommendation` path — split/reassign/hold/over-carry repair already exists; add insertRest/relay).
- Phase-15 `TwinDriver` on `TwinTrailer` (`rolling/types.ts`) + `restCost` (now the SOFT term; this phase adds the HARD gate). `@mm/domain` Phase-10 `applyDrivingLeg`/`remainingLegalDriveMinutes`.
- The **Phase-2 LIFO validation gate** (in `@mm/load-planner` — independent HARD/SOFT validator, feasibility never folded into score) — the pattern to mirror for the HOS hard gate.
- `glpk` oracle tests (`graph/glpk-oracle.test.ts`, `flow/glpk-oracle.test.ts`) + `planner-vs-validator.property.test.ts` — the regression guards.

### Established Patterns
- Separate feasibility (HARD) from objective (SOFT); pure optimizer; integer costs; deterministic; rest-as-time avoids new edge kinds; explainable repair recommendations via `EpochRecommendation`.
</code_context>

<specifics>
## Specific Ideas

Reqs: **OPT-HOS-02, OPT-HOS-03**. Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` (optimizer enforcement row — verified the rest-as-serviceMin fold is sound and needs NO new edge kind; flagged that tight HOS limits can make legs infeasible → the recommendation path is how that's handled gracefully). Keystone: glpk oracle + planner-vs-validator MUST stay green; the optimizer MUST stay pure & deterministic.

**Note:** Do NOT edit `.planning/ROADMAP.md` or `.planning/REQUIREMENTS.md` — the orchestrator manages those.
</specifics>

<deferred>
## Deferred Ideas
- Hub Detail panel UI → Phase 17. README + screenshots → Phase 18.
</deferred>
