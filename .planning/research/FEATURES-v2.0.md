# Feature Research — Milestone v2.0 "Complete Simulation Model"

**Domain:** Middle-mile parcel hub-and-spoke logistics simulation
**Researched:** 2026-06-23
**Confidence:** HIGH (grounded in real carrier operations + existing codebase)
**Scope note:** This file covers ONLY the 4 audited gaps for v2.0. Everything shipped in v1.0–v1.2 is not re-researched. Features are evaluated as SIMULATION behaviors to model in a deterministic, event-sourced demo — not production WMS/TMS integrations.

---

## Research Findings by Gap Area

### What real middle-mile operations look like (grounding the simulation)

**External induction in real networks:** A package enters a carrier network when a shipper tenders it and the carrier performs an origin scan (or "induction scan"). In real parcel operations this is the first event in the carrier's event ledger: the scanning system captures the tracking number, origin address, destination address, service level (next-day / 2-day / ground), and routes the package to a lane or outbound trailer. The package is assigned a destination hub (the hub nearest the recipient) at this moment. In large networks, induction happens at BOTH spokes (local pickup routes drop freight at spoke facilities) and at center/sort hubs (shippers with dock access tender directly). The key attributes carried from induction forward: origin hub (where inducted), destination hub (routing target within the middle-mile network), service level / deadline (determines priority in load planning), package dimensions/weight class, and a unique tracking id.

