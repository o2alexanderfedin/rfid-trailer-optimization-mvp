# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Milestones

- ✅ **v1.0 MVP** — Phases 1–5 (shipped 2026-06-20) — full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Realistic Time Model + Hardening** — Phases 6–8 (shipped 2026-06-22) — full details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Driver HOS & Hub Detail** — Phases 9–18 (shipped 2026-06-22) — full details: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md)
- 🚧 **v2.0 Complete Simulation Model** — Phases 19–22 (in progress) — continuous · external induction · outbound delivery · bidirectional freight

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–5) — SHIPPED 2026-06-20</summary>

- [x] Phase 1: Operational Data Foundation + Live Map Spike (7/7 plans) — completed 2026-06-19
- [x] Phase 2: Load Planning (6/6 plans) — completed 2026-06-19
- [x] Phase 3: RFID-Assisted Validation (7/7 plans) — completed 2026-06-19
- [x] Phase 4: Rolling Optimizer (6/6 plans) — completed 2026-06-19
- [x] Phase 5: Simulation + Visualization Wrapper (8/8 plans) — completed 2026-06-19

</details>

<details>
<summary>✅ v1.1 Realistic Time Model + Hardening (Phases 6–8) — SHIPPED 2026-06-22</summary>

- [x] Phase 6: Realistic Geography & Time Model — completed 2026-06-21 (VIZ-06, TIME-01, TIME-02)
- [x] Phase 7: Time-Aware Optimizer — completed 2026-06-21 (OPT-09, OPT-10)
- [x] Phase 8: Client Hardening & Coverage — completed 2026-06-22 (HRD-01, QA-01)

</details>

<details>
<summary>✅ v1.2 Driver HOS & Hub Detail (Phases 9–18) — SHIPPED 2026-06-22</summary>

> **Keystone constraint:** determinism. HOS-*off* stays byte-identical to the pre-v1.2 golden replay; HOS-*on* adds a new golden. All HOS RNG flows through one new isolated seeded substream.

- [x] Phase 9: Driver model + HOS config + duty/phase events ✅ 2026-06-22
- [x] Phase 10: Pure forward-labeling HOS engine (shared sim + optimizer) ✅ 2026-06-22
- [x] Phase 11: Sim HOS enforcement + load/unload events + determinism golden ✅ 2026-06-22
- [x] Phase 12: Driver relay / swap at hubs ✅ 2026-06-22
- [x] Phase 13: Driver-status projection + tables ✅ 2026-06-22
- [x] Phase 14: Hub-detail endpoint + ws driver buckets ✅ 2026-06-22
- [x] Phase 15: Optimizer HOS-aware ✅ 2026-06-22
- [x] Phase 16: Optimizer HOS-enforced ✅ 2026-06-22
- [x] Phase 17: Hub Detail panel UI + map duty styling ✅ 2026-06-22
- [x] Phase 18: README features + screenshots ✅ 2026-06-22

</details>

---

### v2.0 Complete Simulation Model — Phases 19–22 (ACTIVE)

> **Keystone constraint — determinism:** Every v2.0 feature is opt-in (flag off by default). With all v2.0 flags off, the existing seed-42 golden replay is byte-identical to pre-v2.0. New RNG salts (`INDUCTION_RNG_SALT`, `OUTBOUND_RNG_SALT`) are pairwise-distinct from all existing salts, asserted in the salt-collision test. Reducers key off `occurredAt` (virtual clock), never wall-clock. New events follow the established closed-union + Zod `.strict()` + `assertNever`-exhaustive pattern.

- [ ] **Phase 19: Continuous Operation Foundation** - Open-ended run loop, multi-cycle generation, sim-day counter, bounded-memory infrastructure, long-run determinism golden, and bidirectional route registration
- [ ] **Phase 20: External Induction** - `PackageInducted` event, spoke-hub induction from dedicated seeded substream, SLA deadline to optimizer, pulsing map marker
- [ ] **Phase 21: Bidirectional Freight / Consolidation** - Spoke→center consolidation via `pendingAtSpoke` queue, center inbound re-sort, optimizer two-direction awareness, consolidation trailer map styling
- [ ] **Phase 22: Outbound Delivery** - `PackageDelivered` terminal event, destination detection, `onTime` SLA flag, projection purge, delivery hub-highlight on map

