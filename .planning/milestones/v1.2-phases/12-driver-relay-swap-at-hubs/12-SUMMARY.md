# Phase 12 Summary: Driver relay / swap at hubs

**Requirements delivered:** DRV-04, SIM-HOS-04
**Branch:** `feature/phase-12-driver-relay-swap-at-hubs` (not merged, not pushed)

## What shipped

A per-hub **driver pool** and a deterministic **relay/swap-at-hub** layered onto
the Phase-11 HOS simulation. When a trailer's assigned driver cannot legally
complete its next leg, the engine hands the trailer to a fresh legal driver from
the hub pool so freight keeps moving; the tired driver enters rest and re-enters
the pool after its 10h reset. Active ONLY when `hosEnabled` is true.

### DRV-04 — per-hub driver pool
- At bootstrap (HOS-on), the center dispatch hub seeds a roster of **15 drivers**:
  9 primary (one bound per trailer, ids `D001…D009`) + `RELAY_SPARE_DRIVERS = 6`
  spares (`D010…D015`), each `DriverRegistered` with a fresh HOS clock and rostered
  at the center. Pool size is a pure function of the network (no RNG) ⇒ byte-stable.
- Per-driver availability is tracked by `availableAtMinByDriver` (the virtual-clock
  minute a driver is free again — in-flight or resting drivers are `> now`); the
  spare pool is an ordered list scanned in stable registration order.

### SIM-HOS-04 — relay / swap at hubs
- New `selectDriverForLeg(trailerId, tripId, legMinutes, departIso)` runs at each
  dispatch (`departTrailer`): it draws the leg transit first, then uses the
  Phase-10 engine (`remainingLegalDriveMinutes` / `mayDriveNow`) to decide whether
  the bound driver can complete the whole leg.
  - **Can complete →** keep the bound driver (no swap).
  - **Cannot, and a fresh spare would drive strictly more of the leg →** RELAY:
    emit `DriverSwappedAtHub`, rebind the trailer to the fresh driver (clock
    re-anchored to the dispatch instant = full legal budget), emit
    `DriverDutyStateChanged(resting, "relay-handoff")` for the tired driver (a 10h
    reset; it re-enters the spare pool when legal again), then emit
    `DriverAssignedToTrip` + `DriverDutyStateChanged(driving)` for the fresh driver.
    The trailer departs ON TIME.
  - **Pool exhausted →** fall back to the Phase-11 mid-leg park (`accrueDrivingLeg`).

### Observed behaviour (seed 1234, 6000 ticks, default HosConfig)
- 25 `DriverSwappedAtHub` relays fire; 25 `relay-handoff` rests + 37 mid-leg
  `10h-reset` parks (pool-exhausted fallback). Round-trips completed rose from 24
  → 26 arrivals vs the pure-park Phase-11 stream — relay keeps freight moving.

## Determinism (the keystone)
- **HOS-off byte-identical:** `determinism.unit` + `rfid-determinism.unit` pass
  UNCHANGED (not edited). All relay code is gated by `hosOn`; HOS-off makes ZERO
  new draws/events. The transit draw was moved earlier in `departTrailer` but no
  other timing draw is interleaved there, so the timing-substream draw order is
  unchanged for both modes.
- **HOS-on golden regenerated + green:** same seed + same `HosConfig` ⇒
  byte-identical; different seed differs. The one Phase-11 driver-count assertion
  (9) was updated to the pool size (15); every other HOS-on assertion holds.
- No `Date.now()`; spare selection is a stable scan (no RNG); the only `hosRng`
  draws remain the pre-existing rest/break jitter, in event-queue order.

## Files changed
- `packages/simulation/src/engine.ts` — pool seeding, `availableAtMinByDriver` +
  `sparePool` state, `selectDriverForLeg` relay helper, `departTrailer` rewired to
  select-then-assign; new domain imports + `RELAY_SPARE_DRIVERS` constant.
- `packages/simulation/test/relay-swap.unit.test.ts` — NEW (15 tests: DRV-04 pool,
  SIM-HOS-04 relay, determinism).
- `packages/simulation/test/hos-determinism.unit.test.ts` — updated the driver-count
  golden assertion (9 → 15) to reflect the pool.

## Gate
`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all` — all green (see
12-VERIFICATION.md for exact numbers). No domain/projection/optimizer changes were
needed: `DriverSwappedAtHub` was already in the closed union and handled (no-op) by
every exhaustive switch.
