# Project Research Summary

**Project:** Middle-Mile Trailer Optimization Platform — Milestone **v3.0 "Continental OODA Network"**
**Domain:** Continental-scale, event-sourced, deterministic discrete-event logistics simulation (golden-replay keystone)
**Researched:** 2026-06-26
**Confidence:** HIGH (codebase-grounded integration + determinism; registry-verified stack) / MEDIUM-HIGH (topology + coordination, where the three sources diverged and are reconciled below)

> **This is a SUBSEQUENT milestone on a shipped product** (v1.0–v2.1: single-center sim, RFID fusion, LIFO planner, rolling-horizon optimizer, HOS, fuel/rest, full freight lifecycle, live map). The v1–v2 stack/architecture is NOT re-evaluated. This synthesis covers ONLY the four new v3.0 capability clusters and how they layer onto the deterministic core without breaking byte-identical replay. It feeds requirements + roadmap authoring, so it is deliberately decisive.

---

## Executive Summary

v3.0 grows the network from 10 fixed hubs to a **continental topology (~80–130 big-city hubs, 1–3 per state, on a small set of regional sort centers)** and replaces the single global rolling optimizer with a **decentralized OODA model**: every truck and hub gets a deterministic `step()` (Observe→Orient→Decide→Act) that emits domain events, and per-center **coordination centers** (event-sourcing process-managers) observe those events and emit **advisory** `ActionSuggested` events that agents arbitrate against local feasibility (fuel, HOS, road-closure) they alone know. This is how real tiered parcel networks (FedEx 2 superhubs + ~7 regionals; UPS hub/spoke + rail backbone) and modern hybrid robot-autonomy / control-tower architectures actually work: a slow, broad, *advisory* strategic layer over a fast, local, *binding* reactive layer. The single most compelling demo moment — and the project's core "explainable, auditable" value extended into the agent layer — is a **visible reject-with-reason** (a truck rejects a coordinator re-route because fuel/HOS won't allow it).

The recommended approach adds **zero new heavy runtime dependencies**: the big-city dataset is a build-time-generated, committed, checksummed JSON (reusing the proven `road-geometry.generated.json` pattern); great-circle geometry keeps the existing pure `greatCircle` function untouched; 100+ hubs render with built-in OpenLayers `ol/source/Cluster` + `declutter` (no WebGL); and the vendored `@alexanderfedin/async-queue` is confined to runtime plumbing only (worker handoff, ws backpressure, DB batching), banned from the deterministic core by ESLint. The model layers entirely **inside** the one generation core (`runToHorizon`) as new flag-gated `SimTask` variants (`stepAgents`, `stepCoordinators`) emitting new event types into the same log — never a parallel path.

**Determinism is the keystone and the dominant risk.** Every feature is flag-gated; flags-off must stay byte-identical to the v2.0 golden `3920accc…`, and the OODA/coordination model gets its own new goldens. The eight critical determinism guards (sorted agent step order, no transcendentals in hashed payloads, stable-id-derived seeded substreams, frozen mid-tick observation surface, async-queue out of the core, no `Date.now`/`Math.random`, canonical JSON serialization, flags-off non-drift) are non-negotiable. Two perf traps are first-class blockers, not follow-ups: the **`applyHubInventory` full-table scan** (a latent v2.1-style O(events×hubs) freeze that becomes *active* the moment hub count jumps — a **P1-BLOCKING** fix) and the per-center **coordinator scope/oscillation/deadlock** failure modes (handled by hysteresis, seeded-jitter backoff, sim-time TTL, single-owner leases, reject-path pruning). The build order is hard-sequenced: topology must ship and golden before agents; agents must exist before coordinators can arbitrate.

---

## Key Findings

### Recommended Stack

**Net new heavy runtime dependencies for v3.0: ZERO.** (Full detail: `.planning/research/STACK.md`.) Every new capability is static data, an existing library, or a single zero-dep vendored queue confined to non-deterministic plumbing. The repo's standing bias — *prefer committed static data + custom TS over heavy runtime deps* — drives every recommendation.

