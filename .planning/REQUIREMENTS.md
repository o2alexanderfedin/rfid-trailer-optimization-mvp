# Requirements: v2.0 — Complete Simulation Model

**Defined:** 2026-06-24
**Core Value:** Generate route-aware, LIFO-correct trailer load plans that minimize blocked-freight rehandle and continuously repair them as conditions change — demonstrated live over a simulated USA hub network.

**Milestone goal:** Turn the demo from a finite center→spoke *distribution playback* into a genuine, continuously-running **end-to-end logistics simulation** — freight enters from outside, flows **both directions** through the hub network, and is **delivered out** — while preserving determinism and the event-sourced architecture.

**Keystone constraint — determinism:** every new behavior is opt-in and seeded; with all v2.0 flags off, the existing golden replay is **byte-identical**. New randomness flows through dedicated seeded RNG substreams whose salts are asserted **pairwise-distinct** from all existing salts. Reducers key off `occurredAt` (virtual clock), never wall-clock. New domain events follow the established closed-union + Zod `.strict()` + `assertNever`-exhaustive-reducer pattern.

> Grounding: `.planning/research/SUMMARY.md` (synthesized from 4 parallel research dimensions — Stack/Features/Architecture/Pitfalls — all grounded in line-level codebase reads). **Verdict: zero new runtime dependencies** — all four gaps are pure engine extensions. Build order **CONT → IND → FLOW → OUT**.

**Resolved design decisions (confirmed 2026-06-24):**
1. **`PackageInducted` COEXISTS with `PackageCreated`** — `PackageCreated` = internal center-origin spawn (unchanged); `PackageInducted` = first network-visible entry of externally-originated freight. Preserves existing goldens.
2. **Spoke→spoke freight routes via the center hub** — no direct spoke↔spoke routes; the existing star topology + time-expanded graph handle multi-hop via the center cross-dock (which is itself the consolidation feature).
3. **Optimizer picks up inducted freight automatically via the existing `hub_inventory` projection** — no new optimizer demand-source concept; `PackageInducted` populates `hubInventory[hub].inbound` via the same reducer path as `PackageArrivedAtHub`.

---

## v2.0 Requirements

Requirements for this milestone. Each maps to a roadmap phase (19–22). **P1** = must ship; **P2** = in-scope enhancement (confirmed in scope 2026-06-24).

### Continuous operation (CONT)

- [x] **CONT-01**: The simulation runs **open-ended** (no fixed horizon), advancing until explicitly stopped via a stop-signal. The existing finite `durationTicks` path is preserved unchanged so all golden tests stay byte-identical.
- [x] **CONT-02**: Freight generation **sustains indefinitely across multiple day/cycle periods** (self-rescheduling triggers), not a one-shot finite batch.
- [x] **CONT-03**: A **sim-day / cycle counter** is exposed in the ws state diff and shown in the operator UI, so the viewer can see continuous multi-period operation.
- [x] **CONT-04**: Sustained operation stays **bounded end-to-end** (RAM *and* storage) — (a) the engine is **resumable** via explicit continuation state so the open-ended driver advances by chunks without regenerating the prefix (bounded working set, no O(n²) regen); (b) catch-up projection rebuild uses a watermark checkpoint; (c) the ws send path applies backpressure (`bufferedAmount` guard); (d) the optimizer idempotency map is bounded (LRU eviction); (e) **bounded persisted retention on the opt-in continuous path** — the event log is pruned below the projection watermark and stale projection rows are aged out, so a continuous run does not store all simulation data indefinitely. **Finite/test paths keep the full log → goldens replay-from-0 byte-identical.** The process can run indefinitely without unbounded growth in memory or storage.
- [x] **CONT-05** *(P2)*: Freight departs in a **sort-wave / cut-off rhythm** (burst-quiet-burst cadence) rather than a steady trickle, mirroring real sort windows.

### Determinism keystone (DET)

