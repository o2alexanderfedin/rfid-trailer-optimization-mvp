# Phase 14: Hub-detail endpoint + ws driver buckets - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; api read-layer, has integration tests)

<domain>
## Phase Boundary

Build the **`GET /api/hubs/:id/detail`** REST endpoint that aggregates everything the (Phase-17) Hub Detail panel needs, plus **ws `HubState` driver buckets** for map coloring. Pure read-layer over existing projections — no new sim/optimizer behavior.

**In scope:** HUBQ-01..08. **OUT of scope:** the UI panel (Phase 17), optimizer (15–16).
</domain>

<decisions>
## Implementation Decisions (per the verified hub-detail grounding)

### `GET /api/hubs/:id/detail` (HUBQ-01..07)
- **HUBQ-01** Return the trailers currently at the hub (`trailer_state WHERE current_hub_id = :id`) with each trailer's `status`, `dockDoorId`, assigned packages, and **assigned-driver duty status + remaining legal drive minutes** (join `trailer_state.driver_id` → Phase-13 `driver_status`).
- **HUBQ-02** Back the query with the `trailer_state(current_hub_id)` index (added in Phase 13 as `idx_trailer_state_current_hub` — confirm it exists / no full-table scan).
- **HUBQ-03** Per-trailer **load-plan summary** reusing the existing Phase-2 `planLoad` reconstruction in `routes/plan-detail.ts` — **extract the reconstruction into a shared helper** (DRY) so both `/trailers/:id/plan` and the hub-detail endpoint use it (the panel uses compact rows + click-through, so a summary is enough; full plan stays at `/trailers/:id/plan`).
- **HUBQ-04** Include a **utilization ratio** computed the SLICE-AWARE way: `Σ(slice.usedVolume) / Σ(slice.capacityVolume)` (NOT volume/50). Add the same field to the existing `TrailerPlanDto` for VIZ-05 parity (additive — do not regress the existing trailer panel/tests).
- **HUBQ-05** Include `arrivedAtMs` from the most recent `TrailerArrivedAtHub` event for `(trailer_id, hub_id)` in `audit_timeline` (ORDER BY global_seq DESC LIMIT 1). **Do NOT use `trailer_state.last_event_at`** (it advances on later events — under-reports dwell). The client computes live elapsed dwell against ws `simMs`.
- **HUBQ-06** Include `nextHubId` via the existing `buildRoute` reconstruction over the trailer's assigned packages' `nextUnloadHubId` (first stop = next hub; null when none derivable).
- **HUBQ-07** Include an **estimated** ETA / time-to-depart = `arrivedAtMs + expected dwell (HosConfig/TimingConfig, hub role) + expected transit (next leg)`, explicitly labelled an estimate; for already-in-transit trailers use the existing ws `etaMs` (no fabricated server estimate).

### ws HubState driver buckets (HUBQ-08)
- Extend the ws `HubState` envelope with small integer buckets `driverCount` / `onBreakCount` / `restingCount` (derived from Phase-13 `driver_status` joined to trailers at the hub) so the map can color hubs by driver duty. Keep the REST detail DTO stable and distinct from the ws buckets. Update `ws/envelope.ts` + `ws/snapshots.ts` + their tests.

### Determinism / safety
- Pure read-layer: no sim/projection behavior change → sim goldens unaffected (confirm). The driver-status replay determinism (Phase 13) is unaffected. Additive ws field — keep the existing snapshot/envelope tests green (versioned envelope; don't break existing clients).

### Claude's Discretion
DTO shapes, exact route module, helper extraction location — follow `routes/queries.ts` + `routes/plan-detail.ts` conventions. **TDD mandatory** (route unit/integration tests + ws envelope/snapshot tests; the endpoint should have an integration test like the existing api int tests).
</decisions>

<code_context>
## Existing Code Insights (verified in v1.2-HUB-DETAIL-GROUNDING.md)

### Reuse / analogs
- `packages/api/src/routes/queries.ts` — existing query endpoints (`/trailers/:id`, `/hubs/:id/inventory`); add the new route here or a sibling module.
- `packages/api/src/routes/plan-detail.ts` — the `planLoad`/`buildBlocks`/`buildRoute` reconstruction (VIZ-05) to extract into a shared helper (DRY); `buildRoute` already yields the ordered next-unload hubs (first = next hub).
- Phase-13 `driver_status` + `driver_assignment` tables + `trailer_state.driver_id` + `idx_trailer_state_current_hub` (just landed).
- `audit_timeline` table (event_type `TrailerArrivedAtHub`, indexed by `(trailer_id, global_seq)`) — for `arrivedAtMs`.
- `@mm/domain` `expectedMinutes` (TimingConfig) + HosConfig — for the ETA estimate; `@mm/load-planner` slice model for utilization (`Σ usedVolume / Σ capacityVolume`, slices cap at `maxBlockVolume=30`).
- `packages/api/src/ws/envelope.ts` + `ws/snapshots.ts` — `HubState` currently carries `{id, volumeBucket, slaRiskBucket, congestionBucket}`; add the driver buckets here (versioned envelope).

### Established Patterns
- Fastify routes with schema validation; Kysely queries; versioned ws keyframe+delta envelope; integration tests via testcontainers Postgres.
</code_context>

<specifics>
## Specific Ideas

Reqs: **HUBQ-01, HUBQ-02, HUBQ-03, HUBQ-04, HUBQ-05, HUBQ-06, HUBQ-07, HUBQ-08**. Full verified data-availability map + corrections: `.planning/research/v1.2-HUB-DETAIL-GROUNDING.md`. Key traps already encoded above: dwell from `audit_timeline` (not `last_event_at`); slice-based utilization; ETA is an estimate; ws exception `entityId` carries only trailerId (so hub-scoped alerts, if added, need a server query — but exceptions are Phase-17 panel concern, optional here).
</specifics>

<deferred>
## Deferred Ideas
- The Hub Detail panel UI + map duty styling consuming this endpoint/buckets → Phase 17.
- Optimizer consuming driver-status → Phases 15–16.
</deferred>