**Core technologies (additions only):**
- **Big-city dataset → committed `us-big-cities.generated.json`** — a dev-only build-time generator (mirroring `scripts/precompute-routes.ts`) consumes **SimpleMaps US Cities Basic** (CC BY 4.0; clean 2-letter `state_id` + `population` + `ranking` + IANA `timezone`) *or* the offline **`all-the-cities`** npm (MIT/GeoNames; needs admin1→postal mapping). Runtime imports only the committed JSON with a coords checksum — golden replay never couples to an upstream data version. **Two flagged tasks:** (1) **dataset attribution compliance** (SimpleMaps backlink OR "city data © GeoNames CC BY 4.0" credit in footer/README) is a non-optional roadmap task; (2) state→region/timezone metadata is best **transcribed** as a 50-row const (determinism-safe), not a runtime dep.
- **Great-circle geometry — KEEP the existing pure `greatCircle`** (`routes.ts`). Do NOT adopt `@turf/great-circle` or `geodesy`: different numerics would invalidate flags-off goldens, turf adds transitive deps + GeoJSON impedance + antimeridian-split, geodesy is stale (2022). New multi-center legs simply reuse the existing primitive.
- **OpenLayers `ol` 10.9.0 (already installed)** — at ~130 hubs the problem is *clutter, not throughput*. Use built-in **`ol/source/Cluster`** + style **`declutter`** + (per PITFALLS) **`VectorImageLayer`** for the dense static network. **Skip WebGL** (overkill <10k points; forks the proven `postrender` trailer-animation model). No `ol-ext`.
- **`@alexanderfedin/async-queue` 1.1.0 (vendored, MIT, 0 deps)** — runtime **plumbing only** (worker↔optimizer handoff, ws backpressure, DB write-batching). **Second flagged task: resolve the missing vendored `dist/`** — its `main`/`types` point at an uncommitted build output. Recommended: build + **commit `vendor/async-queue/dist/`** (keeps vendored code off our stricter typecheck gate) and add `vendor/*` to `pnpm-workspace.yaml`, consume via `workspace:*`. Enforce the core ban with ESLint `no-restricted-imports`.

### Expected Features

(Full detail: `.planning/research/FEATURES.md`.) Grounded in real tiered carrier networks, hybrid robot autonomy (reactive/tactical/strategic horizon separation), and control-tower maturity (visibility→prescriptive→orchestration; v3.0 sits deliberately at **prescriptive/advisory**).

**Must have (table stakes — a continental demo looks broken without these):**
- **Big-city hub generation** (1–3/state, ~80–130, static/deterministic) — the root dependency.
- **Multi-center topology** (engine supports >1 center) — the linchpin engine change; generalizes `buildRoutes` off the hard-wired `USA_HUBS[0]`.
- **Nearest-center spoke assignment** (great-circle + region/division tie-break for boundary stability).
- **Inter-center backbone** (multi-hop center→center freight) — see topology reconciliation below.
- **OODA `step()` per truck + per hub** emitting existing domain events (fuel/rest/dispatch/hold) — the decentralized brain; determinism keystone.
- **Agent-owned local feasibility** (fuel/HOS/rest binding, non-overridable by a coordinator).
- **Advisory coordination centers** (`ActionSuggested`, one per center, bounded scope) + **accept/reject contract** with reason codes.
- **Oscillation guardrails** (hysteresis, cooldown/TTL, conflict partition) — a flapping demo is worse than no coordinator.
- **New flag-gated goldens; flags-off byte-identical to v2.0.**
- **Scale visualization** (100+ hubs + backbones + suggestion overlays, no clutter) + **sustained continental-run perf.**

**Should have (differentiators):**
- **Visible reject-with-reason** — the headline "smart and honest" moment; local knowledge beats central advice, auditable. Reuses the alert feed + audit timeline.
- **Coordinator-uses-optimizer** — the proven v1 min-cost-flow/VRPTW becomes the per-center scoped suggestion engine (preserves the hardest-won IP; ship rule-based first to de-risk).
- **Hub-of-hubs/meshed-core backbone animated as a distinct visual tier**, **per-agent explainable rationale**, **accept-green/reject-red advisory overlay**.

