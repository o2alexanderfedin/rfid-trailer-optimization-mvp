# Feature Research — Milestone v3.0 "Continental OODA Network"

**Domain:** Continental-scale middle-mile parcel hub-and-spoke simulation + decentralized OODA agents + advisory coordination centers
**Researched:** 2026-06-26
**Confidence:** HIGH (real carrier network design) / MEDIUM (OODA-as-event-emitting framing — adapts well-documented patterns, the specific event-sourced fusion is novel)
**Scope note:** This file covers ONLY the 4 NEW v3.0 feature clusters: (1) big-city hub generation, (2) regional-center topology + backbone, (3) OODA step-agents for trucks + hubs, (4) advisory coordination centers. Everything shipped in v1.0–v2.1 (single-center sim, RFID fusion, LIFO planner, rolling-horizon optimizer, HOS/driver model, fuel/rest stops, induction, consolidation, outbound, live map) is NOT re-researched and is treated as an existing dependency. The prior v2.0-scoped feature research is preserved at `FEATURES-v2.0.md`.

This is a SIMULATION/demo. Features are evaluated as deterministic, event-sourced, golden-replayable behaviors — not production WMS/TMS/control-tower integrations. The real-world patterns below are grounding for what "realistic" and "good" look like, not integration targets.

---

## Real-World Grounding (informs every category below)

### 1. How real carriers choose hub locations + how many

Real parcel/LTL networks are **tiered**: super hubs (1–2 national sort centers) → regional hubs (mid-tier, state/region volume) → spoke facilities / delivery stations (hyper-local). [FedEx primer, UPS primer, FreightWaves]

Concrete public numbers (HIGH confidence, multiple sources):

| Carrier (network) | Super/major hubs | Regional hubs | Spoke facilities | Notes |
|---|---|---|---|---|
| FedEx Express | 2 superhubs (Memphis, Indianapolis) | ~7 regional (Anchorage, Fort Worth, Greensboro, Miami, Newark, Oakland, Ontario) | — | ~9 major hub facilities total in Express. |
| FedEx Ground | ~40 major hubs | — | ~700 spokes | Hub:spoke ≈ 1:17. |
| UPS | 264 hubs | — | 745 spoke facilities (Centers) | Hub:spoke ≈ 1:3; air backbone via Louisville Worldport + 5 regional air gateways; **~34 rail facilities** as the cross-country ground backbone. |
| Generic regional ground tier | — | "50–100 regional ground hubs across the US" | — | Consolidate truck traffic for an area. |

**Hub-site selection drivers (real-world):** metro **population / freight demand density**, proximity to interstate corridors, **centrality** (minimize total linehaul miles), real-estate/labor cost, and air/rail access. Site selection is fundamentally a **facility-location / p-median** problem — place K hubs to minimize population-weighted distance to demand. For a demo we approximate this with a population-ranked metro list rather than solving p-median live.

**"Big city" = metro, not city-proper.** Real networks size facilities to the **Metropolitan Statistical Area (MSA)** population, not the incorporated city population (San Jose city > San Francisco city, but the SF Bay metro dwarfs San Jose metro). There are **400+ MSAs**; the **top ~100 MSAs hold a large majority of US population and parcel demand**. A top-100-MSA-derived hub map is the realistic basis. [Census MSA tables, FCC top-100 MSA list]

**Why 1–3 per state is a reasonable demo heuristic (MEDIUM):** It is a *coverage* rule, not how carriers actually allocate (carriers allocate by demand density, so CA/TX/NY get many and Wyoming gets ~1). A pure top-N-MSA selection would leave several low-population states with **zero** hubs (no MSA in the national top-N), which looks broken on a USA map and breaks "every state reachable." The "≥1 and ≤3 per state" rule is a **per-state floor + per-state cap** layered on top of population ranking: guarantee national coverage (floor 1) while preventing CA/TX from dominating (cap 3). This yields ~80–130 hubs (50 states × 1 floor = 50 minimum; population-weighted top metros push the dense states to 2–3). This is a defensible, explainable demo rule — flag it as a *coverage heuristic*, not a claim about real carrier siting.

### 2. How real regional-center networks are structured