## Phase Details

### Phase 19: Continuous Operation Foundation
**Goal**: The simulation runs open-ended across multiple day/cycle periods with bounded memory and proven long-run determinism
**Depends on**: Phase 18 (v1.2 complete)
**Requirements**: CONT-01, CONT-02, CONT-03, CONT-04, CONT-05 (P2), DET-01, DET-02
**Success Criteria** (what must be TRUE):
  1. A viewer can start the simulation and watch it continue indefinitely through multiple day/cycle periods without it halting; the sim-day counter in the operator UI increments visibly over a sustained run
  2. The process runs indefinitely without unbounded memory growth: ws backpressure (`bufferedAmount` guard) prevents buffer saturation for backgrounded clients, the projection watermark checkpoint keeps rebuild cost constant regardless of event-log size, and the optimizer idempotency map stays capped at 500 entries (LRU eviction)
  3. With all v2.0 flags off (`runUntilStopped: false`, all feature flags false), the seed-42 run produces a byte-identical event hash to pre-v2.0 — confirmed by the existing golden test passing unchanged
  4. A 10,000-tick seeded run (`simulate({ seed: 42, durationTicks: 10000 })`) produces the same byte-identical event hash on both x86 and ARM CI architectures; if hashes diverge, the log-normal sampler is replaced with an integer lookup table before phase close
  5. (P2) Freight departs in a sort-wave / cut-off burst-quiet-burst cadence rather than a steady trickle, observable on the live map as distinct departure surges
**Plans**: 7 plans
Plans:
**Wave 1**
- [ ] 19-01-PLAN.md — Wave 0 RED test stubs: open-ended, DET-02 golden placeholder, LruMap, backpressure, simDay
- [ ] 19-02-PLAN.md — Engine: runUntilStopped + onEvent + three conditioned guards (CONT-01/02, DET-01)
- [ ] 19-03-PLAN.md — Commit real DET-02 hash + VQ#5 bidirectional routes verification + salt regression

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 19-04-PLAN.md — driveSimulationOpenEnded() driver (CONT-01/02 api layer)
- [ ] 19-05-PLAN.md — WS backpressure guard + simDay envelope + UI counter (CONT-03/04b)
- [ ] 19-06-PLAN.md — LruMap utility + optimizer wiring + watermark verification (CONT-04a/c)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 19-07-PLAN.md — Sort-wave burst-quiet-burst cadence flag (CONT-05 P2, deferrable)
**UI hint**: yes

### Phase 20: External Induction
**Goal**: Freight enters the network from outside at spoke hubs via a new `PackageInducted` domain event, shapes optimizer priority, and animates visibly on the map
**Depends on**: Phase 19
**Requirements**: IND-01, IND-02, IND-03, VIZ-13
**Success Criteria** (what must be TRUE):
  1. A viewer watching the live map sees pulsing induction markers appear at spoke hubs on a repeating schedule, indicating freight entering from outside the network
  2. Inducted packages carry a destination hub and SLA deadline visible in the optimizer's planning output (optional `deadlineMin` on `TwinBlock`), so urgency-driven re-optimization is observable when tight deadlines are present
  3. With `inductionEnabled: false` (default), zero `PackageInducted` events are emitted — the existing seed-42 golden is byte-identical; with the flag on, `INDUCTION_RNG_SALT` is pairwise-distinct from all other salts (asserted by the salt-collision test), and induction draws are isolated from all other RNG substreams
  4. The `PackageInducted` event passes a `validate()` round-trip test and is exhaustively handled in every `switch(event.type)` reducer, enforced at build time by `contract.assert.ts` and `assertNever` guards