**Defer (v2+ / out of this milestone):**
- **Binding/orchestration coordinators** (violates advisory-first + the locked "no fully automated dispatch without override").
- **True ABM rewrite** of the event queue (destroys determinism — explicitly rejected).
- **p-median live hub siting**, **live ORS geometry at scale**, **capacity-balanced/ML hub assignment**, **per-tick Decide for every agent** (all anti-features; use static ranked dataset + per-N-tick + "anything-to-decide?" guard).

### Architecture Approach

(Full detail: `.planning/research/ARCHITECTURE.md`.) The one-sentence thesis: add **three flag-gated behaviors INSIDE `runToHorizon`** (multi-center topology, OODA `step()` agents, per-center coordinator process-managers) that emit NEW `DomainEvent` types into the SAME log, keep the optimizer as a *suggestion engine* called by coordinators, and keep `async-queue` strictly in the wall-clock plumbing layer below the core. Every new behavior enters as a `SimTask` data variant on the `(fireTick, seq)` EventQueue — never a closure, never a parallel loop, never `Map`/`Set` iteration order.

**Major components:**
1. **Multi-center topology** (`network/hubs.ts`, new `network/centers.ts`, `network/routes.ts`) — `generateBigCityHubs()` + `pickRegionalCenters()` + `assignSpokesToNearestCenter()` (all pure); `buildRoutes`/`buildTransitParamsByLeg` generalized from single-center star to spoke↔center + center↔center backbone; engine `const center = hubs[0]` → a `centerOf(spoke)` map; `detectAffectedScope` gains per-center partition (the scaling fix).
2. **OODA step-agents** (`simulation/src/ooda/` + `stepAgents` `SimTask`) — sorted-by-stable-id iteration; per-agent seeded substream from `mixSeed(seed ^ stableAgentHash(id))`; Observe = pure read of in-engine fold maps at pass entry; Act = `emit`; agent state added to `SerializedWorldState`.
3. **Coordination process-managers** (`simulation/src/coordinator/` + `stepCoordinators` `SimTask`) — one per center, sorted by centerId, in-fold (NOT async); new events `ActionSuggested`/`SuggestionAccepted`/`SuggestionRejected` added to the closed union + zod + every exhaustive switch; in-tick handshake via a `pendingSuggestionsByTarget` map; feasibility from existing engine state (`odometerByTrailer`, `clockByDriver`/`remainingLegalDriveMinutes`).
4. **Coordinator↔optimizer** (`simulation/src/coordinator/optimize.ts`) — build a small per-center twin from in-engine fold state and call the **pure `@mm/optimizer` `runEpoch` synchronously in-fold**; translate results to `ActionSuggested`. Global `RollingLoop` disabled under the continental flag so the two never double-plan.
5. **Perf + plumbing** — incremental cursor-fold projections for `twin-snapshot` (`milesSinceRefuel`, `inductionDeadlines`); `async-queue` backpressure at worker/DB/ws seams; scale viz.

### Critical Pitfalls

(Full detail + 16 pitfalls + per-phase mapping: `.planning/research/PITFALLS.md`.) The eight **determinism guards (Critical 1–8)** are the non-negotiable core; the two perf/coordination items below are first-class blockers.