- [x] **DET-01**: **Every v2.0 feature is opt-in** behind a flag (`runUntilStopped`, `inductionEnabled`, `consolidationEnabled`, `outboundDeliveryEnabled`). With all flags off, the existing seed-42 golden replay is **byte-identical** to pre-v2.0. Enforced as an acceptance gate in every v2.0 phase.
- [x] **DET-02**: **Long-run determinism** — a 10,000-tick seeded run (`simulate({ seed: 42, durationTicks: 10000 })`) produces a byte-identical event hash, verified cross-architecture (x86 + ARM). If hashes diverge, the log-normal sampler is replaced with an integer lookup table.

### External induction (IND)

- [ ] **IND-01**: A new **`PackageInducted`** domain event joins the closed event union (per-event Zod `.strict()` schema, `contract.assert.ts` updated, `validate()` round-trip tested). It **coexists** with `PackageCreated` (Decision 1).
- [ ] **IND-02**: Freight is **inducted at spoke hubs** (not center-only) on a repeating schedule, drawn from a **dedicated seeded RNG substream** (`INDUCTION_RNG_SALT`, asserted pairwise-distinct from all existing salts). `inductionEnabled: false` → zero new events.
- [ ] **IND-03**: Inducted packages carry a **destination hub** (`destHubId`) and an **SLA deadline** (`slaDeadlineIso`); the deadline flows to the optimizer (optional additive `TwinBlock.deadlineMin`) so induction shapes planning priority.

### Bidirectional freight / consolidation (FLOW)

- [ ] **FLOW-01**: **Spoke→center consolidation freight flows** — spoke-origin trailers depart carrying real freight, drained from a new `pendingAtSpoke` manifest queue (the reverse-direction routes are registered at bootstrap via reversed geometry, no new ORS call).
- [ ] **FLOW-02**: The **center hub receives and re-sorts** spoke→center arrivals (inbound unload), enabling Spoke A → Center → Spoke B routing through the center cross-dock (Decision 2).
- [ ] **FLOW-03**: Existing **center→spoke distribution continues unbroken** (regression-safe), and **empty-return legs remain valid** — a spoke→center trailer with no consolidation freight departs/returns without error.
- [ ] **FLOW-04**: The **optimizer is aware of both flow directions** — scope detection and the travel model handle spoke→center legs, and consolidation freight is **not double-counted** at the center (stale staged plan entries are cleared via plan supersession; optimizer idempotency persists across restarts).
- [ ] **FLOW-05** *(P2)*: A **per-hub inbound/outbound inventory balance** display (cross-dock utilization heat) showcases consolidation value.

### Outbound / last-mile delivery (OUT)

- [ ] **OUT-01**: A new **`PackageDelivered`** terminal domain event joins the closed union (Zod `.strict()`, `validate()` round-trip tested), firing **after** `PackageArrivedAtHub` at the destination hub following a seeded outbound dwell (`OUTBOUND_RNG_SALT`, pairwise-distinct).
- [ ] **OUT-02**: **Destination-hub detection** triggers delivery — `PackageArrivedAtHub` is no longer terminal, and every package reaches `PackageDelivered` when outbound delivery is enabled (terminal-completeness verified).
- [ ] **OUT-03**: `PackageDelivered` carries an **`onTime` SLA flag** (`deliveredAt <= slaDeadlineIso`).
- [ ] **OUT-04**: `PackageDelivered` **purges the package from all projections** (`packageLocation`, `hubInventory`, `zoneEstimate` DELETE, not upsert) — the bounded-memory mechanism that makes continuous induction sustainable.
- [ ] **OUT-05** *(P2)*: A **delivered-out counter + on-time %** KPI panel widget surfaces the new outbound flow as a live metric.

### Visualization (VIZ) — continues from VIZ-11

- [ ] **VIZ-12**: Spoke→center **consolidation trailers render with non-empty freight manifests** and **distinct direction styling** on the live map (Phase 21 / FLOW).
- [ ] **VIZ-13**: **Induction events animate on the map** — a pulsing marker at the induction hub on `PackageInducted` (Phase 20 / IND).
- [ ] **VIZ-14**: **Delivery events animate on the map** — a destination-hub highlight on `PackageDelivered` (Phase 22 / OUT).

