# Feature Research

**Domain:** Middle-mile RFID-assisted trailer-loading & hub-to-hub optimization — simulation-driven MVP with realtime USA-map visualization
**Researched:** 2026-06-18
**Confidence:** HIGH (derived from PROJECT.md scope + tech spec §16–§24; categorization/demo-lens is opinionated synthesis)

## Feature Landscape

This is a **proof-of-value demo**, not a pilot. "User expectation" therefore means *what a logistics-savvy
demo audience needs to see to believe the optimization + visibility story*. Table stakes = without it the
demo isn't credible. Differentiators = what makes the demo *compelling* (turns a working engine into a
persuasive narrative). The simulation engine and live USA map are the delivery wrapper that make every
backend capability *visible* — they are themselves table stakes for this MVP.

### Table Stakes (Demo Isn't Credible Without These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Event-sourced operational twin + queries** ("where is package X?", "what's on trailer T?") | The foundation everything reads from; spec §18.1 marks it required from MVP. Demo must answer state queries instantly to prove the twin is real, not faked. | L | Event store + projections (package location, trailer state, hub inventory, audit timeline). Spec §9, Epic 2. Everything below depends on this. |
| **Load-block aggregation** (group by hub/dest/SLA/deadline/handling/size; compute vol/weight; split oversized) | Optimization granularity per spec §11.1, Epic 3. Without blocks there is nothing to LIFO-order. | M | Deterministic grouping + split rules. Block priority assignment. |
| **Rear-to-nose trailer slice model + route unload-order map** | The core domain abstraction (spec §6.4, §7). Single rear-door → accessibility constraint. | M | Ordered slice sequence; maps route stop order to nose→rear positions. |
| **Route-aware LIFO / partial-LIFO load planner** (greedy + local repair) | THE core value (PROJECT.md: "if everything else fails, the load planner must work"). Spec §11.5, Epic 4. | L | Greedy placement + LIFO validation + partial-LIFO bounded-blocker scoring. The hardest engine piece. |
| **Loading instructions output** (load order by zone: nose/middle/rear) | The human-facing artifact of the plan (spec §16.1). Demo shows the dock worker's actual instruction card. | S | Pure rendering of the plan; trivial once planner exists. |
| **Rehandle risk scoring + trailer utilization scoring** (soft 75–90% target) | Quantifies plan quality; feeds KPIs and the objective (spec §7.5, §7.6, §11.6). | M | Rehandle = blocker-cost model; utilization = fill vs soft target band with penalty both sides. |
| **RFID/barcode confidence-scored evidence + zone estimate** (rule-based Bayesian) | Spec §8 positioning philosophy: RFID is probabilistic, never exact coordinates. Demo must *show confidence*, not certainty. | M | Tag→package mapping; confidence-scored zone estimate; rule-based fusion (NOT ML). |
| **Wrong-trailer + missed-unload detection** (severity + recommended action) | The validation payoff (spec §17.1–§17.2, Epic 6). One of the spec's top-3 first-value items. | M | Compares observed vs planned; emits exception with severity + recommended action. Depends on RFID evidence + plan. |
| **Rolling re-optimization** (event-triggered + periodic, freeze windows) | Continuous repair is the "twin" claim (spec §11.9, §4). Demo must show plans *changing* as conditions change. | L | Affected-scope detection, 5–15 min epochs, freeze window for trailers departing <10–15 min. Depends on planner + twin. |
| **Exception alerts** (wrong-trailer, missed-unload, blocked-freight, low-util) | Operator-facing surfacing of every detection (spec §16.2, §17). Drives the alert feed in the UI. | S–M | Alert events with severity + human-readable reason + recommended action. |
| **Audit trail / event timeline** | Auditability is a stated core value & pilot exit criterion (PROJECT.md, spec §23). Replaces the deferred override workflow. | S | Free given event sourcing — render the event/projection timeline read-only. |
| **Realtime USA-map visualization** (OpenLayers/OSM: hubs, trailers in motion, routes, freight/SLA state) | The demo centerpiece (PROJECT.md). Without it the engine is invisible; the map IS the product to the audience. | L | OpenLayers + OSM tiles; animate trailers along routes; color hubs/routes by SLA/freight state. Depends on sim event stream + twin projections. |
| **Simulation engine** (synthetic package/trailer/sensor events over USA hub network) | No real data exists; the sim is the only data source. Must produce *realistic* events incl. RFID noise. | L | Generates scans, movements, RFID reads (with miss/noise), trailer trips. Drives everything downstream. |
| **KPI dashboard** (utilization, rehandle count/min, wrong-trailer, missed-unload, SLA, on-time) | Quantifies the value claim (spec §21). Audience needs numbers, not just a pretty map. | M | Read-only widgets over projections/KPIs. Spec §21.1 operational KPIs are the minimum set. |