1. **Non-deterministic agent step order** (Map/Set iteration) — drive every per-tick pass over a **sorted-by-stable-id array**; assign `claimSeq()` so same-tick ties break reproducibly. *(Verify: shuffle agents → byte-identical event batch.)*
2. **Mid-tick read-your-writes** — **freeze the observation surface for the whole tick**; agents decide on frame-N state, emit for frame N+1; never read a projection a peer just wrote this tick.
3. **RNG substream collision at ~100s of agents** — derive each stream from the **stable agent id** via the repo's `mixSeed`/splitmix32 finaliser, never spawn index; keep `OODA_RNG_SALT` pairwise-distinct.
4. **`Date.now()`/`Math.random()`/async-queue in the decision core** — sim-time only, seeded RNG only, sync+pure `step()`/`react()`; ESLint guard fails CI on a hit and forbids `async-queue`/`kysely` in the decision packages.
5. **Flags-off drift from `3920accc…`** — per flag, BOTH `flag:false === absent` AND `absent ⇒ hash 3920accc…`; construct new substreams **lazily** (only when on); the generalized multi-center `buildRoutes` must produce the **identical `Route[]`** for the legacy 10-hub input.
6. **`applyHubInventory` O(events×hubs) full-table scan RECURS at 100 hubs** — **P1-BLOCKING, not a follow-up.** Key-scope it to the touched hub id(s) (the exact v2.1 surgery already applied to the other projections). Shipping the hub jump without this re-creates the v2.1 freeze.
7. **Advisory-reject deadlock/livelock + oscillation/conflict** — reject carries a reason the coordinator *consumes* (reject-path pruning); every agent has a feasible no-op default; cap suggestions per (coordinator, agent, sim-window); `scopeHash` memo per coordinator; **single-owner lease** so two coordinators can't bind the same agent; suggestion events are **scope-neutral** so they don't re-trigger the suggesting coordinator.
8. **Per-center optimizer scope blowup + WS/viz bloat at scale** — each coordinator reuses `detectAffectedScope` (scoped slice, never whole-region re-solve); one shared twin read/frame sliced per coordinator; static topology sent **once**, per-tick deltas carry only trailers + transient suggestions; cluster + `VectorImageLayer` + decluttered opt-in overlays.

---

## Key Reconciliations (the sources diverged — resolved here)

The three topology sources (DESIGN-CONSULT / FEATURES / PITFALLS) gave **different** regional-center counts and backbone shapes. These are reconciled into single roadmap-confirmable defaults, with the trade-off flagged so the roadmap can adjust.

### 1. Regional-center count + backbone topology — RECONCILED (confirmable default)

| Source | Count | Backbone | Partition |
|--------|-------|----------|-----------|
| DESIGN-CONSULT (Google AI Mode, advisory) | **3–5** | **FULL MESH** | freight corridor + timezone |
| FEATURES (FedEx/UPS/census-division data) | **~6–10 (~8)** | hub-of-hubs w/ a 2–3-center fully-meshed **CORE** | region/timezone, nearest-center |
| PITFALLS | "a handful, ~4–8" | **near-full-mesh / sparse adjacent-region mesh** (avoid hub-of-hubs = re-centralization; avoid ring = too many hops) | region/timezone-first, with a **leg-length cap** |

**RECOMMENDED DEFAULT: ~5–6 regional centers, partitioned by freight-corridor + timezone, on a near-full-mesh backbone (≤2-hop coast-to-coast), with an explicit anti-SPOF connectivity check.**

Rationale: all three sources agree on **corridor/timezone-first partitioning** (do NOT split a natural freight lane like I-35 across two centers; timezone aligns with HOS/shift boundaries) — adopt that unanimously. On count + backbone they trade off:
- DESIGN-CONSULT's **3–5 + full mesh** minimizes hops and is cheap (5 nodes → 10 legs) but under-provisions consolidation for ~100 hubs (fan-out per center climbs).
- FEATURES's **~8 + hub-of-hubs-core** maximizes trailer fill and mirrors FedEx reality but PITFALLS explicitly warns that **hub-of-hubs re-introduces the single-global-star bottleneck and SPOF this milestone exists to remove** — a hard objection that breaks a tie in favor of mesh.
- The synthesis: keep the center count **small enough that a near-full mesh is cheap** (PITFALLS: O(centers²) is tiny at ~5–6) yet **large enough to bound per-center fan-out** (FEATURES: <5 over-concentrates). **~5–6 + near-full-mesh** satisfies both: ≤2-hop transit, no SPOF, bounded fan-out, low map clutter. Reject pure hub-of-hubs (re-centralization, FEATURES/PITFALLS anti-feature) and ring (too many hops, all three).