- **Tier count for ~100 hubs:** real super-hub tiers are tiny — FedEx Express runs the whole country on **2 superhubs + ~7 regionals**; UPS's cross-country ground backbone is **~34 rail consolidation points** but the *strategic* sort tier is far smaller. For a ~100-hub demo, **6–10 regional centers** is the realistic sweet spot: it mirrors the "one big regional sort per ~10–15 spokes" ratio and matches the count of US **census regions/divisions** (4 regions, 9 divisions) and rough **timezone × north/south** partitions. Fewer than ~5 over-concentrates fan-out (the v2.0 scaling problem returns); more than ~12 fragments consolidation (trailers leave half-empty).
- **Spoke→center assignment:** **nearest-center (great-circle)** is the standard first-cut and is what the design already locked. Real carriers refine with **region/timezone boundaries** (so a hub 5 miles across a region line still sorts with its region) and **capacity balancing** (don't overload one center). Recommendation: **nearest-center as the base rule, with a region/division partition as a tie-break/guard** so assignment is stable and explainable, not jittery near equidistant boundaries.
- **Inter-center backbone topology** — the real tradeoff:

| Topology | Transit time | Consolidation (trailer fill) | Robustness | Edge count (C centers) | Fit for demo |
|---|---|---|---|---|---|
| **Full mesh** (every center↔every center) | Best (1 hop center-to-center) | Worst (thin lanes, half-empty trailers) | High (many paths) | C·(C−1) → ~30–90 legs | Too many thin lanes; clutters the map |
| **Ring** | Worst (up to C/2 hops) | Good | Low (1 cut splits the ring) | C | Cheap but unrealistic + fragile |
| **Hub-of-hubs** (one primary center; others spoke to it) | Medium (≤2 hops) | **Best** (everything consolidates through the primary) | Low (primary = SPOF) | C−1 | Matches FedEx Memphis/Indy reality |
| **Hierarchical / 2-tier mesh** (a small core fully-meshed; others hub-of-hubs onto core) | Good | Good | Good | tunable | **Best balance for ~6–10 centers** |

**Recommendation:** **hub-of-hubs backbone with a small fully-meshed core** (the 2–3 largest centers mesh; remaining centers spoke to their nearest core center). This is exactly the FedEx pattern (Memphis+Indy superhub core, regionals feed in), keeps lane count and on-map clutter low, gives good consolidation, and ≤2-hop center-to-center transit. Full mesh and ring are **anti-features** at this scale (see below). The design notes leave this open; **this is the concrete answer the roadmap should adopt.**

Resulting freight path: `spoke → nearest regional center → [backbone: ≤2 hops, possibly via core] → destination regional center → destination spoke`. This is the documented LTL flow (origin terminal → linehaul between hubs → destination terminal). [STG Logistics, Redwood, RXO]

### 3. OODA / sense-plan-act for trucks + hubs — concrete grounding

OODA (Boyd: Observe → Orient → Decide → Act) is the canonical decision-cycle and is explicitly applied to **autonomous vehicles, robotics, and agentic systems**: Observe = sense world state; Orient = build situational awareness (filtering, prediction); Decide = select an action; Act = execute + control. [ASDLC, USPTO 11734590, EmergentMind]

The robotics **layered-control / hybrid architecture** literature gives the crucial decomposition the design needs (HIGH):

- **Reactive layer** (fast, local, sensor→action, no planning) — horizon **10–100 ms**.
- **Tactical planner** — horizon **1–60 s**.
- **Strategic / mission planner** (deliberative) — horizon **minutes–hours**.
- Hybrid/3-layer + **subsumption** architectures explicitly **separate fast local reactive behavior from slower deliberative oversight**, and higher (slower, broader) layers can *suggest/suppress* but the fast local layer owns immediate feasibility/safety. [Brooks subsumption; layered-control; NASA "Planning in Subsumption"]

**This maps directly onto the v3.0 design:** the **OODA agent = reactive/tactical layer** (owns local feasibility it alone knows — fuel, HOS remaining, position), the **coordination center = strategic deliberative layer** (broad, slow, *advisory*). The agent can always **reject** the strategic layer's suggestion on local-feasibility grounds. This is textbook hybrid robot autonomy, which is strong validation for the locked "advisory-first, agents arbitrate" decision.

**Truck agent — concrete OODA (per step):**
- **Observe:** own position/leg progress (odometer), fuel level, **HOS clock remaining** (drive + duty + cycle), current load/assignment, ETA, and *read from projections*: queue/dock state at next hub, any open `ActionSuggested` addressed to it.
- **Orient:** Will fuel reach the next hub/stop? Will HOS expire mid-leg? Is the next hub congested? Is there a pending suggestion to consider?
- **Decide (seeded, pure):** **proceed** | **divert to fuel stop** | **take rest break** (HOS) | **swap/relay driver at hub** | **accept or reject** a coordinator suggestion (re-route/hold). Local-feasibility decisions (fuel, rest) are **agent-owned and non-overridable** by a coordinator.
- **Act:** emit the existing domain events (`FuelStopStarted`, `RestStarted`, `DriverSwapped`, depart/arrive, `SuggestionAccepted`/`SuggestionRejected`) — reuses v1.2 HOS + v2.x fuel/rest plumbing.

**Hub agent — concrete OODA (per step):**
- **Observe:** inbound queue (trailers/freight awaiting sort), outbound queue by destination lane, **dock/door capacity in use**, current trailer fill levels, cut-off/sort-wave clock, open suggestions.
- **Orient:** Is an outbound trailer full enough to dispatch (vs the 75–90% utilization band)? Is a cut-off approaching (dispatch even if under-full)? Are docks saturated (hold inbound)? Is freight blocked awaiting a connection?
- **Decide (seeded, pure):** **dispatch** an outbound trailer | **hold** for more consolidation / a connecting trailer | **consolidate** (merge partial loads) | trigger a **load-plan** (call the existing LIFO planner) | **accept/reject** a coordinator suggestion (e.g., "hold for inbound from center X").
- **Act:** emit dispatch / hold / consolidation / load-plan-requested events.

**Decision-authority split (the key architectural rule):**

| Decision | Owner | Why |
|---|---|---|
| Fuel divert, rest break, HOS legality, drive/no-drive | **Truck agent (local, binding)** | Only the agent knows exact fuel + HOS clock; safety/legality is non-negotiable; matches reactive-layer authority. |
| Dispatch-vs-hold under cut-off, local consolidation, load-plan trigger | **Hub agent (local, binding)** | Local dock/queue state; immediate feasibility. |
| Cross-hub re-routing, which center to consolidate through, load balancing across centers, lane swaps | **Coordinator (advisory)** | Needs the broad multi-hub view a single agent lacks; but lacks local feasibility, so **suggest only**. |
| Global plan optimization (min-cost-flow / VRPTW) | **Coordinator may invoke existing optimizer** to *generate* suggestions | Preserves proven v1 IP as a recommendation engine, not a binding global solve. |

**OODA step cadence:** step on the **existing deterministic tick / EventQueue**, not wall-clock (mandatory for determinism). **Per-N-tick** (not every tick) for cost control — most ticks an agent has nothing to decide; gate Decide behind cheap Observe/Orient guards (a "is there anything to decide?" predicate) so the common case is O(1). This is the reactive-vs-deliberative horizon separation applied to tick budget.

### 4. Coordination centers / advisory suggestions — control-tower grounding

Real **supply-chain control towers** sit on a maturity ladder: **visibility** (just shows the SLA risk) → **prescriptive** (recommends the fix) → **orchestration/autonomous** (executes within guardrails, logs exceptions for human review). [IBM, Locus, OpenText, Inbound Logistics] The v3.0 coordinator is deliberately at the **prescriptive/advisory** rung: it *recommends*, the agent *arbitrates*. This is also the existing optimizer's "recommendation + human override with audit" model (already locked in PROJECT.md out-of-scope: "Fully automated dispatch with no human override" stays out).

**Suggestion types that matter (from control-tower practice):** **re-route** (lane/path change to avoid congestion or balance centers), **hold** (wait for a connecting trailer / better consolidation), **consolidate** (merge partial loads), **dispatch** (release a trailer now, e.g., cut-off imminent), **driver swap/relay** (fresh driver at a relay hub), **reassign/reallocate load** (move freight to a different trailer/lane). These map cleanly onto events the agents already emit. [Locus: reroute / reallocate / sequence / notify]

**The advisory contract (the differentiator):** coordinator emits `ActionSuggested` (advisory, addressed to a specific agent, with a rationale + expiry). The agent runs its OODA Decide step, checks the suggestion against **local feasibility it alone knows** (fuel, HOS rest due, road closure / blocked dock), and emits **`SuggestionAccepted`** (→ then the binding event) or **`SuggestionRejected`** (with a reason code). This makes the reject path **first-class, auditable, and explainable** — which is exactly the project's core value ("explainable, auditable decisions").

**Guardrails against oscillation / suggestion storms (CRITICAL — this is where naive multi-agent coordination fails):** distributed control-loop literature is explicit that switching/coordination loops oscillate without damping/hysteresis. [multi-agent stability under switching topologies; control-theoretic foundations] Concrete guardrails the demo must implement:

- **Hysteresis / dead-band:** only suggest a re-route if the improvement exceeds a threshold (don't flap a truck between two near-equal paths).
- **Cooldown / debounce:** a min interval between suggestions to the same agent/lane; suppress re-suggesting something just rejected (carry a short "rejected recently" memory).
- **One-suggestion-per-target-per-epoch:** bounded scope per coordinator epoch prevents a suggestion storm; coordinators are **per-regional-center with bounded scope** (already locked), which structurally caps fan-out.
- **Expiry / staleness:** suggestions expire; an agent ignores a stale suggestion (the world moved on).
- **Conflict resolution:** at most one coordinator owns a given agent/lane (partition by region) so two coordinators can't issue contradictory advice; if a suggestion conflicts with an in-flight binding decision, the binding decision wins.
- **Determinism:** all of the above must be **seeded/pure** and tick-driven so the golden replay is byte-identical.

---

## Feature Landscape

### Table Stakes (a continental network demo looks broken without these)

| Feature | Why Expected | Complexity | Notes / Dependencies |
|---|---|---|---|
| **Big-city hub generation (1–3/state, ~80–130)** from a curated, ranked metro dataset | A "continental" demo with 10 hubs isn't continental. Static/deterministic (no clock/RNG) to stay golden-reproducible. | MEDIUM | Generalizes `hubs.ts` (10 fixed IATA). Needs a committed top-MSA dataset (name/state/lat-lon/pop). **Dep:** none upstream; everything downstream depends on it. |
| **Multi-center topology** (engine supports >1 center) | Single-center star can't scale to 100+ hubs (the v2.0 stall). Real networks are multi-tier. | HIGH | **Real change** to `buildRoutes` (currently centers on `USA_HUBS[0]`), the freight-flow model, and optimizer/twin scope. **Dep:** big-city hubs; existing routes/freight-flow. |
| **Nearest-center spoke assignment** (great-circle) | Standard first-cut in real networks; design-locked. | LOW | Pure great-circle (already have `haversineKm` + `greatCircle`). Add region/division tie-break for stability. **Dep:** hubs + centers chosen. |
| **Inter-center backbone** (multi-hop center→center freight) | LTL/parcel freight flows spoke→hub→linehaul→hub→spoke; without a backbone, centers are islands. | MEDIUM | **Recommendation: hub-of-hubs with a small meshed core** (see table above). **Dep:** centers chosen; great-circle geometry. |
| **Great-circle arc geometry for new legs** | ORS road geometry doesn't scale to hundreds of legs; design-locked. | LOW | Already implemented (`greatCircle`, `buildRoutes` falls back to it). Just stop expecting per-leg ORS. **Dep:** none. |
| **OODA `step()` per truck + per hub** emitting existing domain events | The decentralized decision model IS the milestone; agents must make the local calls (fuel/rest/dispatch/hold) the global optimizer used to. | HIGH | Observe reads projections; Decide is seeded+pure; Act emits existing events. **Dep:** HOS engine (v1.2), fuel/rest (v2.x), consolidation/load-planner (v1/v2), projections. **Determinism keystone.** |
| **Agent-owned local feasibility** (fuel/HOS/rest binding, non-overridable) | A coordinator that could override a fuel/HOS-illegal move would be unrealistic and unsafe. | MEDIUM | Reuses v1.2 HOS + v2.x fuel/rest as the binding constraints. **Dep:** HOS + fuel/rest. |
| **Coordination centers as advisory process-managers** (`ActionSuggested`, one per region, bounded scope) | The "suggest, don't command" model is the locked design + matches control-tower prescriptive rung + project's no-full-automation rule. | HIGH | ES process-manager subscribing to truck/hub events. **Dep:** OODA agents + events; multi-center topology (one coordinator per center). |
| **Accept/reject suggestion contract** (`SuggestionAccepted` / `SuggestionRejected` w/ reason) | Without a first-class reject path, "advisory" is fiction. Reject is the explainability moment. | MEDIUM | Agent's OODA Decide arbitrates. **Dep:** advisory coordinator + agent feasibility checks. |
| **Oscillation guardrails** (hysteresis, cooldown, expiry, conflict partition) | Naive coordination flaps; a flapping demo is worse than no coordinator. | MEDIUM | Seeded/pure; per-region scope caps fan-out. **Dep:** advisory contract. |
| **New flag-gated goldens; flags-off byte-identical to v2.0** | Determinism keystone; OODA changes the event stream by design. | MEDIUM | Every feature behind a flag. **Dep:** all of the above. |
| **Scale visualization** (100+ hubs + backbones + suggestion overlays, no clutter) | The map is the demo centerpiece; 100+ hubs naively rendered is a hairball. | MEDIUM-HIGH | LOD/clustering, backbone styled distinct from spokes, suggestion overlays toggleable. **Dep:** topology + events to render. |
| **Sustained continental-run performance** | The whole point is *not* stalling at scale. | HIGH | O(active) per-agent/per-coordinator cost; per-N-tick stepping; incremental snapshot (carry-over debt). **Dep:** OODA + coordinators; `twin-snapshot` incremental follow-up. |

### Differentiators (set this demo apart)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **Visible reject-with-reason** (truck rejects a coordinator re-route because fuel/HOS won't allow it, shown on map + alert feed) | The single most compelling "this is smart and honest" moment — local knowledge beats central advice, auditable. Directly showcases core value. | MEDIUM | Reuses alert feed (UI-01) + audit timeline (UI-02). |
| **Coordinator-uses-optimizer** (the proven v1 min-cost-flow / VRPTW becomes the suggestion engine, per-center bounded scope) | Preserves the hardest-won IP and reframes it as decentralized advice — both more scalable AND a better story than "global solve." | HIGH | **Dep:** existing optimizer; bounded per-center scope. Exact coupling (coordinator calls optimizer synchronously per epoch, or off the worker-optimizer?) is a roadmap research point. |
| **Hub-of-hubs core animated as a freight backbone** on the map (distinct visual tier) | Reads instantly as "national network," not "10 dots." Strong continental-scale visual. | MEDIUM | Style core lanes thicker/distinct; LOD. |
| **Per-agent explainable rationale** (every OODA Decide carries a "why": proceed/divert/hold + the observation that triggered it) | Continues the project's per-placement-rationale tradition into the agent layer; makes the decentralized brain inspectable. | MEDIUM | Fold rationale into the emitted events (already a pattern). |
| **Coordinator advisory overlay** (suggestion arrows that turn green on accept / red on reject) | Live, legible proof the advisory loop is working without cluttering steady state. | MEDIUM | Toggleable overlay; expiry fades stale suggestions. |

### Anti-Features (tempting, but wrong for this milestone)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Full-mesh inter-center backbone** | "Fastest center-to-center, every center connected." | C·(C−1) thin lanes → half-empty trailers (kills consolidation), map clutter, and edge explosion at 8–10 centers. | Hub-of-hubs + small meshed core (≤2 hops, good fill). |
| **Binding/commanding coordinators** (control tower that executes) | "Real control towers orchestrate autonomously; just let it act." | Violates the locked advisory-first decision + the project's explicit "no fully automated dispatch without override" boundary; removes the reject/explainability moment that IS the value; lets central advice override fuel/HOS feasibility the agent alone knows. | Advisory `ActionSuggested` + agent arbitration; keep human/agent override with audit. |
| **True agent-based-model rewrite** (replace the EventQueue with per-tick autonomous agent loops) | "Agents should be real autonomous loops." | Explicitly **rejected** in design notes — destroys event-sourcing, seeded determinism, and byte-identical replay (the non-negotiable keystone). | OODA as an event-*emitting* `step()` layered on the existing tick/EventQueue; event log stays source of truth. |
| **Live per-leg ORS road geometry at 100+ hubs** | "Real roads look better." | Hundreds of legs × live ORS = non-deterministic, slow, rate-limited; doesn't scale; design-locked against it. | Great-circle arcs (free, instant, deterministic) for the new continental legs. |
| **p-median / live facility-location optimization for hub siting** | "Pick mathematically optimal hub sites." | Adds a whole optimization subproblem + nondeterminism risk for ~zero demo value; real value is a believable map, not provably-optimal siting. | Static population-ranked top-MSA dataset + per-state floor/cap heuristic (deterministic, explainable). |
| **Per-tick Decide for every agent** | "Most responsive." | O(agents × ticks) cost re-creates the v2.0 stall; most ticks have nothing to decide. | Per-N-tick stepping + a cheap "anything to decide?" guard so the common case is O(1). |
| **Unbounded / global coordinator** (one coordinator sees all hubs) | "Simpler — one brain." | Recreates the global-solve scaling pressure v3.0 exists to remove; enables suggestion storms + cross-region conflicts. | One coordinator per regional center, bounded scope, region-partitioned ownership. |
| **Suggestions without expiry/hysteresis** | "Just send the best advice continuously." | Flapping / suggestion storms / oscillation — documented failure mode of undamped coordination loops. | Hysteresis dead-band, cooldown, expiry, one-per-target-per-epoch, reject-memory. |
| **Async-queue (Promises/microtasks) inside the sim core** | "We vendored it; use it everywhere." | Microtask scheduling is non-deterministic → breaks golden replay. Design-locks it to **runtime plumbing only**. | Use `@alexanderfedin/async-queue` only for worker handoff / ws backpressure / DB batching — never the deterministic sim/agent/coordinator decision path. |

---

## Feature Dependencies

```
[Big-city hub dataset + ranking (1–3/state)]
        └──requires──> (nothing upstream — the root)
                 │
                 ▼
[Multi-center topology (engine supports >1 center)]
        ├──requires──> [Big-city hubs]
        ├──requires──> [existing buildRoutes / freight-flow (v1)]   (must be generalized)
        │
        ├──> [Nearest-center spoke assignment]  (great-circle; +region tie-break)
        └──> [Inter-center backbone: hub-of-hubs + meshed core]  (great-circle arcs)
                 │
                 ▼
[OODA step() agents (truck + hub)]
        ├──requires──> [Multi-center topology]  (agents act over the new network)
        ├──requires──> [HOS engine (v1.2)]      (truck feasibility)
        ├──requires──> [Fuel/rest stops (v2.x)] (truck feasibility)
        ├──requires──> [Consolidation + LIFO load planner (v1/v2)]  (hub Act)
        └──requires──> [projections]            (Observe reads these)
                 │
                 ▼
[Advisory coordination centers (ES process-manager, per region)]
        ├──requires──> [OODA agents + their emitted events]  (subscribes to them)
        ├──requires──> [Multi-center topology]               (one coordinator per center)
        ├──enhanced-by──> [existing optimizer (min-cost-flow/VRPTW)]  (suggestion engine)
        │
        └──> [Accept/Reject contract]
                 ├──requires──> [agent local-feasibility checks (HOS/fuel/dock)]
                 └──> [Oscillation guardrails (hysteresis/cooldown/expiry/conflict)]

[Scale viz + perf]  ──renders/sustains──>  all of the above
[New flag-gated goldens]  ──gates──>  every feature (flags-off == v2.0 byte-identical)
[async-queue]  ──plumbing-only──>  worker handoff / ws backpressure / DB batching  (NOT sim core)
```

### Dependency Notes

- **Multi-center topology is the linchpin** — it depends on big-city hubs AND requires a real rewrite of `buildRoutes` (today centers on `USA_HUBS[0]`). Build it before OODA/coordinators; everything else assumes >1 center.
- **OODA agents depend on the entire existing operational stack** — they don't replace HOS/fuel/consolidation/load-planner, they *invoke* them as the local-feasibility and Act machinery. This is reuse, not rebuild — lower risk than it looks, but the integration surface is wide.
- **Coordinators depend on agents existing first** (they subscribe to agent-emitted events). Sequence: topology → agents → coordinators. Matches the design-notes build order.
- **Optimizer is an enhancer, not a hard dependency, of coordinators** — coordinators *may* call it to generate suggestions; a coordinator could emit rule-based suggestions without it. This lets the roadmap ship a rule-based coordinator first and wire the optimizer in as a differentiator.
- **Guardrails depend on the accept/reject contract**, which depends on agent feasibility checks (HOS/fuel/dock). Don't ship suggestions before the reject path + hysteresis exist, or the demo flaps.
- **Determinism flag-gating wraps everything** — each feature flag-off must leave the v2.0 golden `3920accc…` byte-identical; the new OODA model gets its own goldens.

---

## MVP Definition (for this milestone)

### Build First (topology foundation — de-risk the engine change)

- [ ] **Big-city hub generation** (curated top-MSA dataset → 1–3/state, ~80–130, deterministic) — root dependency, no upstream risk.
- [ ] **Multi-center topology** (generalize `buildRoutes` to N centers; nearest-center assignment; **hub-of-hubs + small meshed core** backbone; great-circle arcs) — the linchpin engine change; ship + golden before agents.
- [ ] **Scale viz baseline** (render 100+ hubs + backbone tiers without clutter) — needed to *see* the topology is right.

### Then (the decentralized brain)

- [ ] **OODA truck agent** (Observe fuel/HOS/position/queue → Decide proceed/divert/rest/swap → Act via existing events).
- [ ] **OODA hub agent** (Observe queues/docks/fill/cut-off → Decide dispatch/hold/consolidate/plan → Act).
- [ ] **New flag-gated goldens** for the OODA model; verify flags-off == v2.0.

### Then (advisory coordination — the headline differentiator)

- [ ] **Advisory coordinators** (one per region, bounded scope, ES process-manager) emitting `ActionSuggested` — start **rule-based** suggestions (reroute/hold/consolidate/dispatch).
- [ ] **Accept/Reject contract** with reason codes + **visible reject-with-reason** (the explainability moment).
- [ ] **Oscillation guardrails** (hysteresis, cooldown, expiry, region-partition conflict avoidance).

### Add After Validation (within or just after milestone)

- [ ] **Coordinator-uses-optimizer** (wire the proven min-cost-flow/VRPTW in as the suggestion engine) — high value, but ship rule-based first to de-risk.
- [ ] **Advisory overlay polish** (accept-green/reject-red suggestion arrows, expiry fade).
- [ ] **Incremental `twin-snapshot`** (fold from a cursor instead of full event-log scans) — perf carry-over, needed for long continental runs.

### Defer (out of this milestone)

- [ ] **Binding/orchestration coordinators** — violates advisory-first + no-full-automation boundary.
- [ ] **p-median live hub siting** — anti-feature; static ranked dataset is enough.
- [ ] **Live ORS geometry at scale** — anti-feature; great-circle only.
- [ ] **Capacity-balanced / ML hub assignment** — nearest + region tie-break is sufficient for the demo.

## Feature Prioritization Matrix

| Feature | User/Demo Value | Implementation Cost | Priority |
|---|---|---|---|
| Big-city hub generation (1–3/state) | HIGH | MEDIUM | P1 |
| Multi-center topology + nearest assignment | HIGH | HIGH | P1 |
| Hub-of-hubs + meshed-core backbone (great-circle) | HIGH | MEDIUM | P1 |
| Scale visualization (100+ hubs, no clutter) | HIGH | MEDIUM-HIGH | P1 |
| OODA truck agent | HIGH | HIGH | P1 |
| OODA hub agent | HIGH | HIGH | P1 |
| Agent-owned local feasibility (fuel/HOS/dock binding) | HIGH | MEDIUM | P1 |
| New flag-gated goldens (flags-off == v2.0) | HIGH (keystone) | MEDIUM | P1 |
| Advisory coordinators (`ActionSuggested`, rule-based) | HIGH | HIGH | P1 |
| Accept/Reject contract + visible reject-with-reason | HIGH | MEDIUM | P1 |
| Oscillation guardrails | HIGH (else demo flaps) | MEDIUM | P1 |
| Sustained continental-run perf | HIGH | HIGH | P1 |
| Coordinator-uses-optimizer (suggestion engine) | HIGH | HIGH | P2 |
| Advisory overlay polish (accept/reject arrows) | MEDIUM | MEDIUM | P2 |
| Incremental twin-snapshot (perf) | MEDIUM | MEDIUM | P2 |
| Region/division tie-break on assignment | MEDIUM | LOW | P2 |
| Capacity-balanced hub assignment | LOW | MEDIUM | P3 |

**Priority key:** P1 = must have for the milestone · P2 = should have, within/just after · P3 = nice to have, defer.

## Concrete Realistic Defaults (adopt these in REQUIREMENTS/roadmap)

| Decision point (design-notes open question) | Recommended default | Confidence | Basis |
|---|---|---|---|
| "Big city" ranking | **Top US MSAs by metro population** (committed static dataset: name/state/lat-lon/pop) | HIGH | Real carriers size to MSA, not city-proper; 400+ MSAs, top ~100 = most demand. |
| Hubs per state | **floor 1, cap 3**, fill by MSA rank → **~80–130 hubs** | MEDIUM | Coverage heuristic (floor guarantees every-state reachability, cap prevents CA/TX dominance). |
| Number of regional centers | **6–10** (start ~8) | MEDIUM | Mirrors FedEx 2 superhubs + ~7 regionals; ~census 9 divisions; ~1 center per 10–15 hubs; avoids both over-fan-out (<5) and thin-consolidation (>12). |
| Center selection | **largest-metro per region/timezone partition** | MEDIUM | Real super-hub tier sits on biggest metros + corridor centrality. |
| Spoke→center assignment | **nearest-center (great-circle)** + **region/division tie-break** for boundary stability | HIGH (nearest) / MEDIUM (tie-break) | Design-locked; tie-break prevents jitter near equidistant centers. |
| Backbone topology | **hub-of-hubs with a small (2–3) fully-meshed core** | MEDIUM | FedEx Memphis/Indy pattern; ≤2-hop transit, best consolidation, low map clutter, C−1+small-mesh edges. |
| Leg geometry | **great-circle arcs** (no ORS) | HIGH | Design-locked; free/instant/deterministic at scale. |
| OODA cadence | **per-N-tick + "anything-to-decide?" guard** (Decide gated; Observe cheap) | MEDIUM | Reactive-vs-deliberative horizon separation; controls per-step cost. |
| Coordinator output | **advisory `ActionSuggested`** (accept→binding event); **not** binding commands | HIGH | Design-locked; control-tower prescriptive rung; project no-full-automation rule. |
| Coordinator↔optimizer | **coordinator may invoke existing optimizer to generate suggestions, per-center bounded scope; ship rule-based first** | MEDIUM | Preserves IP as suggestion engine; exact sync/async coupling is a roadmap research point. |
| Suggestion types | **reroute, hold, consolidate, dispatch, driver-swap/relay, reassign-load** | HIGH | Control-tower practice (reroute/reallocate/sequence) mapped to existing events. |
| Guardrails | **hysteresis dead-band + cooldown/debounce + expiry + one-per-target-per-epoch + reject-memory + region-partition conflict ownership** | HIGH | Documented undamped-coordination failure mode; all seeded/pure for determinism. |
| async-queue scope | **runtime plumbing only** (worker handoff / ws backpressure / DB batching) — never sim core | HIGH | Microtask scheduling is non-deterministic → would break golden replay. |

## Sources

Real network design + hub counts:
- [On the Seams — UPS distribution network](https://ontheseams.substack.com/p/a-brief-primer-on-upss-distribution) — 264 hubs / 745 spokes; ~34 rail backbone facilities; Louisville Worldport + 5 regional air gateways. HIGH.
- [On the Seams — FedEx distribution network](https://ontheseams.substack.com/p/a-brief-primer-on-fedexs-distribution) (+ search synthesis) — FedEx Express 2 superhubs (Memphis, Indianapolis) + ~7 regionals; FedEx Ground ~40 hubs / ~700 spokes. HIGH.
- [FreightWaves — last-mile sortation centers](https://www.freightwaves.com/news/two-last-mile-parcel-carriers-open-large-us-sortation-centers) — super-hub / regional-hub / delivery-station tiering; ~100 hubs+stations + 30 linehaul routes; 70% of US population coverage. MEDIUM.
- [STG Logistics — How LTL logistics networks operate](https://www.stgusa.com/news-notices/ltl-logistics/) / [Redwood — hub-and-spoke in LTL](https://www.redwoodlogistics.com/insights/the-hub-and-spoke-distribution-model-and-why-it-works-for-ltl) / [RXO — types of LTL carriers](https://rxo.com/resources/shipper/ltl-carrier-types/) — origin terminal → linehaul between hubs → destination terminal flow; national vs multi-regional dense networks. MEDIUM-HIGH.

Metro population / hub siting:
- [Census — Metro/Micro statistical area population tables](https://www.census.gov/data/tables/time-series/demo/popest/2020s-total-metro-and-micro-statistical-areas.html) / [Wikipedia — MSA](https://en.wikipedia.org/wiki/Metropolitan_statistical_area) — 400+ MSAs; MSA = ≥50k urban core; the basis for "big city = metro." HIGH.
- [FCC — 100 largest MSAs by population (PDF)](https://wireless.fcc.gov/wlnp/documents/top100.pdf) — concrete top-100 ranked list usable as the dataset basis. HIGH (list); verify current populations against Census.
- [Optimizing Metro-Based Logistics Hub Locations (MDPI Sustainability)](https://doi.org/10.3390/su17104735) — hub siting as a metro-population-weighted facility-location problem. MEDIUM.

OODA / agent decision loops / robot autonomy:
- [ASDLC — OODA loop explained](https://asdlc.io/concepts/ooda-loop/) / [EmergentMind — OODA dynamic decision cycle](https://www.emergentmind.com/topics/observe-orient-decide-act-ooda-loop) — Boyd OODA phases + agentic application. HIGH (framework).
- [USPTO 11734590 — automating OODA for cognitive autonomous agents](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11734590) — OODA virtual layers for autonomous vehicles (observe=sense, orient=Kalman/predict, decide=select, act=control). MEDIUM-HIGH.
- [Wikipedia — Subsumption architecture](https://en.wikipedia.org/wiki/Subsumption_architecture) / [Robotics Architecture Authority — layered control](https://roboticsarchitectureauthority.com/layered-control-architecture) / [NASA NTRS — Planning in Subsumption Architectures](https://ntrs.nasa.gov/api/citations/19950005134/downloads/19950005134.pdf) — reactive/tactical/strategic horizon separation (10–100ms / 1–60s / min–hours); fast-local owns feasibility, slow-broad advises. HIGH (maps to agent-vs-coordinator authority split).

Control tower / advisory + coordination stability:
- [IBM — supply chain control tower](https://www.ibm.com/think/topics/control-towers) / [Locus — control towers in decision-making](https://locus.sh/blogs/control-towers-supply-chain-decision-making/) / [OpenText](https://www.opentext.com/what-is/supply-chain-control-tower) / [Inbound Logistics](https://www.inboundlogistics.com/articles/supply-chain-control-tower/) — visibility→prescriptive→orchestration maturity; reroute/reallocate/sequence/notify action types; execute-within-guardrails + exception logging. MEDIUM-HIGH.
- [Dynamic LTL planning in hyperconnected hub networks (arXiv 2506.10290)](https://arxiv.org/pdf/2506.10290) — multi-carrier hub-network dynamic planning; consolidation vs transit tradeoffs. MEDIUM.
- [Stability of multi-agent systems under switching topologies (Engineering.org.cn)](https://www.engineering.org.cn/engi/EN/10.1016/j.eng.2020.05.006) — coordination loops need damping/shared stability budget or a supervisory regulator → hysteresis/cooldown rationale. MEDIUM.

---
*Feature research for: v3.0 Continental OODA Network (big-city hubs · regional centers · OODA agents · advisory coordinators)*
*Researched: 2026-06-26*