**Plans**: TBD
**UI hint**: yes

### Phase 21: Bidirectional Freight / Consolidation
**Goal**: Spoke→center consolidation trailers carry real freight, the center re-sorts it for onward routing, and the optimizer handles both flow directions without double-counting
**Depends on**: Phase 20
**Requirements**: FLOW-01, FLOW-02, FLOW-03, FLOW-04, VIZ-12, FLOW-05 (P2)
**Success Criteria** (what must be TRUE):
  1. A viewer watching the live map sees consolidation trailers moving spoke→center with non-empty freight manifests and distinct direction styling, alongside the unchanged center→spoke distribution trailers — both directions active simultaneously
  2. Freight inducted at Spoke A can be traced end-to-end through the map: departure from Spoke A (consolidation), arrival and re-sort at center, departure toward Spoke B (distribution) — demonstrating the center cross-dock value
  3. Existing center→spoke distribution continues unbroken: a regression test with `consolidationEnabled: false` (default) produces a byte-identical golden to pre-Phase-21; empty-return consolidation trailers (no pendingAtSpoke freight) depart and arrive without error
  4. The optimizer handles both flow directions without double-counting: stale staged plan entries are cleared via plan supersession, the optimizer idempotency map persists across restarts (Postgres-backed), and `detectAffectedScope` correctly scopes spoke→center legs to `[spokeHubId, centerId]`
  5. (P2) A per-hub inbound/outbound inventory balance display (cross-dock utilization heat) is visible in the operator UI, showing consolidation value numerically
**Plans**: TBD
**UI hint**: yes

### Phase 22: Outbound Delivery
**Goal**: Freight reaching its destination hub exits the network via a `PackageDelivered` terminal event with an on-time SLA flag, projections stay bounded, and delivery highlights appear on the map
**Depends on**: Phase 21
**Requirements**: OUT-01, OUT-02, OUT-03, OUT-04, VIZ-14, OUT-05 (P2)
**Success Criteria** (what must be TRUE):
  1. A viewer watching the live map sees destination hubs briefly highlighted when `PackageDelivered` fires, closing the end-to-end freight lifecycle: induction → transit → consolidation → distribution → delivery
  2. Every package that arrives at its designated destination hub eventually emits `PackageDelivered` (lifecycle ordering test: `PackageDelivered` always follows `PackageArrivedAtHub` for the same package; terminal-completeness test: every package reaches `PackageDelivered` within the sim horizon when `outboundDeliveryEnabled: true`)
  3. `PackageDelivered` carries an `onTime` flag (`deliveredAt <= slaDeadlineIso`) and, in a sustained multi-cycle run, the fraction of on-time deliveries reflects optimizer effectiveness on SLA deadlines drawn from inducted packages
  4. `PackageDelivered` purges the package from all projections (`packageLocation`, `hubInventory`, `zoneEstimate` — DELETE, not upsert), keeping projection table size bounded during a continuous multi-cycle run with `outboundDeliveryEnabled: false` (default) preserving the existing golden byte-identical
  5. (P2) A delivered-out counter and on-time % KPI panel widget shows cumulative delivery performance as a live metric in the operator UI
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 19. Continuous Operation Foundation | 0/7 | In planning | - |
| 20. External Induction | 0/? | Not started | - |
| 21. Bidirectional Freight / Consolidation | 0/? | Not started | - |
| 22. Outbound Delivery | 0/? | Not started | - |

| Milestone | Phases | Status | Shipped |
|-----------|--------|--------|---------|
| v1.0 MVP | 1–5 | ✅ Complete | 2026-06-20 |
| v1.1 Realistic Time Model + Hardening | 6–8 | ✅ Complete | 2026-06-22 |
| v1.2 Driver HOS & Hub Detail | 9–18 | ✅ Complete | 2026-06-22 |
| v2.0 Complete Simulation Model | 19–22 | 🚧 In progress | - |