**Outbound / last-mile handoff in real networks:** When a package arrives at its destination hub and passes the final sort, it is "tendered to last-mile" — handed to a local delivery arm (DSP, postal service, or the carrier's own delivery fleet). Real events at this boundary: (1) a destination sort scan confirming correct hub, (2) route/manifest build (grouping packages for a delivery route), (3) a "tendered" or "out for delivery" status event — the package leaves the middle-mile network. The boundary is clean: once freight is tendered to the last-mile arm, middle-mile responsibility ends. Door-level vehicle routing to customers is the last-mile carrier's problem and stays out of scope for this simulation.

**Spoke-to-center consolidation in real networks:** Spokes aggregate freight from their service area (local pickups + shipper tenders at the spoke dock) and run one or more linehaul departures per day toward the sort center. At the sort center (center hub), arriving trailers are unloaded, freight is sorted by destination hub, and re-loaded onto outbound trailers for spoke delivery. This is the bidirectional flow: center→spoke for distribution, spoke→center for consolidation. Both directions use the same trailer fleet: a trailer that runs center→spoke delivers outbound freight, then loads inbound freight at the spoke and returns center→spoke, making it genuinely bidirectional.

**Sort waves and day cycles in real operations:** Large parcel hubs run in sort waves — roughly 2–3 per 24-hour cycle. A typical pattern: overnight inbound sort (receiving trailers that departed the previous evening from spokes), morning outbound sort (loading center→spoke delivery trailers for same-day spoke delivery), afternoon/evening inbound sort (receiving the day's spoke pick-ups for next-night linehaul). Cut-off times anchor each wave: a spoke has a "linehaul cut-off" by which freight must be inducted to make the night departure, and a center hub has a "dispatch window" for each outbound leg. In simulation terms: sort waves can be modeled as periodic triggers that generate induction events and mark trailer departure windows.

**Continuous operation:** Real operations run 365/24/7. Freight arrives throughout the day; cut-off windows segment it into departure slots. A simulation must therefore run as an open-ended event loop, generating induction events and trailer cycles that repeat across multiple sort periods without a fixed stop tick.

---

## Feature Landscape

### Table Stakes (Demo Feels Incomplete Without These)

Features a reviewer expects to see in a "complete simulation model" demo. Missing = the demo story breaks.

| Feature | Why Expected | Complexity | Existing Dependencies | Notes |
|---------|--------------|------------|-----------------------|-------|
| **CONT-01: Open-ended run loop** | A simulation that stops after ~120 ticks is clearly finite; a "continuous" demo must visibly sustain flow indefinitely | LOW | `engine.ts` `durationTicks`, `VirtualClock` | Replace hard stop with an epoch-cycle loop; keep seeded determinism by using tick-counter-based triggers not wall-clock |
| **CONT-02: Periodic induction trigger** | Without recurring freight generation, the network drains; sustained flow requires induction events to fire on a repeating schedule | LOW-MEDIUM | `PACKAGE_INTERVAL_TICKS`, engine event queue | Generalize the center-only package generation to fire at multiple hubs on a configurable interval; spoke induction fires at spokes |
| **IND-01: FreightInducted event** | Every package entering the network from outside needs a traceable first event (origin scan analog); `PackageCreated` today is an internal construction, not an entry event | LOW | `PackageCreated`, `@mm/domain` events union | New event type carrying: `hubId` (induction point), `originAddress` (simulated), `destinationHubId`, `slaClass`, `deadline` (epoch minutes), `packageId` |
| **IND-02: Induction at spoke hubs** | Freight entering at spoke locations (not just center) is the defining characteristic of a real network; center-only induction is the v1 limitation being removed | MEDIUM | `PACKAGE_INTERVAL_TICKS`, engine, network topology | The engine must generate `FreightInducted` events at spoke hubs for packages destined for other spokes or center, not just center-spawned packages |
| **IND-03: Destination hub + SLA carried on package** | Load planner and optimizer need destination hub and deadline to route and prioritize; today's packages carry `destinationHubId` but it is always a spoke assigned by the center | LOW | `Package` entity, `PackageCreated`, AGG-04 | `FreightInducted` must carry `destinationHubId` (drawn from seeded RNG over the hub list) and `slaClass`/`deadline`; the existing deadline/SLA plumbing already handles this downstream |
| **FLOW-01: Spoke-origin trailer departure** | Trailers must depart FROM spokes toward the center (consolidation leg) — today empty trailers return without freight | MEDIUM | `TrailerDeparted`, engine routing logic | Engine must load inducted freight at spokes onto trailers before spoke→center departure; the LIFO planner already handles loading, just needs to be called on spoke-origin load plans |
| **FLOW-02: Center inbound unload + re-sort** | Arriving spoke→center trailers must be unloaded at center (currently center only dispatches, never receives) | MEDIUM | `UnloadStarted`, `UnloadCompleted`, `TrailerArrivedAtHub` at center | Center hub must handle inbound unload events; freight unloaded at center re-enters the center hub inventory for outbound sorting |
| **FLOW-03: Center→spoke distribution still works** | The existing center→spoke distribution must continue unbroken alongside spoke→center consolidation | LOW | All v1.0 engine logic | Bidirectional is an extension, not a replacement; existing center→spoke path must remain functionally identical |
| **OUT-01: FreightDelivered event** | Freight leaving the destination hub to last-mile needs a terminal event; `PackageArrivedAtHub` is currently the terminal event but is ambiguous — is this delivery or a transit stop? | LOW | `PackageArrivedAtHub`, projections, `@mm/domain` | New `FreightDelivered` event type: `packageId`, `hubId` (destination hub), `deliveredAt` (epoch), `slaClass`, `onTime` (boolean). Fired when a package at its destination hub is "tendered out" |
| **OUT-02: Destination hub detection** | The engine must know a package has arrived at its assigned `destinationHubId` (vs a transit stop) to trigger `FreightDelivered` | LOW | `PackageArrivedAtHub`, `Package.destinationHubId` | Compare arriving trailer's hub against each unloaded package's `destinationHubId`; if match → emit `FreightDelivered` after unload; otherwise package stays in hub inventory for transit leg |
| **OUT-03: SLA on-time flag at delivery** | The demo KPI story (rehandle reduction, SLA performance) requires visible on-time vs late tracking; without it, the optimizer's deadline awareness has no visible outcome | LOW | `AGG-04` (priority from SLA+deadline), `OPT-08` objective | `FreightDelivered.onTime = (deliveredAt <= deadline)`; fed into KPI projections |
| **VIZ-07: Map shows freight in both directions** | A live map where all trailers only go center→spoke is obviously incomplete; reviewers expect to see spoke→center return legs carrying freight | MEDIUM | `VIZ-02` trailer animation, ws state diffs | Ensure `TrailerDeparted` from spokes carries non-empty manifest visible in the map tooltip; no new map primitives needed, just data flowing through existing viz pipeline |
| **CONT-03: Cycle-counter / sim-day display** | With a continuous run, the observer needs to see "Day N, Sort Wave M" or equivalent to understand what period they're watching | LOW | VIZ KPI panel, ws tick envelope | Add `simDay` and `sortWave` to the ws tick state diff; display in KPI panel |

### Differentiators (Enhance the Demo Story)

Features that make the simulation richer and more persuasive without being required for the "complete" narrative.

| Feature | Value Proposition | Complexity | Existing Dependencies | Notes |
|---------|-------------------|------------|----------------------|-------|
| **CONT-04: Sort wave / cut-off windows** | Real parcel networks run 2–3 sort waves per 24-hour cycle with cut-off times; modeling waves makes the cycle rhythm visible on the map (a burst of departures, then quiet, then burst) | MEDIUM | `PACKAGE_INTERVAL_TICKS`, timing config, optimizer rolling-horizon | Model 2 sort waves per sim day; induction batches build up freight, a cut-off window triggers a departure burst; the optimizer already has freeze-window + rolling-horizon wiring (OPT-05/06) |
| **IND-04: Mixed-direction induction** | Some inducted freight at a spoke is destined for that same spoke's delivery zone (local short-circuit) vs needing to transit through center; modeling both makes the routing decisions richer | MEDIUM | `FreightInducted`, load planner, optimizer | Assign `destinationHubId` with weighted distribution (some fraction same-hub local, rest cross-network); local short-circuit emits `FreightDelivered` directly after induction without a transit leg |
| **FLOW-04: Hub inventory balance display** | After bidirectional flow is live, showing per-hub freight inventory (inbound / outbound / dwell count) as a map heat or panel number demonstrates the optimizer's cross-dock balancing value | MEDIUM | `HUB-07` (hub inventory projection), KPI panel, VIZ | Extend the existing hub projection to track inbound-from-spokes vs outbound-to-spokes count; render in hub tooltip or KPI |
| **OUT-04: Delivered-out counter / delivery rate KPI** | A running tally of freight delivered (+ on-time %) is the most legible signal that the simulation is producing real end-to-end outcomes | LOW | `FreightDelivered`, KPI projection | Append delivery count + on-time % to the existing KPI dashboard (UI-03); reuses existing projection infrastructure |
| **CONT-05: Graceful sim-speed scaling with continuous run** | At higher sim speeds, the paced-loop accumulator must not cause unbounded queue growth as freight accumulates across many cycles; sustained high-speed demo requires the optimizer's rolling horizon to keep pace | MEDIUM | paced-loop, worker-thread optimizer | Document the existing pacer behavior under multi-cycle loads; add a max-queue-depth safety valve if needed |

### Anti-Features (Explicitly Out of Scope for v2.0)

Features that might seem like natural extensions but are out of scope for this milestone — either per PROJECT.md, or because they add complexity without demo value for a proof-of-concept.

| Feature | Why Tempting | Why Out of Scope | What to Do Instead |
|---------|--------------|------------------|--------------------|
| **Last-mile delivery routing (door-level VRP)** | Natural next step after "freight leaves hub" | Explicitly excluded in PROJECT.md; it is a separate domain (delivery routing) adding major scope without proving the middle-mile value | Emit `FreightDelivered` as a terminal event — the last-mile arm is opaque; the demo story is "freight left the middle-mile network on time" |
| **Returns / reverse logistics flow** | Real networks handle returns (consumer→spoke→center) | Adds a third flow direction; the hub graph, optimizer, and load planner would need return-package attributes; not needed to close the "continuous bidirectional" loop | Defer to a hypothetical v3.0; the two-direction center↔spoke flow is sufficient for the demo |
| **Multiple sort waves per hub with different cut-off times** | Real hubs have 2–4 distinct waves with different SLA service classes | Modeling per-wave per-hub SLA windows requires a scheduling layer that dwarfs the optimization changes it enables; the demo does not need this granularity | Model a single uniform sort-wave rhythm across all hubs; waves can be a sim config knob without per-hub differentiation |
| **Real-time shipper tender integration (EDI/API)** | Connects the sim to real shipper data | This is a production integration, not a simulation feature; the v1 constraint ("Simulated only") applies through v2.0 | Generate synthetic induction events from the seeded RNG; do not wire any external data source |
| **Freight manifesting / manifest documents** | Real carriers produce manifests at cut-off | A manifest is a downstream artifact of the load plan; the load plan + LIFO instructions already serve this purpose for the demo | The existing LOAD-08 (human-readable loading instructions) IS the manifest analog for the demo |
| **Live hub-to-hub freight demand forecasting** | Real planners forecast demand to pre-position trailers | Requires a demand model layer; scope is to react to simulated arrivals, not predict them | The rolling-horizon optimizer (OPT-05) already re-plans on induction events; no forward-demand forecast is needed |
| **Per-package GPS tracking / last-known-location** | Seems like a richer VIZ | At this scope, freight is tracked at hub-arrival granularity via `PackageArrivedAtHub` / `FreightDelivered`; package-level sub-hub tracking is not needed and conflicts with the "RFID as probabilistic zone evidence" design | `PackageArrivedAtHub` + `FreightDelivered` provide sufficient package-level audit trail |
| **Induction at arbitrary non-hub locations** | Some carriers have satellite injection points | Adds a third facility type to the topology; not needed for the hub-and-spoke demo | All induction happens at one of the 10 USA hub nodes |

---

## Feature Dependencies

```
[IND-01: FreightInducted event]
    └──enables──> [IND-02: Induction at spoke hubs]
    └──enables──> [IND-03: Destination hub + SLA on package]
    └──requires──> Extend @mm/domain DomainEvent union

[IND-02: Spoke induction]
    └──requires──> [CONT-02: Periodic induction trigger at multiple hubs]
    └──feeds──> [FLOW-01: Spoke-origin trailer departure] (freight to load)

[FLOW-01: Spoke-origin trailer departure]
    └──requires──> [IND-02] (something to load)
    └──requires──> LIFO load planner called on spoke-origin build (LOAD-03 already exists)
    └──feeds──> [FLOW-02: Center inbound unload + re-sort]

[FLOW-02: Center inbound unload]
    └──feeds──> center inventory, which feeds [FLOW-03: center→spoke distribution]
    └──requires──> existing UnloadStarted/UnloadCompleted path at center hub

[OUT-01: FreightDelivered event]
    └──requires──> [OUT-02: Destination hub detection] (know when to fire it)
    └──requires──> [IND-03] (package must carry destinationHubId + deadline)
    └──enables──> [OUT-03: SLA on-time flag]
    └──enables──> [OUT-04: Delivered-out counter KPI] (differentiator)

[CONT-01: Open-ended run loop]
    └──requires──> [CONT-02: Periodic induction trigger] (otherwise loop drains)
    └──enables──> [CONT-03: Cycle-counter display]
    └──enables──> [CONT-04: Sort wave windows] (differentiator — only visible in multi-cycle run)

[VIZ-07: Map shows both-direction freight]
    └──requires──> [FLOW-01] (spoke-origin trailers carry non-empty manifests)
    └──no new map primitives needed] — existing ws pipeline + VIZ-02 trailer animation
```

### Dependency Notes

- **IND-01 requires domain extension:** The `DomainEvent` discriminated union in `@mm/domain` must gain `FreightInducted` and `FreightDelivered` event types. This is a closed union with schema versioning; all consumers (projections, API, sensor-fusion) must handle the new cases via `assertNever` exhaustive checks. This is the highest-impact single change — it touches every package.

- **FLOW-01 requires load planner on spoke-origin build:** The existing LIFO load planner (LOAD-03) is already invoked at center hub departure. It must also be invoked when a spoke-origin trailer is built. The spoke has a smaller inventory to work with (locally inducted freight), so the load plan will be shorter — but the same planner code applies unchanged.

- **CONT-01 + CONT-02 are the prerequisite foundation:** Every other v2.0 feature needs freight to actually exist and flow continuously. The engine must generate `FreightInducted` events on a repeating schedule before any of the directional features can be demonstrated.

- **OUT-02 is trivially derivable from existing data:** Each `PackageArrivedAtHub` already carries `hubId`; the `Package` entity already carries `destinationHubId` (via the `PackageCreated` / `FreightInducted` event). Detection is a single equality check in the unload handler. No new projection needed.

- **VIZ-07 requires no new map primitives:** The existing ws keyframe+delta envelope and `VIZ-02` trailer animation work for any trailer on any route. The only change is that spoke→center trailers now carry non-empty manifests in the state diff, making the tooltip show freight instead of "empty return."

---

## MVP Definition for v2.0

### Must Ship (Table Stakes — v2.0 not "complete" without these)

- [x] **CONT-01** — Open-ended run loop (replace `durationTicks` hard stop with a self-sustaining cycle)
- [x] **CONT-02** — Periodic induction trigger at multiple hubs (freight regeneration)
- [x] **IND-01** — `FreightInducted` domain event (origin scan analog, new event type)
- [x] **IND-02** — Induction at spoke hubs (not center-only)
- [x] **IND-03** — Destination hub + SLA deadline carried on inducted package
- [x] **FLOW-01** — Spoke-origin trailer departures carry freight (consolidation legs)
- [x] **FLOW-02** — Center inbound unload + re-sort handles spoke→center arrivals
- [x] **FLOW-03** — Existing center→spoke distribution continues unbroken
- [x] **OUT-01** — `FreightDelivered` domain event (terminal last-mile tender event)
- [x] **OUT-02** — Destination hub detection triggers `FreightDelivered`
- [x] **OUT-03** — SLA on-time flag on `FreightDelivered`
- [x] **CONT-03** — Sim-day / cycle counter in ws state diff + KPI panel
- [x] **VIZ-07** — Spoke→center trailers show non-empty freight manifests on the map

### Add If Time Allows (Differentiators — v2.0 richer with these)

- [ ] **OUT-04** — Delivered-out counter + on-time % KPI panel widget
- [ ] **CONT-04** — Sort wave / cut-off window rhythm (burst-quiet-burst departure pattern)
- [ ] **FLOW-04** — Per-hub inventory balance display (cross-dock utilization heat)

### Explicitly Deferred (Future Milestones)

- [ ] **IND-04** — Mixed-direction same-hub local short-circuit deliveries (complexity vs demo value)
- [ ] **CONT-05** — Pacer safety valve for sustained high-speed multi-cycle runs (diagnose first)
- [ ] Returns / reverse logistics
- [ ] Last-mile delivery routing
- [ ] Per-wave per-hub SLA differentiation

---

## Feature Prioritization Matrix

| Feature | Demo Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| CONT-01 (open-ended run) | HIGH | LOW | P1 |
| CONT-02 (periodic induction) | HIGH | LOW-MED | P1 |
| IND-01 (FreightInducted event) | HIGH | LOW | P1 |
| IND-02 (spoke induction) | HIGH | MEDIUM | P1 |
| IND-03 (destination + SLA on package) | HIGH | LOW | P1 |
| FLOW-01 (spoke-origin freight) | HIGH | MEDIUM | P1 |
| FLOW-02 (center inbound unload) | HIGH | MEDIUM | P1 |
| FLOW-03 (center→spoke continues) | HIGH | LOW | P1 |
| OUT-01 (FreightDelivered event) | HIGH | LOW | P1 |
| OUT-02 (destination detection) | HIGH | LOW | P1 |
| OUT-03 (SLA on-time flag) | HIGH | LOW | P1 |
| CONT-03 (cycle counter display) | MEDIUM | LOW | P1 |
| VIZ-07 (both-direction map) | HIGH | LOW | P1 |
| OUT-04 (delivery KPI widget) | MEDIUM | LOW | P2 |
| CONT-04 (sort wave rhythm) | MEDIUM | MEDIUM | P2 |
| FLOW-04 (hub inventory balance) | MEDIUM | MEDIUM | P2 |
| IND-04 (local short-circuit) | LOW | MEDIUM | P3 |

**Priority key:** P1 = must ship in v2.0; P2 = ship if in budget; P3 = defer

---

## Complexity and Dependency Analysis by Gap

### Gap 1 — Continuous / Open-ended Operation (CONT-*)

**Core change:** The engine's `durationTicks` parameter becomes a cycle config rather than a hard stop. The engine runs until told to stop (or indefinitely in demo mode), regenerating induction events on a repeating `PACKAGE_INTERVAL_TICKS` schedule at each active hub.

**Why LOW complexity:** The event-queue architecture is already a priority queue; simply removing the tick-limit guard and ensuring the package-generation trigger re-queues itself each time it fires is mechanically simple. The paced-loop (already redesigned with accumulator pacer + worker-thread optimizer) already handles unbounded tick streams — it was built for this.

**Determinism preservation:** A continuous run is still fully deterministic: the seeded RNG draws the same values in the same order given the same seed + same trigger schedule. Golden tests can snapshot a fixed number of ticks from a continuous run.

**Dependency on IND-02:** The open-ended loop only sustains flow if induction fires at spokes as well as center. CONT-01 and IND-02 must be built together.

### Gap 2 — External Induction (IND-*)

**Core change:** Two new domain events (`FreightInducted`), a new RNG-based induction generator in the engine that fires at each hub, and a new substream salt (IND_RNG_SALT) following the established six-salt pattern.

**Why MEDIUM complexity (IND-02):** The engine today generates packages in a single center-specific block. Generalizing to per-hub generation requires iterating over all hubs (or a configured subset), drawing random destination hubs and SLA classes per inducted package, and scheduling the freight for loading at spoke-origin departures. The load planner must be invoked for spoke-origin build plans.

**Event union impact (HIGH priority, LOW code volume):** Adding `FreightInducted` to the `DomainEvent` union in `@mm/domain` ripples to every package that does `switch(event.type)` exhaustive checks. The `assertNever` guard already enforces this — every consumer will fail to compile until it handles the new case. This is by design (type safety) but means touching projections, sensor-fusion, API, and the optimizer. These are mostly trivial `case` additions.

**Existing plumbing reused:** `SlaClass`, `DeadlineBucket`, `PlanningPackage` (from `@mm/domain` planning types) already carry the SLA + deadline attributes. `FreightInducted` can reuse these types directly.

### Gap 3 — Outbound / Last-mile Delivery (OUT-*)

**Core change:** One new domain event (`FreightDelivered`), a destination-detection check in the unload handler (trivial equality), and a new projection counter feeding the KPI panel.

**Why LOW complexity:** The hardest part of OUT-* is IND-03 (carried deadline on the package) — which is itself required by IND-01. Once a package carries `destinationHubId` and `deadline`, the `FreightDelivered` event is one equality check and one event emit. No new routing logic, no new planner code.

**Boundary clarity:** `FreightDelivered` is the clean terminus. The simulation does not model what happens to the package after it leaves the destination hub. The last-mile arm is opaque. This is already called out in PROJECT.md and must be held as a firm boundary in implementation — no door-level delivery routing.

### Gap 4 — Bidirectional Freight (FLOW-*)

**Core change:** The engine's spoke-visit handler (today: unload → empty return departure) becomes: unload → load locally-inducted freight → spoke-origin departure with freight → center arrival → center unload. The load planner is called at spoke departure. The center hub gains an inbound-unload handler.

**Why MEDIUM complexity (FLOW-01/02):** The LIFO planner, trailer model, and unload events already exist and are correct. The engine wiring is the new work: (a) the spoke-visit handler must queue any freight inducted at that spoke for loading before departure; (b) the center hub must handle `TrailerArrivedAtHub` from a spoke origin (previously it only handled center→spoke arrivals for return); (c) the optimizer's time-expanded graph must include spoke→center edges (they likely already exist as undirected routes, but may need directional weight verification).

**Optimizer impact (MEDIUM, verify):** The rolling-horizon optimizer already builds a time-expanded graph over the hub network. Routes are bidirectional (center↔spoke). The min-cost-flow assignment and VRPTW planner must correctly handle freight requests for spoke→center legs. This likely requires checking that the optimizer considers spoke-originating freight (new demand sources) as inputs to the flow assignment, not just center-originating demand.

**Golden test impact:** The existing determinism golden (pre-v2.0) must remain byte-identical when all v2.0 features are disabled (`{inductionEnabled: false, bidirectional: false}`). New feature opts follow the established salt-isolation pattern (a new `IND_RNG_SALT` + feature flag gates).

---

## Sources

- Codebase: `packages/simulation/src/engine.ts`, `packages/domain/src/index.ts`, `packages/simulation/src/network/hubs.ts`, `.planning/PROJECT.md` — HIGH confidence (authoritative)
- [Middle Mile vs Last Mile Logistics (Locus.sh)](https://locus.sh/blogs/middle-mile-vs-last-mile-logistics/) — operational pattern overview, MEDIUM confidence
- [Hub-and-Spoke Structure of Parcel Carriers (Transport Geography)](https://transportgeography.org/contents/geography-city-logistics/distribution-facilities/hub-spoke-structure-parcel-carriers/) — network hierarchy + consolidation flows, MEDIUM confidence
- [Origin Scan: Complete Guide (ParcelPath / ShipScience)](https://www.shipscience.com/what-does-origin-scan-mean-a-comprehensive-guide-60afc/) — induction event attributes + first-entry tracking, MEDIUM confidence
- [Tendered to Delivery Service Provider (RedStagFulfillment)](https://redstagfulfillment.com/tendered-to-delivery-service-provider/) — last-mile tender handoff semantics, MEDIUM confidence
- [Ship Sorter Scanning and Induction (Cognex)](https://www.cognex.com/en/applications/barcode-scanning-and-tracking/ship-sorter-scanning-and-induction) — induction scan operations, MEDIUM confidence
- [Warehouse Cutoff Times and Next-Day Delivery (GetTransport)](https://gettransport.com/articles/warehouse-cutoff-times-next-day-delivery) — cutoff windows + sort wave scheduling, MEDIUM confidence
- [A Simulator for Logistics Systems with Hub-and-Spoke Structure (Academia)](https://www.academia.edu/44145427/A_Simulator_for_Logistics_Systems_with_Hub-and-Spoke_Structure) — academic simulation model for H&S logistics, MEDIUM confidence
- [Parcel Hub Scheduling (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1569190X23000060) — inbound/outbound scheduling in closed-loop hub, MEDIUM confidence
- [Cross-Dock Sortation Middle Mile (SupplyChainBrain)](https://www.supplychainbrain.com/blogs/1-think-tank/post/42982-cross-dock-sortation-the-logical-extension-of-the-middle-mile) — cross-dock + bidirectional flow patterns, MEDIUM confidence

---
*Feature research for: Middle-Mile Trailer Optimization Platform v2.0 — Complete Simulation Model*
*Researched: 2026-06-23 — covers ONLY the 4 audited v2.0 gaps (CONT/IND/OUT/FLOW); replaces stale v1.2 FEATURES.md*