### Differentiators (Make the Demo Compelling)

These convert a working engine into a *persuasive story*. They are the spec's underweighted "demo
storytelling" layer that the milestone context flags. Prioritize 2–3, not all.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Before/after KPI comparison** (baseline naive load vs optimized) | The single most persuasive artifact: "rehandle −X%, utilization +Y%." Maps directly to pilot exit criteria (spec §23). Turns "it runs" into "it's worth money." | M | Run a naive/FIFO baseline planner alongside the optimizer on the same sim stream; diff KPIs. **Highest demo ROI.** |
| **Explainable plan reasoning** ("LB-H8 placed rear because unloads first; H10 to nose; avoids 18-min rehandle") | Spec §16.2 alert style + §22 Risk 3 (human acceptance via explainability). Differentiates from black-box optimizers; builds trust. | M | Attach human-readable "why" to each placement & repair decision. Reuses scoring internals. Strong synergy with audit. |
| **Over-carry / hold / reassign recommendations visualized on map** | Shows recovery *intelligence* (spec §11.7, §17.4, Epic 7) — the system doesn't just detect problems, it proposes fixes, drawn as a re-routing animation. | M | Render local-repair actions (split/reassign/hold/over-carry) as map annotations + alert cards. Depends on rolling optimizer. |
| **Scenario knobs** (inject delays, hub congestion, sensor noise, demand spikes) | Lets the presenter *drive the narrative* live: "watch it re-optimize when H7 congests." Makes the demo interactive & repeatable. | M | Sim control panel toggling parameters; triggers re-optimization. Depends on sim engine + rolling optimizer. |
| **RFID confidence heatmaps** (trailer-zone confidence shading; hub read-quality) | Visualizes the probabilistic sensor model (spec §8) — makes "we treat RFID as evidence" tangible instead of a bullet point. | M | Color zones by confidence; overlay on trailer/hub views. Depends on RFID confidence scoring. |
| **Trailer fill / load-sequence visual** (rear→nose block stack per trailer) | Makes LIFO/blocked-freight intuitive to non-experts — see the block that's "trapped." | M | 2D zone-stack diagram (NOT 3D). Bridges engine ↔ audience understanding. |

### Anti-Features (Deliberately NOT Built in v1)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Full 3D package packing / load-stability physics** | "Looks impressive"; real trailers are 3D. | Intractable, distracts from optimization value; spec §4 & §19.2 non-goal. No demo value over zone model. | Optimize at load-block + trailer-zone granularity (rear/middle/nose). 2D fill visual suffices. |
| **ML-based sensor fusion** (HMM, particle filters, ML classifiers) | "AI" buzz; better accuracy. | Needs training data that doesn't exist; spec Phase 5. Adds opacity, hurts explainability. | Rule-based Bayesian confidence scoring — transparent and demo-explainable. |
| **Real RFID/IoT hardware + live WMS/TMS integration** | "Make it real." | Hardware/integration risk is exactly what the sim-driven framing removes; spec §22 Risk 5, PROJECT.md out-of-scope. | Simulation engine generates all events incl. RFID noise. Integration adapters are a later milestone. |
| **Full national single-run optimization** | "Optimize everything at once." | Computationally intractable (spec §22 Risk 2); not how the system is meant to work. | Decomposed, rolling-horizon, scoped to affected hubs/trailers/blocks. |
| **Full what-if simulation / digital-twin policy testing** | "Test policies before rollout." | Spec §18.3 / Phase 5; the sim engine here *drives the operational demo*, it is not a policy sandbox. Conflating the two bloats scope. | v1 sim only feeds the operational twin. Scenario knobs give a *taste* of what-if without the twin machinery. |
| **Human override workflow** (edit/approve plans, hold/ship UI, override capture) | Spec §16.3 lists it; "operators need control." | PROJECT.md scopes UI to **read-only**; override workflow = forms, auth, conflict handling — large, off-centerpiece. | Audit trail captures system recommendations + decisions. Override deferred; v1 is read-only viz + audit. |
| **Exact MILP solvers (Gurobi)** | "Optimal, not heuristic." | Out of scope (PROJECT.md constraints); licensing + JS-ecosystem mismatch. | Greedy + local search + min-cost-flow / VRP heuristics in TS. |
| **Complex dock scheduling optimization** | Completeness. | Spec §19.2 exclusion; orthogonal to the load/route story; adds modeling burden. | Treat dock doors as simple capacity; no scheduling optimizer in v1. |
| **Centimeter-level real-time package localization** | "Know exactly where each package is." | Spec §4/§8 non-goal; physically unreliable RFID. | Probabilistic trailer-zone estimates only. |

