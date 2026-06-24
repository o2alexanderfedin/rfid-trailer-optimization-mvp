# Stack Research — Milestone v2.0 "Complete Simulation Model"

**Domain:** Continuous / bidirectional discrete-event logistics simulation
**Researched:** 2026-06-23
**Confidence:** HIGH on "no new runtime deps needed"; HIGH on RNG pattern; MEDIUM on Postgres snapshot strategy (standard pattern, details depend on projection query shapes)

---

## Headline

**v2.0 also needs essentially no new runtime dependencies.** All four gaps (continuous run, external induction, outbound delivery, bidirectional freight) are solvable by extending the existing custom engine code — not by adding frameworks or libraries. The stack choice risks are algorithmic, not ecosystem: picking the wrong RNG sub-seeding strategy or the wrong memory-management model will break determinism or cause heap bloat over a long run.

---

## Existing capabilities that cover v2.0 (DO NOT re-add or replace)

Before recommending anything new, establish what already covers these requirements:

| Need | Existing asset |
|------|----------------|
| Open-ended event loop | The `EventQueue` + `generate()` loop already runs until `queue.pop()` returns `undefined`. The `durationTicks` hard ceiling is the only reason it stops. Remove/relax that ceiling and the engine runs indefinitely. |
| Per-feature opt-in flags | `hosEnabled`, `fuel.enabled`, `overCarry`, `rfid` — each adds draws from its own dedicated XOR-salted substream without perturbing others. CONT/IND/OUT/FLOW features follow the same pattern. |
| Independent seeded substreams | `makeRng((seed ^ SALT) >>> 0)` — the mulberry32+splitmix32 engine already supports unlimited independent substreams via distinct salts. Adding two more (induction, outbound) costs two salt constants and nothing else. |
| Domaintime from VirtualClock | `VirtualClock` advances by tick delta — there is no wall-clock anywhere. Open-ended runs get tick counters beyond 120 with zero code change. |
| Event store | Postgres append-only table with per-stream optimistic concurrency. Already handles unbounded stream growth — a continuous run just appends more rows. |
| Projection state | Projections already use upsert semantics (replace current state, not accumulate history). A continuous run does not grow projection tables — the projections reflect current network state, not per-event accumulation. |
| Bidirectional routing skeleton | Over-carry already emits `TrailerDeparted { fromHubId: spoke, toHubId: center }` — the event type and projection hooks for a spoke→center leg already exist. Spoke→center consolidation is a generalization of this. |

---

## v2.0 Additions

### No new libraries are required

None of the four target features require a new npm dependency. Every technique below is pure custom TypeScript extending the existing engine. The reasons are:

1. **No DES framework** — the custom engine is simpler, deterministic, and event-sourced. Any DES library (SimScript, SIM.js, simmer, des.js) uses a coroutine/async model that fights both the synchronous event queue and the golden-replay contract. They are also stale (last maintained 2021–2022). Do not adopt them.
2. **No actor library** — Akka-style actors, NActors, @deepkit/framework are complexity for a single-process demo that gains nothing from actor isolation.
3. **No Kafka / Redis / BullMQ** — continuous operation does not require durable queues. The sim loop is in-process; the event store is the durability layer. Adding a broker for a single-process demo is premature infrastructure.
4. **No external event scheduler** — Node's `setInterval` / `setTimeout` is unnecessary; the VirtualClock + EventQueue model is strictly superior (it does not depend on wall-clock timing and is fully reproducible).

---

## Technique Reference by Feature

### A. Continuous / Open-Ended Operation (CONT-*)

**Pattern: run-until-stopped, not run-until-tick**

The current `generate()` loop exits at two conditions:
1. `queue.pop()` returns `undefined` (queue drained — not the normal exit for open-ended).
2. `action.fireTick > durationTicks` (the hard tick ceiling — this is what must change).

For continuous operation, replace the hard tick ceiling with a **stop signal** — a shared boolean `let stopped = false` set by the caller (e.g. on `SIGTERM`, on a UI "stop" button, or after a configured demo duration). The loop becomes:

```
for (;;) {
  const action = queue.pop();
  if (action === undefined || stopped) break;
  // advance clock and run
}
```

This is a ~3-line change to the `generate` core, gated behind a new `runUntilStopped` option so the existing `durationTicks` path stays unchanged for golden tests.

**Warm-up / steady-state distinction (DES theory vs. this sim)**

