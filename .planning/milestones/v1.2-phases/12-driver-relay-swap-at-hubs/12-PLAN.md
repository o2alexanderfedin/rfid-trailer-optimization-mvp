# Phase 12 Plan: Driver relay / swap at hubs

**Requirements:** DRV-04, SIM-HOS-04
**Branch:** `feature/phase-12-driver-relay-swap-at-hubs`
**Depends on:** Phase 11 (HOS sim wiring) — extended in place.

## Goal

Add a per-hub **driver pool** and a deterministic **relay/swap-at-hub** to the
HOS-enabled simulation: when a trailer's assigned driver cannot legally complete
the next leg, hand the trailer to a fresh legal driver from the hub pool
(`DriverSwappedAtHub`) so freight keeps moving, while the tired driver enters
rest. Active ONLY when `hosEnabled` is true; HOS-off stays byte-identical.

## Approach (TDD: RED → GREEN → refactor)

All work lands in `packages/simulation/src/engine.ts` (extend Phase-11 wiring) +
one new test file. No domain changes: `DriverSwappedAtHub` is already in the
closed `@mm/domain` union (Phase 9) and already handled (as no-op) by every
exhaustive reducer/optimizer switch, so emitting it breaks nothing.

### Task 1 — RED: write `test/relay-swap.unit.test.ts`
- DRV-04: pool registers MORE drivers than trailers; ids unique; all
  `DriverRegistered` precede the first `DriverAssignedToTrip`.
- SIM-HOS-04: ≥1 `DriverSwappedAtHub`; swap names two distinct drivers + hub +
  trip + trailer; the incoming driver is the one (re)assigned to that trip; the
  outgoing tired driver enters `resting`; the trip still departs.
- Determinism: same seed + `HosConfig` ⇒ byte-identical relay stream; different
  seed differs; HOS-off emits zero swap events; events validate + ordered.

### Task 2 — GREEN: implement the pool + relay in `engine.ts`
1. **DRV-04 pool seeding (bootstrap, HOS-on only):** register the 9 primary
   drivers (one bound per trailer) PLUS `RELAY_SPARE_DRIVERS = 6` spares — all
   rostered at the center dispatch hub, each with a fresh HOS clock. Pool size is
   a pure function of the network (no RNG) ⇒ byte-stable roster. Track
   `availableAtMinByDriver` (virtual-clock minute a driver is free again) and a
   stable `sparePool` ordering.
2. **Relay decision (`selectDriverForLeg`, called from `departTrailer`):** draw
   the leg's transit FIRST, then ask whether the bound driver's
   `remainingLegalDriveMinutes` (Phase-10 engine) covers the whole leg. If yes →
   keep it. If no → scan the spare pool in stable registration order for a FREE
   driver; if a fresh driver would legally drive strictly more of the leg, RELAY:
   emit `DriverSwappedAtHub`, rebind the trailer + re-anchor the fresh driver's
   clock to the dispatch instant, emit `DriverDutyStateChanged(resting,
   "relay-handoff")` for the tired driver (10h reset → re-enters the pool later).
   If the pool is exhausted → fall back to the Phase-11 mid-leg park.
3. Emit `DriverAssignedToTrip` + `DriverDutyStateChanged(driving)` for the CHOSEN
   driver, then accrue the leg via the shared `applyDrivingLeg`.

### Task 3 — Update the HOS-on golden expectation
- `test/hos-determinism.unit.test.ts`: the one Phase-11 assertion that there are
  exactly 9 drivers becomes 15 (9 primary + 6 spares). All other assertions hold
  unchanged. The same-seed byte-identity checks self-regenerate the golden.

### Task 4 — Verify the gate + determinism keystone
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all` all green.
- HOS-off byte-identical: `determinism.unit` + `rfid-determinism.unit` pass
  UNCHANGED (not edited). HOS-on golden regenerated + green.

## Determinism guarantees (the keystone)
- Relay is entirely gated by `hosOn`; HOS-off makes ZERO new draws / events.
- All relay state reads the virtual clock (`availableAtMin`, `occurredAt`) — no
  `Date.now()`. Spare selection is a stable registration-order scan (no RNG); the
  only `hosRng` draws remain the pre-existing rest/break jitter in
  `accrueDrivingLeg`, drawn in event-queue order.
- Same seed + same `HosConfig` ⇒ byte-identical; different seed differs.

## Out of scope (later phases)
Driver-status projection (13), endpoint/optimizer/UI (14–17).
