# Pitfalls Research

**Domain:** Simulation-driven, event-sourced middle-mile trailer optimization platform (TypeScript/Node + PostgreSQL + OpenLayers)
**Researched:** 2026-06-18
**Confidence:** HIGH on stack/tooling facts (verified: OR-Tools JS immaturity, OpenLayers leaks, ES concurrency mechanics); MEDIUM-HIGH on domain-logic pitfalls (derived from spec §7/§11/§12 + event-sourcing community practice)

> Scope note: this is a **simulation demo**, not a production pilot. That changes the risk profile. The dangerous failure mode here is **a demo that silently lies** — an optimizer that "wins" only because the simulation was rigged, plans that aren't actually LIFO-correct, KPIs that don't move, or replay that doesn't reproduce. Every critical pitfall below is selected for "this is what makes the demo look good while being wrong."

---

## Critical Pitfalls

### Pitfall 1: Off-by-one / inverted depth↔unload-order mapping in the LIFO planner

**What goes wrong:**
The whole product is the LIFO accessibility constraint (spec §7.2): `if unloadOrder(A) < unloadOrder(B) then depth(A) <= depth(B)`. There are four easy-to-swap axes — *rear→nose physical order*, *slice index*, *depth-from-rear*, and *route stop sequence / unload order*. The greedy in §11.5 sorts blocks by `orderMap[nextUnloadHub] descending` and places "from nose toward rear." A single inverted comparator or sign flip produces plans that are the **exact reverse** of LIFO-correct: freight for the last hub ends up at the rear door. The plan still renders, still scores, still validates against an equally-inverted validator — so it looks done and is catastrophically wrong.

**Why it happens:**
Two independent encodings of the same concept (depth increases toward nose; unload order increases toward later hubs) get conflated. `Deque` push-front vs push-back ambiguity (spec §6.3 models slices as a `Deque`). The validator (§11.6) is usually written by the same person with the same mental model, so it agrees with the bug.

**How to avoid:**
- Pick **one** canonical invariant and assert it everywhere: `depth(rear) = 0`, depth increases toward nose; `unloadOrder` = index of hub in remaining route, lower = unloaded sooner. Write it as a TS type-level/runtime invariant.
- Make the validator **independent of the planner's internal ordering** — it should recompute blockers from the placed slices, not trust placement order. The blocker definition (§7.4) must be tested as a pure function with hand-built fixtures, not just against planner output.
- Golden-fixture tests: hand-construct a 4-hub route, hand-place blocks both correctly and reversed, assert validator flags the reversed one. This is the single most important test in the codebase.
- Property test: for any random plan the planner emits, `validateLoadPlan` should report zero hard violations — fuzz it.

**Warning signs:**
Validator reports zero violations on *every* generated plan (validator and planner share the bug). Loading instructions tell the dock to load nearest-hub freight deep. Rehandle KPI is suspiciously always ~0 in the demo.

**Phase to address:** Phase 2 (Load Block + Trailer Slice). This is the load-bearing correctness phase — gate it with an independent validator and golden fixtures before anything else builds on it.

---

### Pitfall 2: Blocker definition wrong, or partial-LIFO threshold makes infeasible plans look feasible

**What goes wrong:**
`blockers(target) = blocks closer to rear with unloadOrder > target's` (§7.4). Common errors: using `>=` (counts same-hub blocks as blockers, inflating cost), counting blocks *behind* (deeper) rather than in front, or counting blocks that share a slice. Separately, `maxAllowedBlockers` (§7.3) is meant to mark a plan **infeasible/high-risk** when exceeded — but if "infeasible" is only a soft penalty in the objective (§12), the optimizer will happily ship physically un-unloadable trailers because some other term (utilization) dominated.

**Why it happens:**
"Blocker" is deceptively simple but has boundary cases (same hub, same slice, multi-block slices). The objective function (§12) folds rehandle into a weighted sum, so a hard physical constraint silently becomes negotiable.

**How to avoid:**
- Encode `maxAllowedBlockers` violations as a **hard feasibility gate**, not a penalty weight. A plan exceeding it should be rejected/repaired (§11.7), never published with a score.
- Unit-test blocker counting against the spec's exact predicate with same-hub and multi-block-slice fixtures.
- Keep rehandle cost (soft, §7.5) and feasibility (hard, §7.3) as **two separate outputs** of validation, never collapsed into one number until after the feasibility gate passes.