Academic DES steady-state analysis uses a warm-up period to discard initialization-biased output statistics (Welch's method, MSER-5, etc.). That is relevant when collecting performance metrics from a model with empty-start bias (e.g., a queue simulator that starts empty).

This sim does NOT need warm-up analysis because:
- The demo visualizes the running state (it is not a statistical estimator).
- "Initialization bias" in a logistics network means the initial ticks have unusually empty trailers — which is fine for a live demo and is actually realistic for a network launch.
- The optimizer re-plans continuously, so any suboptimal initial state self-corrects within a few epochs.

If a future "metrics collection" mode is added that needs unbiased steady-state KPIs, a configurable warm-up tick count (skip first N ticks from KPI aggregation) is sufficient and trivial to add without affecting the event stream.

**Bounded memory over a long run**

The critical risk for open-ended operation is unbounded in-memory growth. Three sources:

| Source | Risk | Fix |
|--------|------|-----|
| `out: SimulatedEvent[]` in `generate()` | Grows forever for a long run | Switch to a streaming/callback model: `runSimulation` already uses a `sink` callback; extend `generate` to call a `onEvent` callback instead of accumulating in `out[]`. Golden tests call `simulate()` which still collects into an array (bounded by `durationTicks`). |
| `EventQueue.items[]` | Bounded by scheduled-ahead horizon (trailers + packages only schedule O(1) future events each) | No action needed. At any point in steady state the queue holds ≤ 2 × fleet × spokes items. Does not grow with run duration. |
| `pendingBySpoke: Map<string, string[]>` | Accumulates package IDs until a trailer departs | Bounded by the inter-departure interval and package-creation rate. If induction adds external arrivals, the per-hub pending queues could grow if trailers cannot keep up — the optimizer is the throttle. Monitor but do not pre-optimize. |
| Postgres `events` table | Grows forever (by design — append-only) | See Postgres strategy below. |
| Projection tables | Fixed-size (hub × trailer × package state) | Projections are upsert-replace, not accumulate. `packages` projection entries can be archived/pruned after `PackageDelivered` fires. |
| `odometerByTrailer`, `clockByDriver`, etc. per-trailer maps | Bounded by fleet size | No action. |

**Postgres event log growth — strategy for a demo**

For a continuous demo run (hours, not months), the event table will grow to tens of thousands of rows. This is not a problem for Postgres at this scale — 32 million rows is routine for PG. No partitioning or compaction is needed for a demo run.

If the system is deployed for extended periods (days+), two options exist:

1. **Snapshot + truncate (aggregate-level)**: Periodically write the current projection state as a snapshot row, then delete events older than the snapshot horizon for streams that are "closed" (delivered packages, completed trips). This is the standard event-sourcing snapshot pattern. Implementation: a `snapshots` table (`stream_id TEXT PRIMARY KEY, version BIGINT, state JSONB, created_at TIMESTAMPTZ`); on replay, load snapshot first, then only events with `global_seq > snapshot.version`. For the demo MVP, this is deferred — trigger it only when replay latency becomes noticeable.

2. **Time-based partition + drop**: Partition `events` by month using `PARTITION BY RANGE (occurred_at)`. Drop the oldest partition to reclaim space. This is simpler than per-stream compaction but loses the ability to replay historical events. For a demo system where history is not audited, this is acceptable and requires no application code change.

For v2.0, **do not implement either**. The demo runs for hours, not days. Revisit in a "production hardening" milestone if warranted.

**Golden-replay compatibility**

Open-ended operation must not break the existing golden tests. The approach:
- `durationTicks` path unchanged — golden tests pass `durationTicks: 120` and get the existing stream.
- New `runUntilStopped: true` path calls the same `generate` core but with the stopping condition replaced.
- The two paths share all RNG state initialization — so the first N events of a `runUntilStopped` run are byte-identical to the `durationTicks: N` golden.

---

### B. External Freight Induction (IND-*)

**Pattern: Poisson arrival process, per-hub, seeded substream**

External induction adds freight that originates at spoke hubs (not center-created), modeling real middle-mile: shipper tenders parcels at a regional facility.

The generator extension:
- Add `inductionEnabled?: boolean` and `inductionRate?: number` (packages per 15-tick interval per hub) to `SimulateOptions`.
- When enabled, schedule a `createInductionBatch(hubId, tick)` event for each spoke at tick 0, mirroring `createPackageBatch`.
- The induction batch draws from a DEDICATED seeded substream (`seed ^ IND_RNG_SALT`) so induction draws never perturb the primary `rng`, RFID, over-carry, timing, HOS, or fuel substreams.
- Induction packages have their `originHubId` set to the spoke, not the center. Their destination is drawn from the OTHER hubs (including center or other spokes for bidirectional modeling — see FLOW-* below).
- `PackageCreated` and inbound `PackageScanned` events are emitted on the `package-${id}` stream, exactly as center-created packages. No new event types needed.

**Salt assignment**

The engine already has 6 salts (RFID, OVER_CARRY, TIMING, HOS, FUEL). Two new ones are needed:

```typescript
export const IND_RNG_SALT  = 0x9f_2e_a4_c8; // induction arrival draws
export const OUT_RNG_SALT  = 0x7b_1c_d3_f6; // outbound delivery timing draws
```

These must be tested for pairwise distinctness against all 6 existing salts in the salt-collision assertion test (already in the codebase).

**No library needed.** The Poisson arrival model (draw from exponential inter-arrival, or approximate with a fixed interval + Bernoulli thinning) uses the existing `rng.next()` and `rng.int()` methods. A negative-exponential inter-arrival time `Math.ceil(-Math.log(1 - rng.next()) * meanTicks)` is a 1-liner from `inductionRng`.

---

### C. Outbound / Last-Mile Delivery Handoff (OUT-*)

**Pattern: terminal event after arrival at destination, seeded dwell, new domain event**

Outbound delivery is the terminal handoff from a destination hub to a last-mile carrier — a "delivered out" event that closes the freight's lifecycle. It is NOT last-mile vehicle routing (explicitly out of scope).

Implementation:
- After `PackageArrivedAtHub` at a destination spoke, schedule a `PackageDeliveredOut` domain event after a seeded outbound-dwell draw (`outboundRng.int(maxOutboundTicks) + minOutboundTicks`). This models the time freight sits at the spoke dock before a last-mile pickup.
- `PackageDeliveredOut` fires on the `package-${id}` stream. New event type; add to the domain schema in `@mm/domain`.
- The projection for "packages at hub" removes the package from inventory on this event (currently it stays in inventory indefinitely after `PackageArrivedAtHub` — that is the gap).
- The optimizer becomes aware that delivered packages do not contribute to backlog, allowing it to model spoke inventory as transient.
- Gated by `outboundEnabled?: boolean` — off by default, golden-safe.

No library needed. The draw uses `OUT_RNG_SALT` substream.

---

### D. Bidirectional Freight (FLOW-*)

**Pattern: generalize spoke-bound pendingBySpoke to per-directed-leg pending manifest**

Today's freight model is center→spoke only: `pendingBySpoke` maps each spoke to a list of package IDs, and trailers depart center→spoke to drain it. Bidirectional freight requires spoke→center consolidation AND potentially spoke→spoke (via center cross-dock).

The minimal structural change:
- Replace `pendingBySpoke: Map<spokId, string[]>` with `pendingByLeg: Map<legId, string[]>` where `legId = routeId(fromHubId, toHubId)`.
- Package creation (induction or center) picks a destination and queues the package on the leg `routeId(originHubId, destHubId)` or on the first-leg of a multi-hop path.
- Trailer departure drains its directed leg's manifest.
- A trailer returning spoke→center (the "empty return" today) becomes a freight-carrying consolidation run when `pendingByLeg.get(routeId(spoke, center))` is non-empty.

This is a pure data-structure rename + extension, not an algorithmic change. The over-carry code already handles a `TrailerDeparted { fromHubId: spoke, toHubId: center }` event — spoke→center trips already work structurally.

**Multi-hop routing for packages with non-adjacent origin/destination**

In the existing hub-and-spoke topology (1 center + N spokes, no direct spoke-spoke routes), a spoke-originated package destined for another spoke must route via center: spoke-A → center → spoke-B. This is a 2-hop path.

The existing time-expanded graph (hand-rolled, no graphology in production) already supports multi-hop. The package's `destHubId` is the final destination; the optimizer assigns it to a first-leg trailer based on the current time-expanded graph state. No new routing logic is needed for the hub-and-spoke topology — the optimizer's min-cost-flow assignment naturally handles multi-leg paths via the time-expanded graph.

For the simulation engine (not the optimizer), the simple approach is: when a spoke-originated package's destination is another spoke, queue it on `leg(spoke-A → center)`. When it arrives at center, re-queue it on `leg(center → spoke-B)` via an in-engine transfer callback. This mirrors how real cross-dock works (scan inbound at center, re-manifest outbound).

No library needed. The per-directed-leg pending map is a `Map<string, string[]>` extension of existing code.

---

## RNG Strategy — Extended Sub-seeding

### Current architecture (already correct)

The existing `makeRng(seed)` uses **mulberry32** (fast 32-bit, single-state, deterministic per seed) seeded through a **splitmix32 finalizer** (mixes adjacent seeds apart). Each independent feature has its own instance via `makeRng((seed ^ SALT) >>> 0)`.

This XOR-salt sub-seeding pattern is the correct approach for this engine. It provides:
- **Zero cross-stream interference**: enabling induction never perturbs timing, HOS, RFID, etc.
- **Reproducibility**: same seed + same salts = byte-identical streams forever.
- **No external dependency**: the entire RNG system is ~35 lines of custom TS already in `rng.ts`.

### What NOT to adopt for RNG

**ts-seedrandom 1.5.0** (npm, modified 2026-06-17) — supports SplitMix64 and many algorithms, ESM-only (`./dist/index.mjs`). Do NOT adopt. Reasons:
- The existing mulberry32+splitmix32 is already proven byte-stable across 960+ tests and the golden suite. Replacing it would invalidate all golden baselines and require re-generating them.
- ts-seedrandom is a third-party dep with its own version lifecycle — a dep that can break the golden contract is a liability.
- SplitMix64 (64-bit) produces values incompatible with the existing 32-bit stream even if the seed is the same — the golden would change.

**seedrandom 3.0.5** (npm, modified 2022) — stale. The existing mulberry32 is faster and better understood.

**Counter-based RNG (PCG, Philox, xoshiro256)** — these are the academically preferred approach for parallel streams (each stream gets a different "stream ID" or "increment" parameter). They would eliminate the XOR-salt pattern entirely in favor of `new PCG(seed, streamId)`. However:
- Migrating would invalidate all existing golden baselines.
- The XOR-salt pattern already achieves the same goal (independent parallel streams from a single seed) with zero correlation risk at this simulation scale.
- No JS/TS PCG library with stable guarantees is needed — custom 200-line implementation would be required and is not worth the golden migration cost.

**Recommendation: extend the XOR-salt pattern for new features.** Add `IND_RNG_SALT` and `OUT_RNG_SALT` as new constants. Assert pairwise distinctness in the existing salt-collision test. No new library.

---

## What NOT to Add — Definitive List

| Technology | Why NOT | What to do instead |
|------------|---------|-------------------|
| Any DES framework (SimScript, SIM.js, simmer, des.js, simjs) | Stale (2021–2022); coroutine model fights synchronous event queue; incompatible with golden-replay determinism | Extend existing `EventQueue` + `generate()` |
| Kafka / Redpanda / NATS | Single-process demo; no cross-service messaging needed; adds infra complexity for zero demo value | In-process `sink` callback + Postgres event log |
| BullMQ + Redis | No durable retry or parallel worker need for the demo | In-process rolling optimizer loop (already exists) |
| Actor libraries (Akka-style, NActors) | Concurrency model incompatible with deterministic single-threaded event queue | Custom EventQueue with sequential dispatch |
| PCG / xoshiro RNG library | Would invalidate golden baselines; XOR-salt pattern already achieves parallel independent streams | Add two salt constants to the existing rng.ts |
| ts-seedrandom / seedrandom | ESM-only, stale, or would invalidate golden baselines; existing custom mulberry32 is proven | Keep makeRng() as-is |
| pg_partman Postgres extension | Not needed for a demo run (hours); premature infra for the scale of this sim | Defer; use DELETE WHERE on closed-package streams if needed |
| EventStoreDB | Second datastore; unnecessary when Postgres covers the event-log requirement | Existing Postgres event table |
| Node `setInterval` / `setTimeout` for sim pacing | Wall-clock pacing is non-deterministic; it already lives in the API paced-loop layer (not the engine) | Keep VirtualClock + EventQueue; pacing lives outside generate() |
| Circular/ring buffer npm packages | The in-flight event queue is bounded by fleet size (O(1) entries per trailer), not by run duration | No action; the EventQueue is already effectively bounded |

---

## Integration Points into Existing Engine

| Change | Where | Size |
|--------|-------|------|
| `runUntilStopped` option + stop-signal loop | `packages/simulation/src/engine.ts` — `generate()` loop exit condition | ~10 LOC |
| Stream-based event emission (callback, not `out[]`) | `packages/simulation/src/engine.ts` — `emit()` function + `generate()` return type | ~15 LOC; `simulate()` wrapper collects into array for golden tests |
| `inductionEnabled` + `IND_RNG_SALT` substream + `createInductionBatch` | `packages/simulation/src/engine.ts` | ~40 LOC + 1 salt constant |
| `OUT_RNG_SALT` + `outboundEnabled` + `scheduleDeliveredOut` | `packages/simulation/src/engine.ts` + new domain event in `@mm/domain` | ~30 LOC |
| `pendingByLeg` map (replaces `pendingBySpoke`) + bidirectional manifest logic | `packages/simulation/src/engine.ts` | ~50 LOC refactor |
| `PackageDeliveredOut` domain event type + schema | `packages/domain/src/events.ts` | ~15 LOC |
| Projection: remove package from hub inventory on `PackageDeliveredOut` | projection handler in `packages/event-store` or API layer | ~10 LOC |
| New salt constants + salt-collision assertion | `packages/simulation/src/engine.ts` + existing salt-collision test | 2 constants + 2 test lines |

**No new packages are installed. No existing dependencies are upgraded.**

---

## Alternatives Considered

| Recommended approach | Alternative considered | Why rejected |
|----------------------|------------------------|--------------|
| Extend `EventQueue` stop condition with a stop-signal boolean | Introduce a wall-clock timeout (`setTimeout` to set `stopped`) | Non-deterministic for golden tests; wall-clock timeout is in the paced-loop layer above generate(), not inside generate() |
| XOR-salt substream extension (IND_RNG_SALT, OUT_RNG_SALT) | Per-entity seeding (seed each package or hub independently) | Per-entity seeding is harder to prove non-colliding and requires a monotonic entity counter at seed time; XOR-salt is simpler and already proven |
| Pending-by-leg map for bidirectional freight | Separate "inbound queue" and "outbound queue" per hub | More state surface, same behavior; leg key already exists via routeId() |
| `PackageDeliveredOut` as a new event type | Reuse `PackageArrivedAtHub` with a `terminal: true` flag | Domain events should be explicit; a flag is a code smell; a distinct event type makes the projection handler clear |
| Defer Postgres snapshot/compaction entirely for v2.0 | Implement snapshot table now as preventive measure | Demo runs hours, not days; premature optimization; adds complexity before there is a measurable performance problem |

---

## Version Compatibility (unchanged from v1.x)

All existing dependencies remain at their pinned versions. No compatibility issues arise from the v2.0 changes because no new runtime dependencies are introduced.

| Package | Version | Status |
|---------|---------|--------|
| TypeScript | 5.9.x | Unchanged |
| Node.js | 22 LTS | Unchanged |
| Fastify | 5.8.x | Unchanged |
| PostgreSQL | 16/17 | Unchanged (event table grows, no schema changes for v2.0 core) |
| Kysely | 0.29.x | Unchanged |
| pg | 8.22.x | Unchanged |
| ws | 8.21.x | Unchanged |
| OpenLayers | 10.9.x | Unchanged |
| React | 19.x | Unchanged |
| Vitest | 4.1.x | Unchanged |

---

## Sources

- Codebase inspection: `packages/simulation/src/engine.ts` (1,267 LOC) — XOR-salt substream pattern, EventQueue, stop condition, generate() architecture. HIGH confidence.
- Codebase inspection: `packages/simulation/src/rng.ts` — mulberry32 + splitmix32 mixer, Rng interface. HIGH confidence.
- https://github.com/jurerotar/ts-seedrandom — `ts-seedrandom` 1.5.0 (2026-06-17, ESM-only). Inspected; not adopted. HIGH confidence on version.
- https://www.npmjs.com/package/seedrandom — seedrandom 3.0.5, modified 2022. Stale; not adopted.
- https://prng.di.unimi.it/ — PRNG shootout reference; confirms mulberry32 / splitmix32 quality class.
- https://gee.cs.oswego.edu/dl/papers/oopsla14.pdf — Fast Splittable PRNGs (SplitMix theory). Confirms XOR-split approach is sound.
- https://domaincentric.net/blog/event-sourcing-snapshotting — Snapshot pattern rationale; confirms "only when replay is slow" guidance.
- https://dev.to/kspeakman/event-storage-in-postgres-4dk2 — PostgreSQL event store; confirms large table is fine without partitioning.
- https://eudl.eu/pdf/10.4108/ICST.SIMUTOOLS2009.5603 — Warm-up in DES; confirms warm-up is a statistical-estimator concern, not a demo-visualization concern.
- DES simulation theory (training knowledge, MEDIUM confidence): steady-state vs. terminating distinction, Welch method, MSER-5 truncation heuristic — verified against above sources.

---

*Stack research for: Middle-Mile Trailer Optimization Platform v2.0 Complete Simulation Model*
*Researched: 2026-06-23*