---

## Future Requirements

Deferred to a future milestone. Tracked but not in the v2.0 roadmap.

### Induction / flow extensions

- **IND-FUT-01**: Mixed-direction same-hub local short-circuit deliveries (freight inducted and delivered at the same hub without linehaul).
- **CONT-FUT-01**: Pacer safety valve for sustained high-speed multi-cycle runs (adaptive tick throttling under load).
- **FLOW-FUT-01**: Returns / reverse logistics as a distinct third flow direction (undeliverable freight flowing back upstream).
- **OPT-FUT-01**: Per-wave, per-hub SLA differentiation in the optimizer objective.

### Production hardening (out of demo scope, noted for completeness)

- **HRD-FUT-01**: Postgres event-store **snapshotting / partitioning** for multi-day continuous runs. _(Update 2026-06-24: basic event-log retention + projection aging were pulled INTO v2.0 CONT-04 per user directive "do not store all simulation data indefinitely"; snapshot-based crash-recovery replay and table partitioning remain future.)_

---

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Last-mile delivery **routing** (door-level VRP to end customers) | v2.0 models freight *leaving* the destination hub as a terminal "delivered out" handoff only; downstream delivery-route optimization stays out of scope (per PROJECT.md boundary). |
| Direct spoke↔spoke routes | Decision 2: cross-spoke freight routes via the center cross-dock; star topology preserved. |
| New optimizer demand-source model for induction | Decision 3: optimizer reads inducted freight via the existing `hub_inventory` projection — no new twin concept. |
| Real RFID/IoT hardware + live WMS/TMS integration | v2.0 remains simulation-driven; integration adapters are a later milestone. |
| New runtime dependencies (DES framework, Kafka/Redis, RNG-lib swap) | Research verdict: all four gaps are pure extensions of the existing custom engine; new deps would add infra risk and (for an RNG swap) invalidate 960+ goldens. |
| Postgres snapshotting/compaction for this milestone | Demo runs hours, not days; 10k events is trivial for Postgres. Deferred to production hardening (HRD-FUT-01). |
| Returns / reverse logistics (third flow direction) | v2.0 scopes induction + bidirectional consolidation + outbound; returns deferred (FLOW-FUT-01). |

---

## Traceability

Phase mapping confirmed by roadmapper 2026-06-24. Continues numbering from v1.2's Phase 18.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONT-01 | Phase 19 | Complete |
| CONT-02 | Phase 19 | Complete |
| CONT-03 | Phase 19 | Complete |
| CONT-04 | Phase 19 | Complete |
| CONT-05 (P2) | Phase 19 | Complete |
| DET-01 | Phase 19 | Complete |
| DET-02 | Phase 19 | Complete |
| IND-01 | Phase 20 | Pending |
| IND-02 | Phase 20 | Pending |
| IND-03 | Phase 20 | Pending |
| VIZ-13 | Phase 20 | Pending |
| FLOW-01 | Phase 21 | Pending |
| FLOW-02 | Phase 21 | Pending |
| FLOW-03 | Phase 21 | Pending |
| FLOW-04 | Phase 21 | Pending |
| VIZ-12 | Phase 21 | Pending |
| FLOW-05 (P2) | Phase 21 | Pending |
| OUT-01 | Phase 22 | Pending |
| OUT-02 | Phase 22 | Pending |
| OUT-03 | Phase 22 | Pending |
| OUT-04 | Phase 22 | Pending |
| VIZ-14 | Phase 22 | Pending |
| OUT-05 (P2) | Phase 22 | Pending |

**Coverage:**
- v2.0 requirements: 23 total (20 P1 + 3 P2)
- Mapped to phases: 23
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-24*
*Last updated: 2026-06-24 — traceability confirmed by roadmapper (phases 19–22)*
