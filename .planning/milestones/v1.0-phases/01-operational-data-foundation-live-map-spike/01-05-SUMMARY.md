# Plan 05 — Simulation engine (SIM-01, SIM-02) — Summary

## What was built

`@mm/simulation`: the deterministic, seeded USA hub-network simulator — the sole
data source for every later phase.

- **SIM-01 — network model**
  - `src/network/hubs.ts`: 10 real US metro sort hubs (MEM, ORD, DFW, ATL, LAX,
    JFK, DEN, PHX, SEA, IND) with WGS84 coordinates inside the continental-USA
    envelope (lat ∈ [24,49], lon ∈ [-125,-66]); unique ids/names; Memphis is the
    hub-and-spoke center and the canonical skeleton hub.
  - `src/network/routes.ts`: `greatCircle(a, b, n)` — pure spherical (slerp)
    interpolation returning `n` `[lon,lat]` points anchored exactly at the
    endpoints; `buildRoutes(hubs)` — a connected hub-and-spoke topology (directed
    leg pair center↔spoke per spoke), every hub reachable.

- **SIM-02 — deterministic engine**
  - `src/rng.ts`: `makeRng(seed)` — a seeded `mulberry32` PRNG (with a splitmix32
    seed-mixing step so adjacent seeds decorrelate); `next`/`int`/`pick`. ALL
    randomness flows through it.
  - `src/clock.ts`: `VirtualClock(epochIso, msPerTick)` — domain time decoupled
    from the wall clock; advances only on injected ticks; emits `occurredAt`.
  - `src/engine.ts`: a deterministic tick/event-queue engine with a stable
    `(fireTick, insertionSeq)` ordering. Emits the 8 Phase-1 domain events —
    HubRegistered + RouteRegistered bootstrap, then PackageCreated/Scanned
    (inbound/load/unload)/ArrivedAtHub and TrailerDeparted/ArrivedAtHub/Docked
    along routes. Two surfaces over ONE generation core: the pure
    `simulate(opts): SimulatedEvent[]` (tests/golden replay) and
    `runSimulation(opts)` that sinks events into an injected writer
    (`appendToStream`).

## Determinism (threat T-01-15)

Same seed ⇒ byte-identical event stream (order, payloads, occurredAt) — asserted
by deep-equal AND `JSON.stringify` equality. ZERO `Date.now()` / unseeded
`Math.random()` in source (verified with comments stripped). Every emitted event
passes the domain `validateEvent` boundary.

## Tests (strict TDD: RED → GREEN → REFACTOR)

- `test/network.unit.test.ts` — hubs, great-circle, connected routes, seeded RNG,
  virtual clock.
- `test/determinism.unit.test.ts` — byte-identical same-seed stream; different
  seeds differ; closed-union validation; non-decreasing occurredAt; stream-id ↔
  entity mapping.
- `test/drives-projections.int.test.ts` — runs the simulator into the REAL event
  store + operational projections (Testcontainers Postgres 17 / OrbStack); the
  twin populates and a seeded package/trailer/hub resolves to expected state.
  Persists per-aggregate (append-per-stream) and projects the whole log in one
  read-your-writes transaction.

## Gates

`pnpm install && pnpm -r build && pnpm lint && pnpm test:all` — all green
(15 test files, 101 tests, incl. real Postgres integration). No regressions to
the Phase-1 spine or prior plans (the `@mm/api` seed still imports `MEMPHIS` /
`hubRegisteredEvent` via the back-compat `network.ts` re-export).

## Requirements covered

- SIM-01 ✅ — ~10 real US metro hubs + great-circle hub-and-spoke routes.
- SIM-02 ✅ — seeded, deterministic tick/event-queue engine, virtual clock,
  byte-identical replay, drives projections.

## Integration (merged into feature/phase-1-operational-data-foundation-live-map-spike)

Winner: rival #1, branch `wt/p1-05-r1`, source sha
`6a43a8b189231a9725f96a11cb682a5f058ef390`. Merged via `git merge --no-ff`
(no conflicts — the winner was a linear addition of `packages/simulation` plus
this summary on top of plan-04 HEAD `ef1ecfe`).

Gates re-verified post-merge in the MAIN repo against real Postgres via
Testcontainers on OrbStack (docker available):

| Gate              | Result |
|-------------------|--------|
| `pnpm install`    | OK (lockfile up to date; only pre-existing cyclic-workspace WARN) |
| `pnpm -r build`   | OK (6 buildable packages incl. `@mm/simulation`) |
| `pnpm lint`       | OK (eslint clean) |
| `pnpm test:all`   | OK — 15 files / **101 tests** passed (incl. real Postgres integration) |

## Carried risks (from cross-rival judging — revisit before later phases)

1. **End-to-end DB-projection proof is on a SHORT stream only.** R1's integration
   test deliberately proves drives-projections on a short stream
   (`durationTicks=31`) because the pre-existing `@mm/projections` `applyInline`
   is O(events × table). The large byte-identical stream is proven only by the
   pure unit test, not end-to-end through the DB. (R2 shared the same constraint
   at `TICKS=36`.) When projection volume grows, add an incremental-read path
   before asserting large streams end-to-end through Postgres.
2. **Int-test correctness assertions are looser (non-emptiness / membership).**
   R1's integration oracle checks non-emptiness and membership rather than exact
   projected state per aggregate (R2 asserted exact projected state, giving
   marginally stronger end-to-end proof). A subtle projection mismatch is less
   likely to be caught by R1's int-test suite — tighten to exact-state assertions
   if downstream consumers depend on precise projected values.
3. **Skeleton hub swap MIA → IND.** R1 swapped the skeleton's MIA for IND; both
   are valid continental-USA hubs. No functional risk; noted for traceability if
   any later phase hard-codes the original hub set.
4. **Pre-existing api ↔ event-store cyclic-workspace-dependency pnpm WARN.**
   Present in both rivals and unrelated to this plan. Cosmetic at install time;
   worth resolving when the workspace dep graph is next revisited.