**Warning signs:**
Plans with high rehandle scores still get "accepted." Same-hub freight shows up as mutually blocking. Repair loop (§11.7) never triggers because nothing is ever marked infeasible.

**Phase to address:** Phase 2 (validation/scoring); reinforced in Phase 4 when the objective function could otherwise "buy out" feasibility.

---

### Pitfall 3: Non-deterministic event replay (projections can't be rebuilt identically)

**What goes wrong:**
Event sourcing's whole value (spec §9.1: "where was package X last seen", reconstruct history, "did the system recommend this plan") depends on **replaying the same events producing the same projection state**. In TS/Node this breaks when projection handlers use `Date.now()`, `Math.random()`, `Array.sort` without a stable comparator (V8's sort is stable now but comparator ties + floating keys aren't), `Object.keys` iteration order assumptions, `Map` insertion-order coupling, locale-dependent string compare, or any I/O/async race. Replay then yields a *different* "current package location" than the live run — the audit answer changes depending on when you ask.

**Why it happens:**
Handlers are written as ordinary Node code; ambient nondeterminism (time, random, ordering) leaks in unnoticed because the live path "looks right." The bug only surfaces on rebuild, which nobody does until a projection is corrupted.

**How to avoid:**
- **Projections must be pure functions of (current state, event).** No `Date.now()` — timestamps come *from the event payload* (the spec's events all carry `timestamp`, §8.3/§15). No `Math.random` in handlers (push all randomness into the simulator). Inject a clock; never read the wall clock in a reducer.
- Persist a monotonic global sequence (BIGSERIAL / per-aggregate version) and **replay strictly in sequence order**, never by timestamp (timestamps tie and skew).
- CI test: build projection live, then drop and rebuild from the event store, assert byte-identical state. Run this every build — it is cheap insurance and catches nondeterminism immediately.
- Forbid floating-point keys in sort/group; bucket deadlines/sizes into integer buckets (the spec already buckets — §11.1 `deadlineBucket`, `sizeWeightBucket`).

**Warning signs:**
"Replay gives different numbers." Snapshot/rebuild produces different package locations. Sort order of load blocks shifts between runs with identical input.

**Phase to address:** Phase 1 (Operational Data Foundation) — bake the live-vs-rebuilt equivalence test in from day one; it is far cheaper to enforce than to retrofit.

---

### Pitfall 4: Missing optimistic concurrency → projection drift and lost events

**What goes wrong:**
Appending events without an expected-version check lets two writers to the same trailer/package stream interleave, producing impossible histories (e.g., `TrailerDeparted` before the last `PackageLoaded` it should have included). Projections built from a corrupted stream drift from reality. Even in a single-process demo, the *rolling optimizer* (§11.9) and the *simulator* both write events concurrently (event-triggered replan emits `PlanGenerated`/`PlanAccepted` while sim emits scans), so this is live even without distributed deployment.

**Why it happens:**
"It's single-process, I don't need concurrency control" — but async/await interleaving in Node is real concurrency at the I/O boundary. Two `await append()` calls can interleave around the DB round-trip.

**How to avoid:**
- Per-aggregate stream version with a **unique constraint on `(aggregate_id, version)`** in Postgres; append is an INSERT/UPDATE that fails on version mismatch (verified standard pattern). Caller passes expected version; on conflict, reload and retry the command.
- Use a single global ordering column (BIGSERIAL) for replay; use per-stream version for concurrency.
- Treat the append as the only writer of truth; projections are downstream and idempotent (track last-processed sequence per projection — see Pitfall 5).

**Warning signs:**
Events for one trailer appear out of causal order. Two `PlanGenerated` events for the same epoch. Projection "lag" or gaps. Duplicate version rows would-be (caught by the unique constraint if present, silently corrupting if absent).

**Phase to address:** Phase 1 — the event store contract. Re-verify in Phase 4 when the optimizer becomes a concurrent writer.

---

### Pitfall 5: Non-idempotent projections / replan; double-counted sensor observations

**What goes wrong:**
Two coupled failures:
(a) **Projections** that aren't idempotent re-apply events on restart/replay/at-least-once delivery, double-counting hub inventory or package touches.
(b) **Sensor fusion** (§8.5) that treats each `RfidObserved` as fresh independent evidence will multiply confidence on repeated reads of the *same* tag by the *same* portal in one dwell — RFID portals fire many reads per second. Confidence rockets to 0.99 from what is really one observation, making the demo's "RFID caught the wrong trailer" look more reliable than physics allows.

**Why it happens:**
At-least-once is the default in any event pipeline. RFID's multi-read nature (spec §22 Risk 1 lists multipath/orientation) is exactly why a single tag generates bursts; naive Bayesian update assumes independence that doesn't hold.

**How to avoid:**
- Projections track **last-processed sequence number** and ignore events at/below it (idempotent fold). Make every handler safe to re-run.
- Dedup/aggregate RFID reads into **observation windows** (per tag, per reader, per dwell) before fusion; one fused observation per window, not per raw read.
- Model confidence with explicit independence assumptions: correlated reads from one antenna are **one** evidence source. Cap confidence; never let rule-based scoring asymptote to 1.0 from repetition alone.

**Warning signs:**
Hub inventory counts grow on service restart. Confidence hits 0.99+ implausibly fast. Wrong-trailer alerts fire with suspiciously high certainty. Replaying doubles package-touch KPIs.

**Phase to address:** Idempotent projections → Phase 1. RFID double-counting / confidence math → Phase 3 (RFID validation).

---

### Pitfall 6: Treating RFID as truth instead of probabilistic evidence

**What goes wrong:**
The spec is emphatic (§5.8, §8.2, §22 Risk 1): RFID is **sensor evidence, not ground truth**. The easy implementation collapses confidence — code that does `if (rfidObserved) package.location = observedZone` makes RFID authoritative, overwriting the planned/known state. Then a single missed read (RFID's normal failure mode) reads as "package vanished," and a multipath false read on a neighboring trailer reads as a wrong-trailer exception. The exception dashboard fills with false positives and the demo's "validation" story collapses.

**Why it happens:**
Probabilistic state is more work than a boolean. Confidence scores get computed then ignored at the decision point.

**How to avoid:**
- Keep **two layers**: planned/known state (from scans + plan) and observed evidence (from RFID, confidence-scored, §8.4). Exceptions are raised on *disagreement above a confidence threshold*, not on raw observation.
- A *missing* RFID read must never imply "package gone" — absence of evidence ≠ evidence of absence. Only positive observations in the *wrong* place, above threshold, raise `WrongTrailerDetected` (§17.1).
- Drive the false-positive rate as an explicit demo KPI; tune thresholds so the demo shows *useful* alerts, not noise.

**Warning signs:**
Wrong-trailer/missed-unload alerts on nearly every trailer. Package locations flicker as reads come and go. Confidence field exists but no code reads it before acting.

**Phase to address:** Phase 3 (RFID-Assisted Validation).

---

### Pitfall 7: Rolling-horizon plan thrashing (no effective freeze window / non-idempotent replan)

**What goes wrong:**
The optimizer replans every 5–15 min and on events (§11.9). Without a working **freeze window** (§11.9: don't touch trailers departing within 10–15 min), each epoch reshuffles assignments, so on the live map trailers' plans churn every cycle, KPIs oscillate, and operators see contradictory instructions. Worse: if replan isn't idempotent (re-running on identical state yields a *different* plan due to tie-breaking randomness or unstable sort), the system looks unstable even when nothing changed.

**Why it happens:**
Re-optimizing the full affected scope from scratch each epoch, with no hysteresis and no anchoring to the previous plan. Tie-breaks resolved by hash/random order. "Affected scope detection" (§11.9 `detectAffectedHubsTrailersBlocks`) too broad, so everything is always in scope.

**How to avoid:**
- Hard freeze: plans for trailers inside the departure freeze window are **immutable** unless a critical exception fires. Enforce in the input builder (frozen entities excluded from decision variables).
- **Anchor** to previous plan: add a change-penalty term so the optimizer only deviates when the gain exceeds a threshold (hysteresis). The objective §12 has no such term yet — add `planChurnPenalty`.
- Make replan deterministic: stable tie-breaking by entity id, no random restarts in the demo path (or fixed seed).
- Get scope detection right: an event at hub H should re-scope only H and downstream-affected trailers, not the network.

**Warning signs:**
Trailer assignments change every epoch with no triggering event. Map shows constant re-routing. KPI charts oscillate. Same input, different plan twice in a row.

**Phase to address:** Phase 4 (Rolling Optimizer). Add freeze + churn-penalty + deterministic tie-break as explicit success criteria.

---

### Pitfall 8: Optimizer "wins" only because the simulation was rigged (no baseline)

**What goes wrong:**
The demo's entire claim is "we reduce rehandle / improve utilization." If there's **no baseline policy** to compare against (e.g., naive FIFO/random loading, no replanning), any number the optimizer produces is unfalsifiable theater. Equally, if the simulator's event distributions are tuned (consciously or not) so that LIFO always helps and SLAs are never tight, the optimizer looks great on a problem that isn't hard. The exit criteria the spec itself demands (§23: "10%+ reduction in rehandle", "compare planned vs actual") require a control.

**Why it happens:**
Building the optimizer is the fun part; building a credible strawman baseline and an *adversarial* simulator is not. Sim parameters drift toward whatever makes the demo look good.

**How to avoid:**
- Implement a **baseline planner** (greedy non-LIFO or FIFO + no rolling repair) and run both on the *same* simulated event stream; report deltas (rehandle, utilization, SLA, missed-unload). The map/dashboard should show "optimized vs baseline."
- Calibrate the simulator against the spec's pilot realism (§23: 2–4 hubs, 5–10 routes, 20–50 trailers, tight SLA classes) and make scenarios *hard enough* that LIFO sometimes can't win without over-carry/hold/reassign — that's where the optimizer earns its keep.
- Freeze the simulation seed per scenario so results are reproducible and reviewers can re-run.

**Warning signs:**
No "vs baseline" anywhere in the UI. Optimizer always shows ~0 rehandle. SLA violations never occur in the sim. Changing the objective weights doesn't change outcomes (because the scenario was never binding).

**Phase to address:** Simulation/visualization wrapper, but **design the baseline comparison in from Phase 2** (the load planner already needs something to beat) and carry it through Phase 4.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Rebuild projections in-memory only (no persisted read models) | Faster to start, no migration | Replay cost grows with event count; no live-vs-rebuilt test; restart = full replay | OK for early Phase 1 if event volume is bounded by sim; add persisted projections + last-seq before Phase 4 |
| Single weighted objective number, no separate feasibility gate | Simple scoring | Hard LIFO constraints become negotiable; ships un-unloadable trailers (Pitfall 2) | **Never** — feasibility must gate before scoring |
| `min-cost-flow` npm (pure-JS successive shortest paths) instead of OR-Tools | No native build, works in Node | Slow on time-expanded graphs; integer-capacity only; silent wrong answers if costs are floats (Pitfall 12) | OK for small demo networks (2–4 hubs); verify against hand-computed cases |
| No freeze window in early optimizer | Simpler loop | Plan thrashing, unstable demo (Pitfall 7) | OK for one spike; must land before any live-map demo |
| RFID confidence as `if observed` boolean | Less math | Collapses probabilistic model the whole product rests on (Pitfall 6) | **Never** in the validation phase |
| Store events as untyped JSONB, no version field | Fast schema | No event-schema evolution; replay breaks when payload shape changes (Pitfall 11) | OK in Phase 1 spike; add `eventType`+`schemaVersion` discriminator before more event types land |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OpenLayers + OSM tiles | Hammering tile.openstreetmap.org (rate-limited, blocks demos); CORS errors on custom sources | Respect OSM tile usage policy / use a tile provider with a key; set `crossOrigin: 'anonymous'`; consider local/cached tiles for a reproducible demo |
| OpenLayers vector layers | Recreating Feature objects every tick → re-render storms + GC churn (verified: feature churn drives OL perf problems) | Mutate existing feature geometry in place (`feature.getGeometry().setCoordinates(...)`); never rebuild the source each frame; use `renderBuffer`/declutter sparingly |
| OpenLayers layer/map lifecycle | Adding/removing layers or maps without disposal → documented memory leaks (OL issues #8141, #10437, #7954) | On teardown: clear sources, dispose renderers, set source null, remove layers, set map null. Don't recreate the map on data change |
| Postgres event store | Replaying by `timestamp` (ties, clock skew) instead of monotonic sequence | Append BIGSERIAL global sequence; replay by sequence; timestamps are data, not order |
| OR-Tools in Node | Assuming a maintained native binding exists (mapbox/node-or-tools supports only Node 4/6; no official JS API) | Use OR-Tools-via-WASM, a pure-JS solver for the demo scale, or a child-process bridge — and budget the integration risk explicitly |
| WebSocket/SSE to map | Pushing every event to the browser → re-render storm | Throttle/batch to animation frames; send diffs (moved trailers) not full state |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Time-expanded graph explosion | Min-cost flow / VRP slow or OOM; solver runtime KPI spikes | Coarse time discretization (spec §11.2 uses 15-min nodes); prune unreachable nodes; scope per affected hubs (§11.9) not national (§4.3) | Fine time steps × many hubs × long horizon — combinatorial; even a "small" national graph blows up |
| Pure-JS min-cost flow on large graphs | Plan latency seconds→minutes; freeze window violated | Keep demo network small (2–4 hubs); precompute/cache; consider WASM solver if scaling | >~hundreds of nodes/edges with the successive-shortest-paths impl |
| Re-render storm on the map | Dropped frames, fan noise, growing memory | In-place geometry updates; rAF batching; cap visible features; WebGL points layer for many trailers | Hundreds+ animated trailers updating per tick |
| Smooth trailer interpolation done wrong | Trailers teleport between events, or interpolation runs unbounded timers leaking | Interpolate position between last two known points using **event timestamps**, clamp to [0,1], drive from a single rAF loop tied to a sim clock | Many trailers each with their own setInterval |
| Full projection replay on every restart | Slow startup grows with history | Snapshots + last-processed sequence; incremental projection | Event count grows over a long demo run |
| Replan over too-broad scope | Solver runtime grows each epoch; thrashing | Tight affected-scope detection; freeze windows shrink the decision set | Scope = whole network every epoch |

---

## Security Mistakes

*(Demo scope, no real PII/hardware — security is low-priority here, but the demo-integrity analogues matter.)*

| Mistake | Risk | Prevention |
|---------|------|------------|
| Mutable event store (events editable/deletable) | Destroys auditability — the spec's core ES justification (§9.1) | Append-only table; no UPDATE/DELETE on events; enforce at DB grant level |
| Override audit not capturing system recommendation at the time | Spec §16.3 requires who/when/what/reason/**system-rec-at-time**; missing it breaks the audit story | Capture the recommendation snapshot in the `PlanOverridden` event payload |
| Tile/asset loaded over mixed content or unpinned CDN | Demo breaks on HTTPS; CORS failures | HTTPS tiles, pinned versions, local fallback |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Non-explainable plans ("trust the score") | Operators/reviewers can't believe the demo; spec §3.1.8 demands explainability | Every plan surfaces *why*: blockers avoided, rehandle minutes saved vs baseline, which constraint forced an over-carry (§16.2 alert examples) |
| KPI dashboard where numbers don't visibly move | Demo falls flat — looks like nothing's happening | Show live deltas vs baseline; animate KPI changes on replan; make at least one scenario where the optimizer's intervention is dramatic |
| Loading instructions in raw slice indices | Dock-worker view (§16.1) unreadable | Translate to human zones: "Nose: H10 freight → Middle: H9 → Rear: H8" exactly as spec §16.1 |
| Alert flood (Pitfall 6 false positives) | Reviewers tune out; "exception" loses meaning | Confidence-thresholded, severity-ranked, deduplicated alerts |
| Map shows trailers but no freight/SLA state | Looks pretty, says nothing | Color/encode SLA-risk and blocked-freight on the map — the demo's value is *visibility* (spec Stage 1–2) |

---

## "Looks Done But Isn't" Checklist

- [ ] **LIFO planner:** Often missing an *independent* validator — verify a deliberately-reversed plan is flagged by golden fixtures (Pitfall 1)
- [ ] **Feasibility:** Often collapsed into the score — verify `maxAllowedBlockers` is a hard gate, not a penalty weight (Pitfall 2)
- [ ] **Event replay:** Often nondeterministic — verify live projection == dropped-and-rebuilt projection, byte-for-byte, in CI (Pitfall 3)
- [ ] **Append path:** Often no concurrency control — verify expected-version check + unique `(aggregate_id, version)` constraint (Pitfall 4)
- [ ] **Projections:** Often non-idempotent — verify re-applying an event is a no-op (last-seq tracking) (Pitfall 5)
- [ ] **RFID:** Often boolean truth — verify a missing read does NOT mark a package missing, and confidence is read before acting (Pitfall 6)
- [ ] **Rolling optimizer:** Often thrashes — verify freeze window holds and identical input → identical plan (Pitfall 7)
- [ ] **Demo:** Often no control — verify a baseline planner runs on the same stream and the UI shows "optimized vs baseline" deltas (Pitfall 8)
- [ ] **Override:** Often missing the system-recommendation snapshot in the audit event (spec §16.3)
- [ ] **Map:** Often leaks — verify memory is flat over a multi-minute run (OL disposal done on teardown)
- [ ] **Sim clock:** Often mixes wall-clock and sim-clock — verify all interpolation/timestamps use the sim clock, not `Date.now()`

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Inverted LIFO mapping (P1) | MEDIUM | Fix the one comparator/invariant; golden fixtures localize it fast *if* they exist — otherwise HIGH (every downstream plan/score suspect) |
| Feasibility folded into score (P2) | MEDIUM | Split validation into feasibility gate + soft score; re-run plans through the gate |
| Nondeterministic replay (P3) | HIGH | Hunt every ambient-nondeterminism source (time/random/sort) in handlers; retrofitting purity into reducers is invasive — cheap only if enforced from Phase 1 |
| Missing optimistic concurrency (P4) | MEDIUM | Add version column + unique constraint + retry-on-conflict; backfill versions from sequence |
| Double-counted observations (P5) | LOW–MEDIUM | Add last-seq idempotency + RFID windowing; recompute affected projections by replay |
| RFID-as-truth (P6) | MEDIUM | Re-architect into planned vs observed layers; thresholded exceptions |
| Plan thrashing (P7) | LOW–MEDIUM | Add freeze enforcement + churn penalty + deterministic tie-break |
| No baseline (P8) | LOW | Add a strawman planner running on the same stream; mostly UI/wiring |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| P3 Non-deterministic replay | Phase 1 (Operational Foundation) | CI test: live projection == rebuilt-from-store projection |
| P4 Missing optimistic concurrency | Phase 1 | Unique `(aggregate_id, version)` constraint; concurrent-append test fails cleanly |
| P5a Non-idempotent projections | Phase 1 | Re-applying an event is a no-op; restart doesn't inflate counts |
| P11 Event schema versioning | Phase 1 | `eventType` + `schemaVersion` discriminator; upcaster test for an evolved payload |
| P1 Inverted LIFO mapping | Phase 2 (Load Planner) | Golden fixtures flag a reversed plan; independent validator |
| P2 Feasibility folded into score | Phase 2 | `maxAllowedBlockers` is a hard reject; rehandle stays separate from feasibility |
| P8 No baseline (design) | Phase 2 → carried to Phase 4 | Baseline planner exists and beats-it deltas reported |
| P6 RFID-as-truth | Phase 3 (RFID Validation) | Missing read ≠ missing package; confidence-thresholded alerts; false-positive rate KPI |
| P5b Double-counted RFID | Phase 3 | Observation windowing; confidence capped, can't asymptote to 1.0 from repetition |
| P7 Plan thrashing / non-idempotent replan | Phase 4 (Rolling Optimizer) | Freeze window holds; identical input → identical plan; churn penalty present |
| P9 Solver runtime blowup / graph explosion | Phase 4 | Solver-runtime KPI under threshold; scope-detection limits decision set |
| P12 Min-cost flow numerical issues | Phase 4 | Integer-scaled costs; results match hand-computed small cases |
| P8 No baseline (delivery) | Sim/Viz wrapper | UI shows "optimized vs baseline"; seed-frozen reproducible scenarios |
| P10 Map perf/leaks | Sim/Viz wrapper | Flat memory over multi-minute run; in-place geometry updates; rAF-batched |

> **Phases needing deeper phase-specific research before building:** Phase 4 (which JS/TS min-cost-flow + VRP approach: pure-JS vs OR-Tools-WASM vs child-process bridge — verified that maintained native Node bindings do not exist) and the Sim/Viz wrapper (OpenLayers high-trailer-count rendering strategy + smooth interpolation). Phases 1–3 follow well-established event-sourcing and rule-based-fusion patterns and are lower research risk.

---

## Additional Critical Pitfalls (referenced above)

### Pitfall 9: Solver runtime blowup / time-expanded graph explosion
**What:** Min-cost flow (§11.3) and VRP (§11.4) over a fine-grained time-expanded graph (§11.2) explode combinatorially; replan misses the freeze-window deadline. **Avoid:** coarse 15-min time nodes, aggressive scope pruning (§11.9), keep demo network small (§23 pilot scale). **Sign:** solver-runtime KPI (§21.2) climbing each epoch. **Phase:** 4.

### Pitfall 10: Realtime map perf / OpenLayers memory leaks
**What:** Too many features/animations, re-render storms, and documented OL leaks on layer/source churn (verified: OL issues #8141/#10437/#7954); trailers that teleport instead of interpolating. **Avoid:** in-place geometry mutation, rAF batching, WebGL points layer, strict disposal on teardown, sim-clock-driven interpolation. **Sign:** growing memory, dropped frames. **Phase:** Sim/Viz wrapper.

### Pitfall 11: Event schema versioning ignored
**What:** As event types are added/changed (the spec lists ~25 event types, §9.2), old stored events no longer deserialize or replay differently. **Avoid:** discriminated-union event types with explicit `schemaVersion`; upcasters that transform old payloads to current shape on read; never mutate stored events. **Sign:** replay throws on old events; new optional fields read as undefined silently changing projection output. **Phase:** 1 (establish the contract before many event types exist).

### Pitfall 12: Min-cost flow / VRP numerical issues in JS
**What:** JS `number` is float64; mixing float costs into integer-capacity flow algorithms causes rounding that silently flips the optimal assignment, and immature JS solver libs return wrong answers without erroring. **Avoid:** scale all costs to integers (cents/seconds), keep capacities integer, validate the solver against hand-computed small instances, prefer a library with a test suite or wrap OR-Tools-WASM. **Sign:** optimal plan changes under tiny cost perturbations; assignments that violate obvious cost ordering. **Phase:** 4.

---

## Sources

- OpenLayers performance & memory-leak issues — verified: [DeepWiki: OL Performance & Optimization](https://deepwiki.com/openlayers/openlayers/8.1-performance-and-optimization), [OL #8141 add/remove layer leak](https://github.com/openlayers/openlayers/issues/8141), [OL #10437 vector layer leak](https://github.com/openlayers/openlayers/issues/10437), [OL #7954 image render leak](https://github.com/openlayers/openlayers/issues/7954) (HIGH)
- OR-Tools Node.js binding immaturity — verified: [mapbox/node-or-tools (Node 4/6 only)](https://github.com/mapbox/node-or-tools), [min-cost-flow npm (pure JS)](https://www.npmjs.com/package/min-cost-flow), [OR-Tools min-cost-flow (no JS API)](https://developers.google.com/optimization/flow/mincostflow), [OR-Tools→WASM](https://dev.to/pavkode/compiling-google-or-tools-to-webassembly-simplifies-browser-based-optimization-solvers-60k) (HIGH)
- Event sourcing concurrency/replay/projection mechanics — verified: [Production event store in PostgreSQL](https://dev.to/tim_derzhavets/building-a-production-ready-event-store-in-postgresql-schema-design-projections-and-replay-25o8), [Marten optimistic concurrency](https://martendb.io/documents/concurrency), [eugene-khyst/postgresql-event-sourcing](https://github.com/eugene-khyst/postgresql-event-sourcing) (HIGH)
- Domain-logic pitfalls (LIFO mapping, blockers, feasibility gate, freeze windows, baseline, sensor fusion) — derived from the project tech spec §7, §8, §11, §12, §22, §23 cross-referenced with event-sourcing community practice (MEDIUM-HIGH)

---
*Pitfalls research for: event-sourced middle-mile trailer optimization (TS/Node + Postgres + OpenLayers), simulation-driven MVP*
*Researched: 2026-06-18*