## Feature Dependencies

```
[Simulation Engine] ──feeds──> [Event-Sourced Operational Twin]
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        v                             v                             v
[Load-Block Aggregation]      [RFID Confidence Scoring]     [Map / KPI / Audit projections]
        │                             │
        v                             v
[Rear-to-Nose Slice Model]    [Wrong-Trailer + Missed-Unload Detection]
        │                             │         └──feeds──> [Exception Alerts]
        v                             │
[Route-Aware LIFO Planner] <──────────┘ (validation cross-checks plan vs observed)
        │  └──> [Rehandle + Utilization Scoring] ──> [KPI Dashboard]
        │  └──> [Loading Instructions Output]
        v
[Rolling Re-Optimization] ──> [Hold/Reassign/Over-Carry Recommendations]
        │
        v
[Realtime USA Map] <──renders── (twin projections + plans + exceptions + recommendations)

Differentiators (enhance, do not block core):
[Before/After KPI Comparison] ──needs──> [naive baseline planner] + [LIFO planner] + [KPIs]
[Explainable Plan Reasoning]  ──enhances──> [LIFO Planner] + [Rolling Optimizer] + [Audit]
[Scenario Knobs]              ──drive──> [Simulation Engine] + [Rolling Optimizer]
[Confidence Heatmaps]         ──visualize──> [RFID Confidence Scoring] on [Map]
[Recommendations Visualized]  ──visualize──> [Rolling Optimizer repair actions] on [Map]
```

### Dependency Notes

- **Everything depends on the operational twin.** Build event store + projections first; it is the single
  hard prerequisite (spec Phase 1).
- **Detection depends on BOTH a plan AND RFID evidence.** Wrong-trailer/missed-unload compare *planned*
  vs *observed* — so the planner (Phase 2) and RFID scoring (Phase 3) must both exist before exceptions are real.
- **Rolling optimizer depends on the planner + twin + scope detection.** It re-runs and repairs; it cannot
  precede the thing it repairs.
- **Map and KPI dashboard depend on projections, plans, exceptions, and (for differentiators) recommendations.**
  The map is integrative — it visualizes the *outputs* of everything else, so it lands late but should be
  scaffolded early (empty map + hubs) so each engine feature can light up on it incrementally.
- **Before/after comparison requires a deliberate naive baseline planner** — a small extra build, but the
  highest-leverage differentiator; plan for it when building the LIFO planner so both share KPI plumbing.
- **Scenario knobs enhance the sim + optimizer**; they don't block anything and can be added once the
  re-optimization loop is visibly working.

## MVP Definition

### Launch With (v1) — Table Stakes + 2–3 Differentiators

- [ ] Event-sourced operational twin + state queries — foundation; everything reads from it
- [ ] Load-block aggregation — optimization unit
- [ ] Rear-to-nose slice model + route unload-order map — core domain abstraction
- [ ] Route-aware LIFO / partial-LIFO planner (greedy + local repair) — THE core value
- [ ] Loading instructions output — human-facing plan artifact
- [ ] Rehandle + utilization scoring — plan quality + KPIs
- [ ] RFID confidence-scored evidence + zone estimate (rule-based) — probabilistic sensor story
- [ ] Wrong-trailer + missed-unload detection w/ severity + action — validation payoff
- [ ] Rolling re-optimization (event-triggered + periodic, freeze windows) — continuous-repair claim
- [ ] Exception alerts — operator surfacing
- [ ] Audit trail / event timeline — auditability (replaces override workflow)
- [ ] Simulation engine (USA hub network, realistic + noisy events) — the only data source
- [ ] Realtime USA map (OpenLayers/OSM) — the demo centerpiece
- [ ] KPI dashboard — quantifies the value claim
- [ ] **Before/after KPI comparison** (differentiator) — highest demo ROI; needs naive baseline planner
- [ ] **Explainable plan reasoning** (differentiator) — trust + spec Risk-3 mitigation; cheap given scoring internals
- [ ] **Scenario knobs** (differentiator) — lets the presenter drive the live narrative

