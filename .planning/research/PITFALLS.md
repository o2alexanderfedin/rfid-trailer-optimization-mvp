# Pitfalls Research — Milestone v3.0 "Continental OODA Network"

**Domain:** Adding a continental OODA agent network (1–3 hubs/state, ~80–130 hubs on a multi–regional-center topology) + advisory coordination-center process-managers to a deterministic, seeded, event-sourced discrete-event logistics simulation. **Byte-identical golden replay is the keystone.**
**Researched:** 2026-06-26 (codebase-grounded; all file/symbol references verified against the v2.1 tree)
**Confidence:** HIGH for determinism + perf (grounded in this repo's own prior O(n²) freeze, the `twin-snapshot` full-scan debt, and the existing RNG-substream/`scopeHash`/freeze-window machinery). MEDIUM-HIGH for coordination/topology/viz (cross-checked against multi-agent + event-sourcing literature).

> **How to read this file.** Every pitfall is tagged with the build phase that must own it. The proposed phase spine is:
> **P1 Topology** (big-city hubs + regional centers + backbone + great-circle geometry) ·
> **P2 OODA agents** (truck/hub `step()` emitting events) ·
> **P3 Coordinators** (advisory `ActionSuggested` process-managers) ·
> **P4 Viz** (scale rendering) ·
> **P5 Hardening** (perf budget, goldens, migration audit).
> Each pitfall names a concrete prevention **guard/test**, not just advice. The determinism guards (Critical 1–8) are the non-negotiable core — they are the keystone this whole milestone risks breaking.

---

## Critical Pitfalls

### Pitfall 1: Non-deterministic agent STEP ORDER (Map/Set iteration, hash order)

**What goes wrong:**
At ~100 hubs + 100s of trucks, the natural way to "step every agent each tick" is to iterate a `Map<agentId, Agent>` or a `Set`. Two agents stepping in a different order can emit the same two events in a different order → the event log differs → the golden hash changes. The bug is invisible at 10 IATA hubs (small, often-sorted collections) and only surfaces at scale, where insertion order and rehash thresholds shift.

**Why it happens:**
JS `Map`/`Set` iterate in *insertion* order, which feels deterministic — but insertion order here is derived from upstream collections (projection-row order, route-build order, spawn order) that are NOT guaranteed stable across a topology change, a DB read without `ORDER BY`, or a restart. The engine already learned this exact lesson in `twin-snapshot.ts` (the FLOW-04 comment: an *unordered* `hub_inventory` read shifted `scopeHash` across restarts and re-fired a frozen epoch). OODA multiplies the surface by putting an ordered emission step on *every* agent.

**How to avoid:**
- Drive every per-tick agent pass over a **sorted-by-stable-id array**, never raw `Map`/`Set` iteration. Reuse the engine's existing discipline: the `EventQueue` already orders by `(fireTick, insertionSeq)` and the snapshot builder already calls `sortedUnique(...)` / `.orderBy("hub_id")`. Make OODA agents step through the same `(fireTick, claimSeq())` queue rather than a free-running `for (const a of agents)`.
- Assign each agent's emitted events a `claimSeq()` insertion sequence so same-tick ties from different agents break by a total, reproducible order — exactly the tuple the existing `same-tick tie-break tuple is deterministic (Task D)` test asserts.
- Build any `Map` the agents read from a *sorted source* (`hubs.map(...)`, `[...ids].sort()`), mirroring `hubById`/`driverByTrailer` construction in `engine.ts`.

**Warning signs:**
Golden hash differs only on a larger topology or only after a process restart; a test passes at 10 hubs and fails at 100; `scopeHash` shifts with no payload change.

**Phase to address:** **P2 OODA agents** (establish the sorted-step contract on day one; everything downstream inherits it).

---

### Pitfall 2: Floating-point divergence in great-circle / log-normal math across platforms

**What goes wrong:**
v3.0 computes **great-circle arcs in-code for every new leg** (`greatCircle` → `Math.cos/sin/asin/atan2/acos` in `routes.ts`), and the sim already draws transit from `sampleLogNormal` (`Math.exp/log` in `timing.ts`). JS does **not** IEEE-754-specify transcendental functions (`sin`, `cos`, `atan2`, `exp`, `log`) — implementations may differ by 1 ULP across CPU architecture / libm / Node build. A 1-ULP difference in an arc midpoint, propagated into a hashed geometry payload or into a transit-minutes draw that gates an event time, flips the golden hash. The repo's own `determinism.unit.test.ts` already carries the contingency note for this (the x86_64/darwin capture caveat).

**Why it happens:**
The 10-hub network has a fixed, committed road-geometry file, so great-circle math rarely fed a *hashed* payload before. v3.0 makes great-circle arcs the **primary geometry for 100+ hubs**, putting transcendental output directly into the event stream / snapshot that gets hashed — and the milestone explicitly wants new goldens captured.

**How to avoid:**
- **Keep transcendental output OUT of hashed payloads wherever possible.** Geometry is for the *map*, not for decisions: do not let an arc vertex's 14th decimal influence an event time or a `scopeHash`. Hash decisions (hub ids, integer minutes, integer volumes), not rendered polylines. The codebase already enforces "integer capacities/volumes (P12), no floats enter the optimizer" — extend that to OODA decisions.
- **Round at the boundary.** `hubCoordsChecksum` already rounds to 6 dp before hashing; apply the same rounding to any great-circle vertex that *must* enter a hashed structure, and round transit-minutes to integers (the snapshot builder already does `Math.round(duration_s/60)`).
- **Pin the capture environment** and document it next to the new golden (as DET-02 already does). Add a CI note: if a multi-arch runner ever diverges, the contingency is an integer lookup table for the sampler — do NOT pre-emptively do this.
- Add a **same-arch reproducibility test** (two `greatCircle` calls → byte-identical) and a **cross-run snapshot-hash test** so a libm change is caught immediately.

**Warning signs:**
Golden passes locally, fails in CI on a different arch; geometry-derived distances differ in the last few decimals between machines; a transit-time histogram shifts by one tick on one platform.

**Phase to address:** **P1 Topology** (geometry decisions made here) + **P5 Hardening** (golden capture + cross-arch CI note).

---

### Pitfall 3: RNG substream collisions when spawning ~100s of per-agent streams

**What goes wrong:**
Today there are 8 feature substreams, each `makeRng(seed XOR salt)` with a hand-picked, pairwise-distinct salt and a salt-collision test. OODA wants a *per-agent* substream for ~100s of trucks/hubs. The tempting shortcut — `makeRng(seed + agentIndex)` or `seed XOR hash(agentId)` with a weak hash — can produce **overlapping or correlated streams**: two agents whose seeds land near each other draw near-identical sequences (the very thing `mixSeed`'s splitmix32 step exists to prevent for adjacent seeds), or two `XOR` salts collide. Correlated agent randomness is both a realism bug and a determinism-fragility bug (reordering agents reshuffles which stream is "first").

**Why it happens:**
The existing salt scheme assumes a *small, fixed* set of feature streams and verifies distinctness by enumeration. That does not scale to a *dynamic, large* agent population — you can't hand-pick 130 salts, and naive index arithmetic reintroduces the adjacent-seed correlation `mixSeed` was added to kill.

**How to avoid:**
- Derive each agent's substream through the **same splitmix32 finaliser the repo already trusts**: `makeRngFromState(mixSeed(mixSeed(seed) ^ stableAgentHash(agentId)))`, where `stableAgentHash` is the FNV-1a already in `routes.ts` (`hubCoordsChecksum`), not the raw index. Two-stage mixing decorrelates adjacent agent ids.
- **Derive the substream from the agent's STABLE id, never its spawn index or array position** — so reordering the agent set (Pitfall 1) cannot change any agent's stream.
- Keep the feature-salt layer (`OODA_RNG_SALT`) as the top-level domain separator so OODA draws never perturb the 8 existing streams; add it to the pairwise-distinct salt-collision test.
- Add a test asserting **N agents → N statistically-independent streams** (e.g. no two agents share their first K draws) at the real agent count.

**Warning signs:**
Two trucks make identical "random" choices in lock-step; flipping HOS/fuel on perturbs an *unrelated* agent's behavior; the golden changes when you only renamed/reordered agents.

**Phase to address:** **P2 OODA agents** (substream derivation is foundational to agent construction).

---

### Pitfall 4: Reading MUTABLE projection state mid-tick (read-your-writes within the OODA pass)

**What goes wrong:**
OODA's "Observe" reads projections. If agent A *acts* (emits an event that folds into a projection) and agent B, stepping later in the same tick, *observes* the post-A projection, then B's decision depends on intra-tick ordering — and the result depends on how fast/when the fold ran (async timing), not just the seed. This is a determinism landmine: the same logical tick can yield different B-decisions across runs.

**Why it happens:**
The current driver folds projections **once per frame** (`foldFrame`) *after* appending a whole frame's events, precisely to decouple emission from observation. OODA tempts you to interleave observe→act→observe within one tick to make agents "react immediately," which silently couples decisions to fold timing and to agent order.

**How to avoid:**
- **Freeze the observation surface for the whole tick.** All agents in a tick observe the *same* immutable snapshot (the state as of the start of the tick); their emitted events are collected and applied *after* every agent has stepped — the classic discrete-event "decide on frame N state, apply for frame N+1" rule. This matches the existing per-frame fold boundary.
- Treat the OODA pass as **pure command generation over a read-only twin**, exactly as the design notes state ("Observe reads projections; the event log stays the source of truth; reducers still fold"). Do not let an agent read a projection it (or a peer) just wrote this tick.
- Add a test: shuffle the agent step order within a tick → identical event batch (proves no intra-tick read-your-writes dependence). This is the strongest single witness against both Pitfall 1 and Pitfall 4.

**Warning signs:**
Behavior changes when you reorder agents but the per-agent RNG is provably stable; "it depends whether the projection folded yet" appears in a debugging session; a coordinator's suggestion changes based on which agent emitted first.

**Phase to address:** **P2 OODA agents**, hardened again in **P3 Coordinators** (coordinators observe the same frozen surface).

---

### Pitfall 5: Async/microtask scheduling leaking into ordering (the vendored async-queue in the core)

**What goes wrong:**
`@alexanderfedin/async-queue` is Promise/microtask-based. If an OODA step or a coordinator does `await`-ed work whose completion order depends on the microtask queue (DB round-trips, the async-queue's internal scheduling), the *order events get appended* becomes wall-clock/scheduler dependent → non-reproducible log. The design notes flag this explicitly ("MUST stay out of the deterministic sim core") — but the seam is easy to cross because the existing driver is already `async` end-to-end.

**Why it happens:**
The deterministic engine (`generate`/`simulate`) is synchronous and pure; the *driver* around it is async (DB writes, ws). OODA blurs the line: an agent that "observes" via an `await db.select(...)` and then emits has injected scheduler-dependent ordering into what must be a pure decision. The async-queue is designed for *runtime plumbing* (worker handoff, ws backpressure, DB batching) and is correct there — the risk is using it *inside* the decision path.

**How to avoid:**
- Keep the OODA decision core **synchronous and pure**: agents receive a plain in-memory snapshot object and return events; no `await`, no `async-queue`, no DB inside `step()`. All I/O stays in the driver, before (read snapshot) and after (append batch) the synchronous OODA pass — mirroring how `simulate()` is pure and `driveSimulation*` is the async shell.
- Confine `async-queue` to the four blessed runtime-plumbing seams only (worker-optimizer handoff, ws backpressure, continuous-loop chunk handoff, DB write-batching). Add a lint/architecture guard: `@mm/simulation` and the OODA decision package must not import `async-queue` or `kysely`.
- Append a tick's collected events in a **sorted, single batch** (by `(streamId, claimSeq)`), never "as each async op resolves."

**Warning signs:**
Golden flakes intermittently (passes/fails on the same input) — the signature of scheduler-dependent ordering; event order changes under load; adding a `console.log` (which perturbs timing) changes the result.

**Phase to address:** **P2 OODA agents** + **P3 Coordinators** (both must keep `step()`/`react()` pure); architecture guard added in **P5 Hardening**.

---

### Pitfall 6: `Date.now()` / `Math.random()` sneaking into agents or coordinators

**What goes wrong:**
A new agent/coordinator file is the most likely place for a stray `Date.now()` (e.g. "timestamp this suggestion") or `Math.random()` (e.g. "pick a tie-break randomly") to appear — instantly non-deterministic. The existing engine is scrupulously clean (`VirtualClock` + `makeRng` only), but every new author of an agent re-creates the temptation.

**Why it happens:**
Coordinators feel like "services," and service code reaches for wall-clock and `Math.random` reflexively. The advisory `ActionSuggested` event *wants* a timestamp — and the wrong source is `Date.now()`.

**How to avoid:**
- All agent/coordinator time comes from the **tick's `occurredAt` / `nowMin`** (sim time), exactly as `scope.ts` and `freeze-idempotency.ts` already enforce ("the clock comes from `epoch.nowMin` — NEVER `Date.now()`"). Suggestion timestamps = sim time.
- All agent/coordinator randomness comes from the seeded per-agent substream (Pitfall 3). No bare `Math.random()`.
- Add a **static guard test / ESLint rule** that fails CI if `Date.now`, `new Date()` (without an arg), `performance.now`, or `Math.random` appears in the OODA/coordinator packages (the sim core already has zero — make it mechanically enforced for the new packages).

**Warning signs:**
Two runs from the same seed differ by a timestamp field only; a grep for `Date.now`/`Math.random` in the new packages returns a hit.

**Phase to address:** **P2 OODA agents** + **P3 Coordinators**; CI guard in **P5 Hardening**.

---

### Pitfall 7: JSON key-order / unstable serialization in hashed state

**What goes wrong:**
The new `ActionSuggested` payload, agent-state snapshots, and any new twin fields get serialized and (directly or via `scopeHash`) hashed. If an object's keys are built in a data-dependent order, `JSON.stringify` emits different bytes for logically-identical state → hash drift. The optimizer already guards this with `canonicalize` (recursive key sort) in `freeze-idempotency.ts`; new payloads bypass that guard unless they go through it.

**Why it happens:**
`JSON.stringify` preserves *insertion* key order. A payload assembled by spreading optional fields conditionally (the codebase does this a lot: `...(x !== undefined ? { x } : {})`) can produce different key orders depending on which fields are present, and a `Map`-derived object inherits the Map's order.

**How to avoid:**
- Route **every** newly-hashed structure (suggestions, agent snapshots, coordinator scope) through the existing `canonicalize` before hashing — do not hand-roll a second serializer. The repo already proved this is the fix (the `scopeHash` is canonical and key-order-independent).
- Define event payloads with a **fixed field order** and validate via the existing Zod schemas at the boundary (the determinism test already runs `validateEvent` on every emitted event — extend it to the new event types).
- Keep `assigned_package_ids` / suggestion target lists **sorted** before serialization (the snapshot already `JSON.stringify`s sorted arrays).

**Warning signs:**
Two runs with identical logical state produce different `scopeHash`/golden; a payload's JSON differs only in key order; an epoch re-fires because its hash changed with no semantic change.

**Phase to address:** **P3 Coordinators** (the new `ActionSuggested` payload is the highest-risk new hashed structure); **P5 Hardening** (golden capture validates).

---

### Pitfall 8: Migration — flags-off DRIFTS from the v2.0 golden `3920accc…`

**What goes wrong:**
The whole milestone is gated on "flags-off byte-identical to v2.0." The classic mistake: a v3.0 change that is *supposed* to be inert when its flag is off actually perturbs the default path — a new substream constructed unconditionally (drawing a value and advancing an RNG even when unused), a new branch that reorders an existing loop, a topology generalization that changes route-build order even for the 10-hub default, or a new event type that the scope-detector classifies wrongly. Result: `simulate({seed:42, durationTicks:10000})` no longer hashes to `3920accc…` and the regression gate fails.

**Why it happens:**
"Flag-gated" is necessary but not sufficient — the flag must gate **every draw, every emit, every ordering change**. The repo's own history shows the right pattern (every v2.0 feature has an explicit `…Enabled: false is byte-identical to absent` test AND a `…ABSENT is byte-identical to the seed-42 10k golden` test), and the right failure mode to fear (`fuelRng` is "constructed ONLY when `fuel.enabled`" precisely so a fuel-off run "draws ZERO fuel values").

**How to avoid:**
- For **each** v3.0 flag (big-city hubs, multi-center, OODA, coordinators), add the two-part gate test the codebase already standardizes: (a) `flag:false === flag absent` over a short run, and (b) `flag absent ⇒ hash === 3920accc…` over the 10k golden.
- **Construct new RNG substreams lazily** — only when the flag is on — so an off run advances zero new draws (the `fuelRng`/`inductionRng` pattern).
- Make the multi-center generalization **degenerate to the single-Memphis-center star when only 10 hubs / one center are configured**, byte-identically (the existing `buildRoutes` centers on `hubs[0]`; the generalized version must produce the identical `Route[]` for the legacy input).
- Add the new event types to `scope.ts`'s exhaustive switch as **scope-neutral by default** (the `default: const _never: never` guard forces classification — use it).

**Warning signs:**
`determinism.unit.test.ts` DET-01 gate goes red; the 10k golden hash changes after a "flags-off" commit; a new RNG appears in the construction path unconditionally.

**Phase to address:** **Every phase** must carry its own flags-off gate; consolidated audit in **P5 Hardening**.

---

### Pitfall 9: The O(n²) projection-fold / full-table-scan trap RECURS at 100 hubs

**What goes wrong:**
This project *already shipped a freeze* from an O(events²) projection fold (each event loaded the whole projection table, folded, rewrote every row) — fixed in v2.1 by key-scoping. **The fix is incomplete and the regression is latent at 100 hubs:**
- `applyHubInventory` (`inline.ts`, ~line 397) **still loads the ENTIRE `hub_inventory` table per event** (`selectFrom("hub_inventory").selectAll()`), then rebuilds a full placement index. At 10 hubs this is cheap; at 100+ hubs it is O(events × hubs) again — the same shape as the freeze, just with a larger constant that grows with the milestone's headline feature.
- `twin-snapshot.ts` does **two full event-log scans per optimizer epoch** (`readAll(es, 0n)` in `computeMilesSinceRefuel` *and* `buildInductionDeadlines`) — O(log) per epoch, O(log²) over a run. The design notes flag this as carried debt; multiplying hubs and adding per-center optimizer epochs makes it bite sooner.

**Why it happens:**
The v2.1 key-scoping fix was applied per-projection; `hub_inventory` was left full-scan because a hub event can touch multiple hubs and the placement index spans hubs. The twin-snapshot full scans predate the perf work entirely.

**How to avoid:**
- **Key-scope `applyHubInventory`** to the hub id(s) the event actually touches — the same surgery already done for `package_location`/`trailer_state`/`zone_estimate` (load only `WHERE hub_id IN (...)`, fold, persist the delta). This is the single highest-value perf fix for the topology jump.
- **Make `twin-snapshot` fold incrementally from a cursor** (the design notes' carried follow-up) instead of `readAll(0n)` twice per epoch — maintain a running fuel/induction projection advanced by the same per-frame fold, and read it like the other projections.
- Add a **per-event projection-cost test** that asserts cost is independent of hub count (fold N events at 10 hubs vs 100 hubs → same number of row reads per event), the direct witness the v2.1 fix relies on.

**Warning signs:**
Sim "time appears to stop" / throughput decays over a long run (the exact v2.1 symptom); per-frame fold time grows with hub count; optimizer epoch latency grows linearly with run length.

**Phase to address:** **P1 Topology** must NOT ship the hub jump without the `applyHubInventory` key-scoping (it converts a latent O(n²) into an active one). `twin-snapshot` incremental fold lands in **P5 Hardening** (bounded by `optimizerEveryTicks`, secondary but real).

---

### Pitfall 10: Advisory-reject DEADLOCK / livelock — "no valid suggestion → no progress"

**What goes wrong:**
The user explicitly wants agents to **reject infeasible suggestions** (they alone know fuel/HOS/road-closure feasibility). The failure mode this *directly creates*: a coordinator keeps suggesting action A, the agent keeps rejecting A (genuinely infeasible), the coordinator re-observes the unchanged state and re-suggests A — forever. The agent makes **no progress** and the demo livelocks. This is the multi-agent "Zeno behavior" (infinite events in finite sim-time) the consensus literature names explicitly.

**Why it happens:**
Advisory-first decentralization means the coordinator can't force progress and the agent can't generate its own plan from a rejected suggestion. If the coordinator's suggestion function is a pure function of (unchanged) observed state, it is *deterministic about re-suggesting the same infeasible action*. Determinism here makes the livelock perfectly reproducible rather than self-healing.

**How to avoid:**
- **Rejection must carry a reason and the coordinator must consume it.** Model `ActionSuggested` → `SuggestionRejected(reason)` → coordinator excludes that action from its next suggestion for that agent (a per-(agent,reason) suppression set). This is event-triggered control with a dynamic threshold — the standard anti-Zeno mechanism.
- **Every agent must have a feasible default ("do nothing / hold") that always terminates the OODA loop for the tick.** An agent that can reject all suggestions must still emit a definite no-op decision, so the tick *closes* (bounded events per tick).
- **Cap suggestions per (coordinator, agent, sim-window)** — a cooldown counted in sim-ticks (reuse the `freeze-window`/`scopeHash`-memo machinery already built for optimizer anti-thrash). After K rejections, the coordinator stops suggesting to that agent until the observed state materially changes (state hash differs).
- **Bound events-per-tick** as an invariant test: assert the OODA+coordination pass emits ≤ a fixed function of agent count per tick (no unbounded re-suggestion within a tick).

**Warning signs:**
The same `ActionSuggested`/`SuggestionRejected` pair repeats every tick for one agent; events-per-tick grows without freight moving; a truck sits at a hub indefinitely while a coordinator "talks at it."

**Phase to address:** **P3 Coordinators** (this is the headline coordination risk; the suppression/cooldown + feasible-default must ship *with* the first coordinator).

---

### Pitfall 11: Suggestion OSCILLATION, conflicting coordinators, and re-plan feedback loops

**What goes wrong:**
Three related instabilities once coordinators emit events:
1. **Oscillation:** coordinator suggests "route via center X," agent accepts, the new state makes "route via center Y" look better next epoch, agent re-routes, and it ping-pongs.
2. **Conflicting advice:** an agent (e.g. a truck near a regional boundary) is in scope for *two* coordinators that suggest contradictory actions in the same tick.
3. **Feedback loop:** a `SuggestionAccepted` event triggers a projection change that re-scopes the optimizer, which produces another suggestion, which re-plans… a self-sustaining storm with no new external input.

**Why it happens:**
The current optimizer already faced (1) and solved it with the **freeze-window + `scopeHash` memoization** (OPT-06 anti-thrash). Decentralizing into N coordinators *re-opens* the problem N times and adds (2) and (3), which the single global optimizer never had (one solver, one scope).

**How to avoid:**
- **Reuse the proven anti-thrash primitives per coordinator:** memoize each coordinator's suggestion by `scopeHash(scope, snapshot)` so an unchanged scope re-emits nothing (the exact OPT-06 trick); apply a freeze window so a near-departure trailer is never re-suggested.
- **Assign each agent to exactly ONE owning coordinator** (its home regional center) for *binding* suggestions — partition by the same nearest-center rule used for spokes (Pitfall 12), so conflicting advice can't both bind. Cross-boundary coordination is *backbone-level* and explicit, not two coordinators racing on one truck.
- **Suggestion events must NOT re-trigger the suggesting coordinator.** Classify `ActionSuggested`/`SuggestionAccepted`/`SuggestionRejected` as **scope-neutral** in the optimizer/coordinator scope detector (the same way `PlanGenerated`/`PlanAccepted`/`PlanSuperseded` are already scope-neutral in `scope.ts`) — this is the precise guard against the re-plan feedback loop, and the codebase already has the pattern.
- Add an **oscillation test:** a fixed scenario must converge to a stable plan within K epochs (no A↔B↔A cycle), measured in sim-ticks.

**Warning signs:**
A trailer's planned route flips between two values on alternating epochs; events keep flowing with the freight frozen; two `ActionSuggested` events name the same agent in one tick from different coordinators.

**Phase to address:** **P3 Coordinators** (memoization + single-owner partition + scope-neutral suggestion events all ship here).

---

### Pitfall 12: Bad regional-center partitioning (nearest-center across a mountain/huge leg)

**What goes wrong:**
"Each big-city hub spokes to its **nearest** center" by great-circle distance produces degenerate assignments: a hub geographically nearest to center A but separated by a mountain range / no good road; a spoke assigned across a 2,000-mile leg because the nearest *center* is still far; border hubs that flip centers under tiny coordinate changes. The optimizer then plans long, unrealistic legs and the demo looks wrong.

**Why it happens:**
Great-circle "nearest" ignores road feasibility and creates long tails for sparse regions. The current model has ONE center (Memphis) so the question never arose; multi-center makes nearest-assignment a first-class, error-prone step. (The existing transit model derives minutes from great-circle distance when no ORS road exists — so a bad-geometry leg also gets a bad time estimate, compounding the error.)

**How to avoid:**
- Partition centers by **region/timezone first** (the design notes' own suggestion), then nearest-within-region — bounding the worst-case leg and giving stable, explainable assignments.
- **Cap the spoke→center leg length;** if a hub's nearest center exceeds the cap, it signals "this region needs its own center" — feed that back into center selection rather than accepting a transcontinental spoke.
- Make assignment a **pure, deterministic, tie-broken-by-id** function (great-circle distance, ties → lowest center id) so it's golden-reproducible and a coordinate nudge can't silently re-partition the network (Pitfall 2 rounding applies here too).
- **Snapshot-test the partition:** the 1–3-per-state hub set → a fixed center assignment map, committed and asserted, so a future data change is a visible diff, not a silent re-route.

**Warning signs:**
A spoke leg far longer than its region's median; a hub that flips centers between runs; a coastal/border metro assigned to an inland center across a range.

**Phase to address:** **P1 Topology** (partitioning is the core of this phase).

---

### Pitfall 13: 1–3-per-state rule producing degenerate cases (tiny states, metros spanning state lines)

**What goes wrong:**
A naive "top 1–3 metros per state" rule has known degenerate cases: tiny/low-population states (Wyoming, Vermont, the Dakotas) get a forced hub in a town that isn't really a freight node; huge metros that **span state lines** (NYC=NY/NJ/CT, KC=MO/KS, DC=DC/MD/VA, Memphis=TN/MS/AR) get double-counted or assigned to the "wrong" state, distorting the count and the regional partition; and "big city" by raw population vs metro-area vs freight-throughput gives very different hub sets.

**Why it happens:**
State boundaries are a political partition, not a logistics one. The 1–3-per-state rule is a clean *generation* heuristic but a poor *topology* heuristic at the edges, and the dataset choice (city population vs MSA vs CBSA) silently changes which cities qualify.

**How to avoid:**
- Pick the ranking metric **deliberately and document it** (metro/MSA population is the defensible default for "freight node"); commit the curated dataset and **content-checksum it** (like `hubCoordsChecksum`) so the hub set is reproducible and a data change is a visible diff.
- **De-duplicate cross-state metros** to a single hub at a canonical coordinate (one NYC hub, not three) before applying the per-state cap.
- Treat the per-state count as a **floor/ceiling, not an exact quota**: at least 1 where a real freight node exists, up to 3 in dense states — but don't manufacture a hub in a state with no qualifying metro just to hit "1."
- **Assert the generated hub set is deterministic and within the continental envelope** (the existing `lat ∈ [24,49], lon ∈ [-125,-66]` invariant) and count is in the ~80–130 band.

**Warning signs:**
A hub in a town nobody ships through; NYC appears as 2–3 separate hubs; the hub count swings wildly when you switch population sources; a hub outside the continental envelope.

**Phase to address:** **P1 Topology** (dataset + generation rule).

---

### Pitfall 14: Backbone topology — long transit, single points of failure, or re-centralization

**What goes wrong:**
The inter-center backbone (mesh / ring / hub-of-hubs) shapes every cross-region shipment. A **ring** gives O(centers) worst-case hops (slow, unrealistic for coast-to-coast); a **hub-of-hubs** re-creates the single-global-star bottleneck the milestone is explicitly trying to escape (one super-center = single point of failure + the scaling pressure that caused the original freeze); a **full mesh** is O(centers²) legs (geometry/render/optimizer cost). Picking wrong undermines the milestone's whole "decentralize to scale" thesis.

**Why it happens:**
The topology choice is listed as an open research question; it's easy to default to whatever's simplest to build (hub-of-hubs) and re-introduce the exact centralization the redesign exists to remove.

**How to avoid:**
- With a small center count (the design implies a handful, ~4–8 regional centers), a **near-full mesh or a sparse mesh of adjacent-region links** keeps hop count ≤ 2 and stays cheap (O(centers²) is tiny when centers ≈ 6). Prefer this over a ring (too many hops) and over hub-of-hubs (re-centralizes).
- Make backbone legs explicit `Route`s with great-circle geometry (same pipeline as spokes) so they render and cost consistently.
- **Verify no single center is on every cross-region path** (the anti-SPOF check) — a graph test asserting connectivity survives removing any one center.
- Keep per-center fan-out **bounded** (the design's stated goal) so no center's optimizer scope blows up (Pitfall 15).

**Warning signs:**
Coast-to-coast freight routes through 4+ centers; one center appears in nearly every plan; backbone leg count grows quadratically and dominates render/optimizer time.

**Phase to address:** **P1 Topology** (backbone is built here) with a **P5 Hardening** connectivity/SPOF test.

---

### Pitfall 15: Per-center optimizer scope BLOWUP (decentralization done wrong)

**What goes wrong:**
The redesign's promise is "O(active) per agent/coordinator, not O(total state)." It's easy to accidentally rebuild the global solve: a coordinator that, on any event, re-optimizes its *entire region* (all its spokes' trailers) instead of just the affected slice; or N coordinators each reading the *whole* twin every epoch (N × full-scan = worse than the one global solve it replaced). At 100 hubs and per-center optimizers firing on a busy continental stream, this is the freeze again, distributed.

**Why it happens:**
The existing optimizer already does scoped epochs correctly (`detectAffectedScope` bounds to referenced hubs/trailers + a 240-min horizon). But coordinators are *new* call sites; whoever writes them may call `buildTwinSnapshot` (which still does full-log scans — Pitfall 9) per coordinator per epoch, multiplying the existing debt by the coordinator count.

**How to avoid:**
- **Each coordinator reuses `detectAffectedScope`** and optimizes only its scoped slice within its region — never the whole region, never the whole network. The "coordinators may use the optimizer" relationship must be *scoped optimizer epochs*, not full regional re-solves.
- **One shared twin read per frame, sliced per coordinator** — do not let each of N coordinators independently `readAll(0n)` the log. Fix Pitfall 9's `twin-snapshot` first; then coordinators read the shared incremental projection and filter to their hubs.
- **Bound horizon + node granularity** exactly as `scope.ts` already does (coarse 15-min nodes, 240-min horizon — the anti-P9 graph-explosion guard).
- Add a **scope-size invariant test:** a single event in region R triggers an epoch whose scope ⊆ R's affected hubs, with size independent of total network size.

**Warning signs:**
Total optimizer CPU per frame grows with coordinator count even when little changed; a coordinator's epoch scope equals its whole region; `readAll(0n)` shows up once per coordinator per epoch in a profile.

**Phase to address:** **P3 Coordinators** (scoping discipline ships with them), depends on **P1/P5** twin-snapshot fix.

---

### Pitfall 16: WS payload bloat + viz clutter at 100+ hubs / backbones / suggestion overlays

**What goes wrong:**
Two coupled failures:
- **Transport:** the snapshot/tick envelope (`snapshots.ts`) currently sends hubs/routes/trailers per tick. At 100+ hubs + ~200 backbone+spoke routes + per-tick suggestion overlays, the snapshot balloons and per-frame ticks get heavy — re-introducing the per-frame cost the paced driver was built to bound, now on the *wire* instead of the *DB*.
- **Visual:** 100+ hub markers + a backbone web + suggestion arrows render as unreadable spaghetti; OpenLayers `VectorLayer` also degrades on pan/zoom with that many features.

**Why it happens:**
The 10-hub viz never needed clustering or diffing of static geometry. The wire protocol sends full state where it should send diffs; the map draws every feature where it should cluster.

**How to avoid:**
- **Send static topology ONCE** (hubs + routes are immutable after registration) in the initial snapshot; per-tick deltas carry only moving trailers + transient suggestions (the protocol already does `diffTick` for changed entities — ensure hubs/routes are excluded from per-tick payloads at scale).
- **Cluster hub markers** with `ol/source/Cluster` (distance-in-pixels) and use `VectorImageLayer` (not `VectorLayer`) for the dense static network — both are the documented OpenLayers remedies for "many points / slow pan-zoom."
- **Make suggestion overlays opt-in / decluttered** (toggle, or only show for a selected hub/region) — never render every coordinator's advisory arrows at once. Use OpenLayers `declutter` for label/arrow collisions.
- **Budget the tick payload size** (assert per-tick bytes stay bounded as hub count grows) — the same "bounded per frame" discipline the driver already applies to DB work.

**Warning signs:**
ws message size grows with hub count each tick; map FPS drops on pan/zoom; the demo is visually unreadable; the client's tween loop stutters.

**Phase to address:** **P4 Viz** (clustering, VectorImageLayer, decluttered overlays, payload diffing).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Leave `applyHubInventory` as a full-table scan | No projection surgery now | The v2.1 freeze RECURS at 100 hubs (O(events×hubs)) | **Never** for v3.0 — the topology jump makes this active, not latent (P1) |
| Keep `twin-snapshot`'s two `readAll(0n)` full scans | Optimizer "just works" unchanged | O(log²) over a run × coordinator count; bites sooner with per-center epochs | Only if `optimizerEveryTicks` is large and run is short; fix in P5 |
| Per-agent RNG via `seed + index` | Trivial to write | Correlated streams + order-fragility (Pitfall 3) | **Never** — use `mixSeed(... ^ stableAgentHash(id))` |
| Coordinator re-suggests with no rejection memory | Simplest coordinator | Advisory-reject livelock (Pitfall 10) | **Never** ship a coordinator without a suppression/cooldown |
| Send full hub/route topology every tick | One code path | WS bloat at scale (Pitfall 16) | MVP-only at 10 hubs; must diff before P1 lands 100 hubs |
| Capture new golden before the model is reproducible | Unblocks a phase | A non-reproducible golden bakes in a flake forever (Pitfall 2/8) | **Never** — prove same-seed reproducibility + flags-off gate FIRST |
| Manufacture a hub per low-pop state to hit "≥1" | Clean per-state quota | Hubs nobody ships through, distorted partition (Pitfall 13) | **Never** — quota is a floor/ceiling, not exact |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `@alexanderfedin/async-queue` | Using it inside `step()`/`react()` decision logic | Confine to runtime plumbing (worker handoff, ws backpressure, DB batching); decision core stays sync+pure (Pitfall 5) |
| Optimizer (as suggestion engine) | Each coordinator runs a full regional re-solve via `buildTwinSnapshot` | Reuse `detectAffectedScope`; scoped epoch over a shared per-frame twin (Pitfalls 9, 15) |
| `scope.ts` exhaustive switch | New OODA/suggestion events left unclassified, or classified as demand hubs | Add to the `default: never` switch; suggestion events are SCOPE-NEUTRAL (Pitfalls 8, 11) |
| `scopeHash`/`canonicalize` | New hashed payload hand-serialized, bypassing key-sort | Route every hashed structure through existing `canonicalize` (Pitfall 7) |
| OpenLayers at scale | Dense `VectorLayer` + every feature drawn | `VectorImageLayer` + `ol/source/Cluster` + `declutter` (Pitfall 16) |
| Big-city dataset | Loaded/derived at runtime or from a network source | Curated, committed, content-checksummed static file (Pitfalls 12, 13) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `applyHubInventory` full-table fold per event | Sim "time stops" / throughput decays (the v2.1 symptom) | Key-scope to touched hub id(s) | ~50–130 hubs (this milestone) |
| `twin-snapshot` `readAll(0n)` ×2 per epoch | Optimizer latency grows with run length | Incremental cursor fold | Long continental runs × per-center epochs |
| Per-agent step over a `Map`/`Set` | Golden flips at scale / on restart | Sorted-by-id step array + `claimSeq` | ~100s of agents |
| N coordinators each reading whole twin | Optimizer CPU grows with coordinator count | One shared twin/frame, sliced per scope | A handful of busy coordinators |
| Full topology in every ws tick | Tick bytes grow with hub count | Static topology once; diff trailers/suggestions | 100+ hubs + backbone |
| Dense OpenLayers `VectorLayer` | FPS drops on pan/zoom | `VectorImageLayer` + clustering | 100+ markers + routes |
| Unbounded per-(agent) suggestion re-emission | events/tick grows with freight frozen | Rejection suppression + sim-tick cooldown | Any infeasible-suggestion scenario |

## Security Mistakes

Not a primary axis for this simulation demo (no auth, no PII, no external network in the hot path — RFID/WMS/TMS integration is explicitly out of scope). The relevant integrity concern is **determinism integrity**, covered exhaustively above. One concrete control: the static big-city dataset must be **committed and content-checksummed** (like `hubCoordsChecksum`) so a silent data swap can't change the network — a supply-chain-of-data integrity guard, not a classic security control.

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing every coordinator's advisory arrows at once | Map unreadable; can't see freight flow (the demo centerpiece) | Decluttered, opt-in/selected-region suggestion overlay |
| 100+ identical hub dots, no hierarchy | Can't tell regional centers from spokes | Visually distinguish centers (size/color) from spokes; cluster spokes at low zoom |
| Re-flashing historical suggestions on reconnect | Confusing replays of old advice | Keep suggestions TICK-ONLY (the codebase already does this for induction/delivery flashes — see `driver.ts`) |
| Plan flipping visibly each epoch (oscillation) | Looks broken/indecisive | Anti-thrash memoization + freeze window (Pitfall 11) |

## "Looks Done But Isn't" Checklist

- [ ] **Flags-off gate:** every v3.0 flag has BOTH `flag:false === absent` AND `absent ⇒ hash 3920accc…` tests — verify the 10k golden still passes with all flags off.
- [ ] **Agent step order:** shuffling the per-tick agent set produces a byte-identical event batch — verify with an order-shuffle test, not just a same-run test.
- [ ] **Per-agent RNG:** N agents → N decorrelated streams from STABLE ids — verify no two agents share their first K draws, and renaming/reordering agents doesn't change the golden.
- [ ] **Advisory reject path:** an agent that rejects EVERY suggestion still closes its tick (feasible no-op default) and the coordinator stops re-suggesting after K rejections — verify events-per-tick stays bounded.
- [ ] **Coordinator scope:** a single event triggers an epoch whose scope ⊆ affected hubs, size independent of network size — verify the scope-size invariant.
- [ ] **`applyHubInventory` key-scoped:** per-event row reads independent of hub count — verify 10-hub vs 100-hub fold cost is equal per event.
- [ ] **Suggestion events scope-neutral:** `ActionSuggested`/`Accepted`/`Rejected` do NOT re-trigger the suggesting coordinator — verify no self-sustaining storm on a quiescent stream.
- [ ] **Multi-center degenerates:** the 10-hub single-center input produces the IDENTICAL `Route[]` it does today — verify byte-identical legacy topology.
- [ ] **Backbone connectivity:** network stays connected with any one center removed; no coast-to-coast path exceeds 2 center hops.
- [ ] **Hub generation deterministic:** ~80–130 hubs, all inside the continental envelope, cross-state metros de-duped, committed + checksummed.
- [ ] **WS at scale:** per-tick payload bytes bounded as hub count grows (static topology sent once).

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Golden drift (flags-off) | LOW-MEDIUM | `git bisect` against the DET-01 gate; find the unconditional draw/reorder; make it flag-lazy |
| Cross-arch float divergence | MEDIUM | Move transcendental output out of hashed payloads; round at boundary; last resort = integer LUT sampler (documented contingency) |
| Per-agent RNG correlation | LOW | Swap derivation to `mixSeed(seed ^ stableAgentHash(id))`; re-capture goldens (new model, expected) |
| Advisory-reject livelock | MEDIUM | Add rejection-reason suppression + feasible no-op default + sim-tick cooldown; assert bounded events/tick |
| O(n²) hub-inventory freeze | LOW-MEDIUM | Apply the SAME key-scoping surgery already done for the other projections in `inline.ts` |
| Coordinator scope blowup | MEDIUM | Route through `detectAffectedScope`; share one twin read/frame; fix `twin-snapshot` cursor fold first |
| Bad center partition / degenerate hubs | LOW | Switch ranking metric; de-dup cross-state metros; cap leg length; re-commit checksummed dataset |
| Viz clutter / ws bloat | LOW-MEDIUM | Static topology once + `VectorImageLayer` + `ol/source/Cluster` + decluttered opt-in overlays |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 Agent step order | P2 OODA | Order-shuffle test → byte-identical batch |
| 2 Float divergence | P1 Topology + P5 Hardening | Same-arch repro test; documented golden capture env; cross-run snapshot-hash test |
| 3 RNG substream collision | P2 OODA | N-agent decorrelation test; rename/reorder leaves golden unchanged |
| 4 Mid-tick projection read | P2 OODA / P3 Coordinators | Frozen-observation test (shuffle agents → identical batch) |
| 5 Async ordering leak | P2/P3 + P5 guard | Architecture import-guard (no `async-queue`/`kysely` in decision core); golden-flake watch |
| 6 `Date.now`/`Math.random` | P2/P3 + P5 guard | ESLint/static guard fails CI on a hit |
| 7 JSON key-order | P3 Coordinators + P5 | All hashed payloads via `canonicalize`; Zod-validated event types |
| 8 Flags-off golden drift | EVERY phase + P5 audit | DET-01 two-part gate per flag; 10k hash == `3920accc…` |
| 9 O(n²) projection/full-scan | P1 Topology (hub-inventory) + P5 (twin-snapshot) | Per-event cost independent of hub count |
| 10 Advisory-reject deadlock | P3 Coordinators | Reject-all agent still closes tick; bounded events/tick; cooldown after K rejects |
| 11 Oscillation / feedback loop | P3 Coordinators | `scopeHash` memo + single-owner partition; suggestion events scope-neutral; converge-in-K-epochs test |
| 12 Center partitioning | P1 Topology | Committed partition snapshot; leg-length cap; tie-break-by-id |
| 13 1–3-per-state degenerate hubs | P1 Topology | Deterministic ~80–130 hub set in-envelope; cross-state metros de-duped; checksummed dataset |
| 14 Backbone topology | P1 Topology + P5 | Connectivity/SPOF test (remove any center); ≤2-hop coast-to-coast |
| 15 Coordinator scope blowup | P3 Coordinators (dep P1/P5) | Scope-size invariant ⊆ affected hubs, network-size-independent |
| 16 Viz clutter / ws bloat | P4 Viz | Bounded per-tick bytes; clustered `VectorImageLayer`; decluttered overlays |

## Sources

- **This repository (HIGH confidence — primary source):**
  - `packages/projections/src/runner/inline.ts` — the v2.1 key-scoped fold fix AND the residual `applyHubInventory` full-table scan (Pitfall 9).
  - `packages/api/src/optimizer/twin-snapshot.ts` — the two `readAll(0n)` full-log scans per epoch (Pitfall 9); the `.orderBy(...)` determinism comment (Pitfall 1).
  - `packages/simulation/src/rng.ts` + `engine.ts` — `mixSeed`/splitmix32, the 8 substream salts + pairwise-distinct salt-collision tests (Pitfall 3); `(fireTick, insertionSeq)` queue ordering (Pitfall 1).
  - `packages/optimizer/src/rolling/scope.ts` + `freeze-idempotency.ts` — `detectAffectedScope`, scope-neutral events, `canonicalize`, `scopeHash`, `isFrozen` anti-thrash (Pitfalls 7, 11, 15).
  - `packages/simulation/src/network/routes.ts` + `hubs.ts` — `greatCircle` transcendental math, `hubCoordsChecksum` rounding, the single-center `buildRoutes` to generalize (Pitfalls 2, 8, 12).
  - `packages/simulation/test/determinism.unit.test.ts` — golden `3920accc…`, the DET-01 flags-off two-part gate pattern, the cross-arch float contingency note (Pitfalls 2, 8).
  - `packages/api/src/sim/driver.ts` — per-frame fold boundary, tick-only transient flashes (Pitfalls 4, 7).
  - `.planning/v3.0-DESIGN-NOTES.md` + `.planning/PROJECT.md` — locked decisions, carried debt, the async-queue "runtime plumbing only" constraint.
- **External (MEDIUM-HIGH):**
  - JS transcendental non-determinism: [mathsies — float-determinism notes](https://github.com/Tachytaenius/mathsies), [Lock-step simulation is child's play (arXiv 1705.09704)](https://arxiv.org/pdf/1705.09704), [math.js atan2 / IEEE-754 notes](https://mathjs.org/docs/reference/functions/atan2.html) — transcendentals are "recommended," not IEEE-754-mandated → cross-platform 1-ULP divergence (Pitfall 2).
  - Process-manager / saga oscillation + single-owner instance: [Event-Driven.io — Saga and Process Manager](https://event-driven.io/en/saga_process_manager_distributed_transactions/), [microservices.io — Saga](https://microservices.io/patterns/data/saga.html) (Pitfalls 10, 11).
  - Multi-agent anti-oscillation / event-triggered control (Zeno-behavior exclusion via dynamic threshold = cooldown/hysteresis): [Adaptive Event-Triggered Consensus (PMC10819465)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10819465/), [Distributed Broadcast Control / hierarchical coordination (PMC11274499)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11274499/) (Pitfalls 10, 11).
  - OpenLayers scale rendering: [OpenLayers Cluster example](https://openlayers.org/en/latest/examples/cluster.html), [Cluster source API](https://openlayers.org/en/latest/apidoc/module-ol_source_Cluster-Cluster.html), [VectorImageLayer / declutter guidance](https://openlayers.org/en/latest/examples/declutter-group.html) (Pitfall 16).

---
*Pitfalls research for: continental OODA agent network + advisory coordinators on a deterministic event-sourced sim (milestone v3.0)*
*Researched: 2026-06-26*
