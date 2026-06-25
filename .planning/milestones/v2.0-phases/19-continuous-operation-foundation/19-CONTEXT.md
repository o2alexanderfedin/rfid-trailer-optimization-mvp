# Phase 19: Continuous Operation Foundation - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (decisions resolved in v2.0 research; design second-opinion via Google AI Mode consult)

<domain>
## Phase Boundary

The simulation runs **open-ended** across multiple day/cycle periods with **bounded memory** and **proven long-run determinism**. This is the foundation phase — no new domain events, no induction/outbound/bidirectional behavior yet. It is a control-flow + infrastructure change to the existing `@mm/simulation` engine, `@mm/api` sim-driver/projection catch-up + ws layer, and `@mm/optimizer` idempotency map.

**In scope (requirements):** CONT-01, CONT-02, CONT-03, CONT-04, CONT-05 (P2), DET-01, DET-02.

**Explicitly NOT in this phase:** `PackageInducted`/`PackageDelivered` events (Phases 20/22), `pendingAtSpoke`/consolidation (Phase 21). This phase only registers the bidirectional routes at bootstrap as a *prerequisite* (no freight flows on them yet).
</domain>

<decisions>
## Implementation Decisions

### Resolved (from v2.0 research SUMMARY.md — locked)
- **Open-ended loop is a control-flow change, not an architecture change.** Replace the `if (action.fireTick > durationTicks) break` hard ceiling in `generate()` with a `stopped`/`runUntilStopped` opt-in. The existing `durationTicks` path stays **unchanged** so every existing golden is byte-identical.
- **Streaming emit.** Convert `generate()`'s `out: SimulatedEvent[]` accumulation to an `onEvent` callback for the live-run path; keep the array-collecting `simulate()` wrapper for golden tests (already partially present as `runSimulation()`).
- **Determinism keystone (DET-01/02).** Every v2.0 feature opt-in; flags-off ⇒ byte-identical existing seed-42 golden. New RNG salts are introduced in later phases, but the **salt-collision assertion test** discipline is established here. A **10,000-tick** seeded golden hash test (`simulate({ seed: 42, durationTicks: 10000 })`) must pass and be cross-architecture stable (x86 + ARM). If it diverges, replace the log-normal sampler with an integer lookup table.
- **Bounded memory (CONT-04).** Three mechanisms, all Phase-19:
  1. **Projection watermark checkpoint** — `projection_checkpoints` Postgres table; catch-up (`runCatchup`) resumes from the last applied global seq instead of replaying from 0, so rebuild cost does not grow with log size.
  2. **WS backpressure** — guard the ws send path on `socket.bufferedAmount` (skip/coalesce ticks above a threshold, e.g. 256 KB) so a backgrounded client buffer stays bounded.
  3. **Optimizer idempotency LRU** — bound the in-memory `(epoch, scopeHash)` map with LRU eviction (cap ~500) so it cannot grow without bound over an indefinite run. (Postgres-persistent idempotency is Phase 21.)
- **Bidirectional route registration at bootstrap** — `buildRoutes()` emits `RouteRegistered` for BOTH directions (reverse geometry = existing polyline coordinates reversed, no new ORS call). No freight flows spoke→center yet; this only makes the routes exist for Phase 21.

### Claude's discretion (implementation-level)
- Exact stop-signal shape (`runUntilStopped: boolean` option + an external `stop()` handle vs an injected `shouldStop()` predicate) — choose the simplest that preserves determinism and testability (DIP).
- Sort-wave cadence shape for CONT-05 (P2) — a deterministic schedule (e.g. burst windows per cycle period) seeded from the existing stream; must be flag/config-gated and must not perturb goldens when disabled.
- `sim-day` / cycle counter representation in the ws state diff + UI placement (CONT-03) — follow the existing ws envelope + React panel conventions.
- Watermark checkpoint cadence (every N events / every tick-batch) — pick a value that keeps rebuild bounded without excessive writes.

### Keystone gates (every plan/impl MUST satisfy)
- `pnpm build` (turbo) · `pnpm typecheck` (separate gate — catches test-file TS errors) · `pnpm lint` · `pnpm test:all` (unit+integration+ui) all green.
- Existing seed-42 golden **byte-identical** with all v2.0 flags off (regression).
- New 10k-tick determinism golden passes.
</decisions>

<code_context>
## Existing Code Insights (from research — verify during plan-phase)