### Add After Validation (v1.x)

- [ ] RFID confidence heatmaps — once detection is solid and audience wants sensor depth
- [ ] Over-carry/hold/reassign recommendations *visualized on map* — once recovery actions are reliable
- [ ] Trailer fill / load-sequence 2D visual — once map storytelling needs per-trailer drill-down
- [ ] Richer sim scenarios (demand spikes, multi-hub cascades) — when single-knob demos feel thin

### Future Consideration (v2+)

- [ ] Human override workflow + plan editing — when moving from demo toward pilot
- [ ] Real WMS/TMS + RFID hardware adapters — pilot milestone (spec Phase 5+ integration)
- [ ] ML sensor fusion (HMM/particle filter) — when labeled data exists (spec Phase 5)
- [ ] Full simulation/what-if twin for policy testing — spec Phase 5 / Stage 5
- [ ] Full national optimization / exact solvers — only if heuristics prove insufficient at scale
- [ ] 3D packing / visual twin / robotics — far future (spec Stage 6)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Event-sourced twin + queries | HIGH | HIGH | P1 |
| Load-block aggregation | HIGH | MEDIUM | P1 |
| Rear-to-nose slice model | HIGH | MEDIUM | P1 |
| Route-aware LIFO planner | HIGH | HIGH | P1 |
| Loading instructions output | MEDIUM | LOW | P1 |
| Rehandle + utilization scoring | HIGH | MEDIUM | P1 |
| RFID confidence scoring | HIGH | MEDIUM | P1 |
| Wrong-trailer + missed-unload detection | HIGH | MEDIUM | P1 |
| Rolling re-optimization | HIGH | HIGH | P1 |
| Exception alerts | MEDIUM | LOW | P1 |
| Audit trail / timeline | MEDIUM | LOW | P1 |
| Simulation engine | HIGH | HIGH | P1 |
| Realtime USA map | HIGH | HIGH | P1 |
| KPI dashboard | HIGH | MEDIUM | P1 |
| Before/after KPI comparison | HIGH | MEDIUM | P1 (differentiator) |
| Explainable plan reasoning | HIGH | MEDIUM | P2 |
| Scenario knobs | MEDIUM | MEDIUM | P2 |
| Recommendations visualized on map | MEDIUM | MEDIUM | P2 |
| RFID confidence heatmaps | MEDIUM | MEDIUM | P3 |
| Trailer fill 2D visual | MEDIUM | MEDIUM | P3 |

**Priority key:** P1 = must have for the demo · P2 = should have, strong narrative lift · P3 = nice to have, post-validation.

## Demo-Credibility Lens (What Must Be Visible)

The map + dashboard are where belief is won or lost. For a convincing simulation+map demo, these must be
*visible on screen*, not just computed in the backend:

1. **On the map:** hubs, trailers animating along routes, route/SLA color state, freight flow — proves the twin is live.
2. **Plan visibility:** click a trailer → see its rear-to-nose load order + loading instructions + the "why."
3. **Detection in action:** an injected wrong-trailer/missed-unload event fires a visible alert with severity + recommended action.
4. **Re-optimization in action:** trigger congestion/delay via a scenario knob → watch plans repair (reassign/hold/over-carry) live.
5. **Numbers that move:** KPI dashboard with **before/after deltas** (rehandle −%, utilization +%) — the money slide.
6. **Confidence, not certainty:** RFID shown as confidence scores/heatmaps — credibility that the sensor model is honest.

If only one differentiator ships, ship **before/after KPI comparison** — it is what makes the audience
believe the optimization is worth money. The map without moving KPIs is a screensaver; the KPIs without the
map are a spreadsheet. Both together, driven by scenario knobs, are the demo.

## Sources

- `/Volumes/Unitek-B/Projects/jobs/intelliswift/.planning/PROJECT.md` — scope, core value, out-of-scope, constraints (HIGH)
- `rfid_middle_mile_trailer_optimization_tech_spec.md` §16 UX, §17 exceptions, §18 twins, §19 MVP scope/exclusions, §21 KPIs, §22 risks, §23 pilot, §24 backlog/epics (HIGH)
- Categorization, complexity ratings, demo-credibility lens, and before/after-comparison emphasis are opinionated synthesis for THIS sim-driven demo (MEDIUM — judgment, not external sources)

---
*Feature research for: middle-mile trailer optimization (sim-driven MVP + realtime USA map)*
*Researched: 2026-06-18*
