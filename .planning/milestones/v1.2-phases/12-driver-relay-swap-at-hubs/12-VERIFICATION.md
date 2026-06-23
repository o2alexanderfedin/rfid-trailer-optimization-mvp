---
status: passed
---

# Phase 12 Verification: Driver relay / swap at hubs

**Requirements:** DRV-04, SIM-HOS-04
**Branch:** `feature/phase-12-driver-relay-swap-at-hubs` (not merged, not pushed)
**Verified:** 2026-06-22

## Gate — ALL GREEN

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` | ✅ 10/10 tasks successful |
| Typecheck | `pnpm typecheck` | ✅ 0 errors (`tsc --noEmit`) |
| Lint | `pnpm lint` | ✅ 0 problems (`eslint .`) |
| Tests | `pnpm test:all` | ✅ **128 test files, 1338 tests passed, 0 failed** (exit 0) |

Simulation package alone: 15 test files, 140 tests passed (unit + integration,
incl. `drives-projections.int.test.ts` driving the relay stream through the real
projections).

## Determinism keystone — stated explicitly

- **HOS-off byte-identical: YES.** `determinism.unit.test.ts` (10 tests) and
  `rfid-determinism.unit.test.ts` (5 tests) pass **UNCHANGED** — they were NOT
  edited. All relay code is gated by `hosOn`; with HOS off the engine makes ZERO
  new draws and emits ZERO new events. The transit draw was moved earlier inside
  `departTrailer`, but no other timing draw is interleaved there, so the
  timing-substream draw ORDER is identical in both modes.
- **HOS-on golden regenerated + green: YES.** `hos-determinism.unit.test.ts`
  passes (20 tests): same seed + same `HosConfig` ⇒ byte-identical; different
  seed differs; every event validates; non-decreasing `occurredAt`. The single
  Phase-11 driver-count assertion (9) was updated to the new pool size (15 = 9
  primary + 6 spares); all other HOS-on assertions hold unchanged.
- **No wall-clock, RNG isolated:** no `Date.now()`; relay reads only the virtual
  clock (`availableAtMin`, `occurredAt`); spare selection is a stable
  registration-order scan (no RNG); the only `hosRng` draws remain the
  pre-existing rest/break jitter in `accrueDrivingLeg`, drawn in event-queue order.

## How relay determinism is guaranteed
1. Pool roster size is a pure function of the network (`spokes.length +
   RELAY_SPARE_DRIVERS`) — no RNG, byte-stable ids `D001…D015`.
2. Spare-driver selection scans `sparePool` in stable registration order; the
   first eligible (free + helpful) candidate wins. No RNG, no wall-clock.
3. Eligibility reads `availableAtMinByDriver` (virtual-clock minutes) and the
   Phase-10 `remainingLegalDriveMinutes` (pure integer math). Same seed + config
   ⇒ identical legs ⇒ identical relay decisions.

## Success-criteria → evidence checklist

| # | Success criterion | Evidence | Status |
|---|---|---|---|
| 1 | Each hub maintains a driver pool; a fresh driver is selected deterministically on handoff | `RELAY_SPARE_DRIVERS=6` spares + per-trailer primaries seeded at bootstrap (15 `DriverRegistered`); stable-order spare scan in `selectDriverForLeg`. Tests: `relay-swap.unit` "DRV-04: per-hub driver pool" (3) + "same seed ⇒ byte-identical relay stream" | ✅ |
| 2 | `DriverSwappedAtHub` emitted; tired driver enters rest; trailer continues | `selectDriverForLeg` emits the swap, `DriverDutyStateChanged(resting, "relay-handoff")`, reassigns + dispatches. 25 swaps fire (seed 1234). Tests: "a swap names two distinct drivers…", "the OUTGOING tired driver enters rest…", "a swap is immediately followed by a TrailerDeparted…" | ✅ |
| 3 | Relay preserves determinism (golden extended/updated and green) | HOS-off byte-identical (unchanged goldens pass); HOS-on golden updated (count 9→15) + green; same-seed byte-identity asserted. Full `test:all` green | ✅ |

## Requirements → evidence

| Req | Evidence | Status |
|---|---|---|
| **DRV-04** — each hub maintains a driver pool/roster | Center pool seeded at bootstrap (HOS-on): 9 primary + 6 spares, all `DriverRegistered` at the center, fresh clocks, unique ids, all before the first assignment. `engine.ts` bootstrap + `relay-swap.unit` DRV-04 tests | ✅ |
| **SIM-HOS-04** — relay/swap-at-hub when the assigned driver lacks legal hours | `selectDriverForLeg`: Phase-10 legality check → `DriverSwappedAtHub` + reassignment + tired-driver 10h rest + on-time departure; deterministic; HOS-off gated off. `relay-swap.unit` SIM-HOS-04 + determinism tests | ✅ |

## Conclusion
All 3 success criteria met, both requirements satisfied, full gate green, HOS-off
byte-identical, HOS-on golden regenerated + green. **Status: passed.**