- `packages/simulation/src/engine.ts` (~1,267 LOC) — `EventQueue` (single-threaded sequential `schedule()`/drain), `generate()` with the `fireTick > durationTicks` stop condition, 6 seeded substream salts + existing salt-collision assertion test, `pendingBySpoke` manifest map, `simulate()`/`runSimulation()` wrappers. **The `EventQueue` sequential discipline must be preserved** — new event sources must schedule into the queue, never append externally (determinism).
- `packages/simulation/src/rng.ts` — mulberry32 + splitmix32, `makeRng()`, XOR-salt sub-seeding. **Do NOT swap the RNG library** (invalidates 960+ goldens).
- `packages/simulation/src/routes.ts` — `buildRoutes()` emits `RouteRegistered`; reverse-geometry registration lands here.
- `packages/api/src/sim/driver.ts` — per-tick loop, `runCatchup`, `readAll(db, 0n)` (the full-from-0 rebuild that the watermark checkpoint fixes).
- `packages/api/src/ws/snapshots.ts` — `diffTick`, `buildSnapshot`, ws send path (backpressure guard goes here; `buildSnapshot` must read from projection tables, not raw log).
- `packages/optimizer/src/rolling/freeze-idempotency.ts` + the rolling service — in-memory `(epoch, scopeHash)` idempotency map (LRU cap here).
- Gate commands: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all`, `pnpm check` (all four). Determinism golden fixtures live in the simulation/projections packages.
- Pre-existing tech debt this phase touches (from v1.0 audit): in-memory idempotency (no restart durability — LRU here, persistence Phase 21), `readAll` from seq=0 (watermark here), detection cost scales with state (mitigated Phase 21 via active-package filter).
</code_context>

<specifics>
## Specific Ideas

- Make the open-ended loop drive off a wall-clock-independent tick cadence (the paced-loop accumulator already exists post-SP1) so "continuous" is purely virtual-time; the existing pacer handles an infinite tick stream without modification.
- The 10k-tick determinism golden should hash the full ordered event stream (stable serialization) and assert equality against a committed fixture; run it in CI on both architectures (or document the cross-arch check if CI is single-arch).
- `sim-day` counter: derive from `occurredAt` virtual clock (never wall-clock) so it is replay-stable.
- CONT-05 (P2) sort-wave: gate behind a config flag; when off, departures keep the current cadence and goldens are unchanged.
</specifics>

<deferred>
## Deferred Ideas

- Postgres event-log snapshotting/partitioning/compaction — NOT needed at demo scale (hours, not days); deferred to production hardening (HRD-FUT-01).
- Persistent optimizer idempotency table — Phase 21 (FLOW-04).
- Detection `is_active` scoping benchmark — Phase 21.
- CONT-FUT-01 pacer safety valve for sustained high-speed runs — future milestone.
</deferred>

<google_consult>
## Google AI Mode Consultation (2026-06-24, udm=50, reached successfully)

Second opinion on (1) finite→continuous DES determinism, (2) bounded projection memory, (3) seeded-RNG sub-streaming. **Net-new items folded into this phase's gates/checks:**

1. **Watermark + replay-from-0 beats snapshotting ("toxic snapshots").** Confirms our plan: we do NOT snapshot in v2.0. Watermark/checkpoint stores only `last_processed_event_id` and preserves golden replay perfectly; snapshots become invalid after any reducer-logic change. → CONT-04 implements the watermark checkpoint only; if any cache is added it must be a disposable code-version-keyed cache.
2. **Same-timestamp tie-break must be deterministic.** When new event sources schedule at the same tick, ordering must use a stable secondary key (sequence id / event-type priority), never Map/Set iteration or insertion/async order. → **Plan-phase MUST verify the `EventQueue` already has a deterministic same-tick tie-break** and that any new scheduling preserves it. (Critical determinism check.)
3. **Decouple diagnostics/logging from outcome** so toggling can't change the bitwise result — directly supports DET-01 "flag off ⇒ byte-identical."
4. **Audit unbounded monotonic counters** for overflow over indefinite runs (tick counter, seq, entity ids). JS numbers are safe to 2^53 (fine at demo scale) — note + assert, don't over-engineer.
5. **Unbounded lifetime accumulators → sliding-window / Welford running stats** to keep memory constant (any KPI/metric that accumulates over the whole run).
6. **Hashed sub-seeds decorrelate better than XOR salts** — but we must NOT change the existing RNG (breaks 960+ goldens). Mitigation: derive NEW salts (Phases 20/22) to be well-separated, keep the pairwise-distinct assertion, and ensure new-stream spawn order is **deterministic-ID-sorted**, not insertion-ordered.
7. **Epoch-rolling** is a fallback only if FP time sneaks in — we're integer-tick, so low risk (no action now).
</google_consult>