**Flagged trade-off for the roadmap:** if consolidation/trailer-fill at the chosen center count proves thin in a continental run, the lever is **(a)** add 1–2 centers (toward FEATURES's ~8) and/or **(b)** designate the 2–3 largest as a meshed core that the rest mesh-prefer through — *without* collapsing to a single primary. Center count and exact backbone density are **roadmap-confirmable** in P1; the leg-length cap + anti-SPOF (remove-any-center connectivity) test are mandatory regardless.

### 2. Coordinator↔optimizer relationship — RESOLVED (converged across all sources)

**Hybrid, decided.** Macro layer = the existing rolling optimizer as a **scoped, PURE suggestion engine**; micro layer = per-center coordination centers emitting **advisory** `ActionSuggested`; agents arbitrate. The optimizer is **not replaced** — it is reframed as a recommendation generator a coordinator may invoke.

**Determinism rule (the one that matters):** a coordinator builds a small per-center twin from its **in-engine fold state** and calls the optimizer's **pure `runEpoch` synchronously inside the `stepCoordinators` fold** at a deterministic tick — **NOT** the async worker-thread path. The async re-entry timing is wall-clock and would break byte-identical replay; the pure in-fold call is replayable. The global `RollingLoop` stays for the flags-off model and is disabled under the continental+coordinator flags so the two never double-plan. (DESIGN-CONSULT, FEATURES, and ARCHITECTURE all independently land here; ARCHITECTURE §5B is the authoritative wiring.)

### 3. Determinism is the keystone — surfaced prominently (see "Critical Pitfalls" above)

The eight critical determinism guards and the **`applyHubInventory` O(n²) full-scan trap (P1-BLOCKING)** are elevated to the top of the watch-list. This project *already shipped a freeze* from an O(events²) projection fold (v2.1 key-scoping fix); `applyHubInventory` was left full-scan and becomes an **active** regression — not a latent one — the moment hub count jumps to 100+. It must ship key-scoped *with* P1, not as hardening.

### 4. Build order — RESOLVED (hard-sequenced spine, see roadmap below)

ARCHITECTURE gives a dependency-respecting spine that all sources agree on: topology → agents → coordinators → coordinator-uses-optimizer → perf/plumbing/viz. Phase A is a hard prerequisite for B/C/D; B precedes C (agents must exist to arbitrate); D needs C; E (perf/plumbing/viz) is independent and can run alongside C/D.

---

## Implications for Roadmap

Based on combined research, the recommended **phase spine** (matching ARCHITECTURE §10 + PITFALLS' P1–P5 + FEATURES' MVP order):

### Phase A — Multi-Center Topology  [FOUNDATION — everything assumes it]
**Rationale:** The linchpin engine change; the root dependency for agents and coordinators. Ship + golden BEFORE any agent code.
**Delivers:** `generateBigCityHubs()` (1–3/state, ~80–130, pure, committed + checksummed dataset) · `pickRegionalCenters()` + `assignSpokesToNearestCenter()` (corridor/timezone partition + nearest tie-break-by-id + **leg-length cap**) · `buildRoutes`/`buildTransitParamsByLeg` generalized to spoke↔center + **near-full-mesh backbone** (great-circle) · engine `centerOf` map + flow routing through centers · per-center scope partition in `detectAffectedScope`.
**Addresses (FEATURES):** big-city hub generation, multi-center topology, nearest assignment, backbone, great-circle, scale-viz baseline.
**Avoids (PITFALLS):** 2 (float divergence — round at boundary, transcendentals out of hashed payloads) · **6/9 (`applyHubInventory` key-scoping — P1-BLOCKING, ships HERE)** · 8 (multi-center degenerates byte-identically to the 10-hub `Route[]`) · 12 (center partition: leg cap, tie-break-by-id, committed partition snapshot) · 13 (cross-state metros de-duped; ~80–130 in continental envelope) · 14 (backbone connectivity / anti-SPOF, ≤2-hop).
**Uses (STACK):** committed `us-big-cities.generated.json` + dataset attribution task · existing `greatCircle` (untouched) · OL Cluster/`VectorImageLayer` baseline.
**Flag:** `continentalTopology`; new continental golden (small 12–20-hub fixture); DET-01 flags-off still `3920accc…`.

### Phase B — OODA Step-Agents  [the decentralized brain]
**Rationale:** Agents read the topology and must exist before coordinators can arbitrate.
**Delivers:** `stepAgents` `SimTask` + dispatch case + bootstrap self-reschedule (cadence constant, per-N-tick) · per-agent seeded substream from **stable id** · Observe (fold maps)/Orient/Decide/Act(emit) with **sorted agent iteration** · agent state into `SerializedWorldState` (continuation-equivalence).
**Addresses (FEATURES):** OODA truck agent, OODA hub agent, agent-owned local feasibility (fuel/HOS/rest binding).
**Avoids (PITFALLS):** 1 (sorted step order) · 3 (RNG decorrelation) · 4 (frozen observation surface) · 5/6 (sync+pure, no async-queue/`Date.now`/`Math.random`) · 8 (lazy substream, flags-off gate).
**Implements (ARCHITECTURE):** §3 OODA-inside-the-engine.
**Flag:** `oodaAgentsEnabled`; new ooda golden + flags-off regression + order-shuffle + N-agent-decorrelation tests.

### Phase C — Coordination Centers  [advisory process-managers — the headline differentiator]
**Rationale:** Coordinators subscribe to agent-emitted events; agents must exist first. Ship **rule-based** suggestions first to de-risk.
**Delivers:** `ActionSuggested`/`SuggestionAccepted`/`SuggestionRejected` events (union + zod + every exhaustive switch; **scope-neutral** classification) · `stepCoordinators` `SimTask` (one per center, sorted) · in-tick handshake via `pendingSuggestionsByTarget` · agent accept/reject from existing engine state · **the five anti-oscillation/anti-deadlock guards: hysteresis dead-band, seeded-jitter exponential backoff, sim-time TTL, single-owner lease per agent, reject-path pruning** · canonical JSON serialization of all new hashed payloads.
**Addresses (FEATURES):** advisory coordinators, accept/reject contract, **visible reject-with-reason**, oscillation guardrails.
**Avoids (PITFALLS):** 4 (coordinators observe the frozen surface) · 7 (`canonicalize` all hashed payloads) · 10 (reject-deadlock: suppression + feasible no-op default + cooldown) · 11 (oscillation/conflict/feedback: `scopeHash` memo + single-owner partition + scope-neutral events) · 15 (scoped, not whole-region).
**Implements (ARCHITECTURE):** §4 process-manager-in-fold.
**Flag:** `coordinatorsEnabled`; new coordinator golden + continuation-equivalence + converge-in-K-epochs + bounded-events-per-tick tests.

### Phase D — Coordinator ↔ Optimizer  [suggestion engine; needs C]
**Rationale:** Preserve the proven v1 optimizer IP as the per-center scoped suggestion generator.
**Delivers:** build-center-twin-from-fold · call **pure `@mm/optimizer` `runEpoch` in-process** (NOT the async worker) · result → `ActionSuggested` translation · disable global `RollingLoop` under the flag (no double-plan).
**Addresses (FEATURES):** coordinator-uses-optimizer (P2 differentiator).
**Avoids (PITFALLS):** 5 (synchronous pure call, deterministic tick) · 15 (scoped epoch, bounded horizon).
**Implements (ARCHITECTURE):** §5B (the recommended wiring; §5A async path is rejected for the golden).
**Flag:** `coordinatorUsesOptimizer` (sub-flag of coordinators) + golden.

### Phase E — Perf + Plumbing + Scale Viz  [independent; parallelizable with C/D]
**Rationale:** Read/plumbing-side; touches no model decisions, so it can run alongside C/D.
**Delivers:** **incremental cursor-fold projections** for `twin-snapshot` (`milesSinceRefuel`, `inductionDeadlines` → `applyInline` APPLIERS; reads small tables instead of full-log scans) · **async-queue** backpressure at worker handoff → DB write-batching → ws backpressure (plumbing only; append-order==generation-order test; **resolve vendored `dist/`** + `vendor/*` workspace wiring + ESLint core-ban) · **scale viz** (Cluster + `VectorImageLayer` + decluttered opt-in suggestion overlays; static topology sent once, per-tick deltas only) · sustained continental-run perf test.
**Addresses (FEATURES):** scale visualization, sustained continental-run perf, incremental twin-snapshot.
**Avoids (PITFALLS):** 9 (twin-snapshot incremental fold) · 16 (ws bloat + viz clutter).
**Implements (ARCHITECTURE):** §6 async-queue placement, §8 cursor-fold.

### Phase Ordering Rationale
- **A before everything:** OODA agents read "which center am I heading to?"; coordinators are *one per center*. Topology + golden first (ARCHITECTURE §2, PITFALLS P1, FEATURES "build first").
- **B before C:** agents must exist to accept/reject (the whole advisory contract). FEATURES + ARCHITECTURE + PITFALLS all sequence agents→coordinators.
- **D after C:** the optimizer-backed suggestion is a refinement of an already-working rule-based coordinator; ship rule-based first to de-risk (FEATURES).
- **E parallel to C/D:** it touches the plumbing/read side, not the event stream — but the **`applyHubInventory` key-scoping is pulled FORWARD into A** (P1-BLOCKING; the rest of E's perf work is genuinely deferrable).
- **Every phase carries its own flags-off gate** (DET-01 two-part); a consolidated migration audit lands at the end (Hardening).

### Research Flags

Phases likely needing deeper research during planning (`/gsd-research-phase`):
- **Phase A:** confirm final **center count (5–6 default) + backbone density** against a real continental run (the reconciled trade-off above); confirm dataset source (SimpleMaps vs `all-the-cities`) + attribution mechanics; cross-state-metro de-dup canonical-coordinate rules.
- **Phase C:** the five anti-oscillation guards are well-specified but their **sim-time constants** (hysteresis dwell ~15 min, TTL ~5–8 min, cooldown K, lease expiry) need tuning + golden capture; conflict-partition lease semantics in a single-process fold.
- **Phase D:** per-center twin-build cost vs the synchronous in-fold budget (gate behind a sub-flag with a heuristic fallback if profiling shows it's too heavy).

Phases with standard/well-documented patterns (lighter research):
- **Phase B:** the OODA-as-`SimTask` pattern is fully specified against existing self-rescheduling tasks (`createPackageBatch`/`inductPackage`) and the existing salt/substream discipline — mostly disciplined reuse.
- **Phase E:** the cursor-fold is the exact v2.1 move applied again; async-queue seams + OL Cluster/declutter are documented and mechanical.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions registry-verified 2026-06-26; dataset licenses checked; OL primitives Context7/docs-confirmed; zero new heavy runtime deps. Two flagged tasks (attribution, vendored `dist/`) are mechanical, not risky. |
| Features | HIGH (carrier network design) / MEDIUM (OODA-as-event-emitting fusion) | Hub counts/tiering grounded in multiple HIGH carrier sources; the event-sourced OODA fusion is novel but adapts well-documented hybrid-autonomy/control-tower patterns. |
| Architecture | HIGH | Every integration point names a real file:line in the shipped tree (verified 2026-06-26); the in-fold process-manager + pure-`runEpoch` wiring is codebase-grounded. |
| Pitfalls | HIGH (determinism + perf) / MEDIUM-HIGH (coordination/topology/viz) | Determinism/perf grounded in this repo's OWN prior O(n²) freeze + `twin-snapshot` debt + RNG-substream machinery; coordination cross-checked against multi-agent + ES literature. |

**Overall confidence:** HIGH — decisive enough for requirements + roadmap. The one genuinely open lever (center count + backbone density) is reconciled to a default with an explicit, bounded adjustment path.

### Gaps to Address
- **Center count + backbone density (5–6 + near-full-mesh default):** validate trailer-fill/consolidation in a continental run during Phase A; adjust per the flagged lever (add 1–2 centers and/or designate a meshed core — never a single primary). Mandatory regardless: leg-length cap + anti-SPOF remove-any-center connectivity test.
- **Dataset source + attribution:** pick SimpleMaps (backlink) vs `all-the-cities` (GeoNames credit + admin1→postal map) in Phase A planning; attribution is a **non-optional roadmap task**.
- **Vendored async-queue `dist/`:** resolve the missing build output (commit `dist/` recommended) + `vendor/*` workspace wiring + ESLint core-ban before any Phase-E plumbing lands.
- **Anti-oscillation sim-time constants:** hysteresis dwell, TTL, cooldown K, lease expiry need empirical tuning + their own golden in Phase C.
- **Coordinator-in-fold optimizer cost:** profile the synchronous per-center `runEpoch`; keep a heuristic-Decide fallback behind a sub-flag (Phase D).

## Sources

### Primary (HIGH confidence)
- **This repository (codebase-grounded, verified 2026-06-26):** `packages/simulation/src/{engine,continuation,rng}.ts`, `network/{hubs,routes}.ts`; `packages/domain/src/events/domain-event.ts`; `packages/optimizer/src/rolling/{scope,types,freeze-idempotency}.ts`; `packages/api/src/optimizer/{twin-snapshot,worker-client,coalesced-runner}.ts`, `sim/driver.ts`; `packages/projections/src/runner/inline.ts` (the residual `applyHubInventory` full-scan); `packages/simulation/test/determinism.unit.test.ts` (golden `3920accc…` + DET-01 two-part gate); `vendor/async-queue/src/index.ts`; `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`.
- npm registry (`npm view`, 2026-06-26): `ol` 10.9.0, `@alexanderfedin/async-queue` 1.1.0 (MIT, 0 deps), `all-the-cities` 3.1.0, `us` 2.0.0, `@turf/great-circle`/`geodesy` (rejected).
- Context7 `/openlayers/openlayers` + OL 10.9 API docs — `ol/source/Cluster`, `declutter`, `VectorImageLayer`, WebGL thresholds.
- Real carrier network design: On the Seams (UPS, FedEx primers), FreightWaves, Census MSA tables, FCC top-100 MSA list — tiered hub counts, MSA-as-freight-node.
- Robot autonomy / OODA: Boyd OODA, NASA NTRS "Planning in Subsumption", layered-control + subsumption literature — reactive/tactical/strategic horizon separation = agent-vs-coordinator authority split.

### Secondary (MEDIUM-HIGH confidence)
- SimpleMaps US Cities Basic (CC BY 4.0 + backlink clause; site behind 403, corroborated via search); GeoNames readme (CC BY 4.0).
- Control-tower maturity: IBM, Locus, OpenText, Inbound Logistics — visibility→prescriptive→orchestration; reroute/reallocate/sequence action types.
- Process-manager / saga: Event-Driven.io, microservices.io — stateful-state-machine, choreography vs orchestration, single-owner instance.
- Multi-agent anti-oscillation / Zeno exclusion: switching-topology stability, event-triggered consensus (PMC) — hysteresis/cooldown/dynamic-threshold rationale.

### Tertiary (advisory, cross-checked)
- **`.planning/research/DESIGN-CONSULT.md`** (Google AI Mode, `udm=50`, 2026-06-26) — treated as a peer advisory input; its 3–5 / full-mesh recommendation and five anti-oscillation guards are reconciled against FEATURES/PITFALLS above (NOT silently averaged). Its anti-oscillation patterns and corridor/timezone partitioning are adopted; its center count is blended toward 5–6 to satisfy the FEATURES fan-out + PITFALLS anti-SPOF constraints.
- MDPI Sustainability (metro-based hub-location p-median) — grounding only; live p-median is an explicit anti-feature.

---
*Research completed: 2026-06-26*
*Ready for roadmap: yes*
