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
