# Phase 11 — Sim HOS enforcement + load/unload events + determinism golden — SUMMARY

**Reqs delivered:** SIM-HOS-01, SIM-HOS-02, SIM-HOS-03, SIM-HOS-05, SIM-HOS-06
**Outcome:** Driver Hours-of-Service is wired into the deterministic simulator behind an opt-in `hosEnabled` flag (default false). HOS-off is **byte-identical to the pre-v1.2 golden**; a new HOS-on golden is added and green.

## What shipped

### `packages/simulation/src/engine.ts`
- **Fifth RNG substream (SIM-HOS-01).** New exported salt `HOS_RNG_SALT = 0x10510901`, distinct from the rfid/over-carry/timing salts (now also exported as `RFID_RNG_SALT`/`OVER_CARRY_RNG_SALT`/`TIMING_RNG_SALT`). `hosRng` is constructed unconditionally (side-effect-free) but only drawn when HOS is on.
- **Opt-in flag.** `SimulateOptions.hosEnabled?: boolean` (default false) + `hosConfig?: HosConfig` (default `DEFAULT_HOS_CONFIG`). Every new behavior is gated on `hosOn`; off ⇒ zero `hosRng` draws, zero new events.
- **Per-trip driver model (SIM-HOS-02).** One `DriverRegistered` per trailer at bootstrap (`T00n → D00n`, home = center, fresh HOS clock at epoch). On dispatch: `LoadStarted` → `TrailerDeparted` → `DriverAssignedToTrip` → `DriverDutyStateChanged(driving)`. Transit ticks accrue as DRIVING minutes via the **reused Phase-10** `applyDrivingLeg`.
- **Mandatory rest injection (SIM-HOS-03).** `accrueDrivingLeg` reads the `applyDrivingLeg` segments; each `break`/`rest` segment adds `minutes + hosRng jitter` to the leg's wall-clock (the arrival fires later — a parked trailer = a resting driver) and emits a `DriverDutyStateChanged` (`on_break`/`resting`) plus a recovering `driving` transition. The jitter draw happens at deterministic evaluation time (dispatch), in event-queue order — never wall-clock.
- **Load/unload phase events (SIM-HOS-05).** `LoadStarted` (before departure), `UnloadStarted` (after dock), `UnloadCompleted` (after the last unload scan); payload exactly `{trailerId,hubId,tripId,occurredAt}`.

### `packages/simulation/test/hos-determinism.unit.test.ts` (new, TDD-first)
20 tests across SIM-HOS-01/02/03/05/06: salt-collision assertion, HOS-off byte-identical keystone, HOS-on golden-replay (default + explicit config), driver assignment/accrual, rest injection + recovery, load/unload ordering + payload shape.

## Reuse (not reimplemented)
- `@mm/domain` Phase-9 events: `DriverRegistered`, `DriverAssignedToTrip`, `DriverDutyStateChanged`, `UnloadStarted`, `LoadStarted`, `UnloadCompleted`.
- `@mm/domain` Phase-10 engine: `applyDrivingLeg`, `DEFAULT_HOS_CONFIG`, `HosConfig`, `HosClock`, `DutyStatus`.

## Determinism result (the keystone)
- **HOS-off byte-identical:** sha256 of the seed-1234/6000-tick stream is unchanged before vs after this phase (`0f11c75f…`, len 3391). The RFID (`908f4e12…`) and over-carry (`d2a9dc0d…`) streams are likewise byte-unchanged. The existing `determinism.unit.test.ts` + `rfid-determinism.unit.test.ts` fixtures pass UNCHANGED.
- **HOS-on golden:** stable at sha256 `10d4a437…` (len 3323); same seed + same `HosConfig` ⇒ byte-identical across replays.

## Scope honored / deferred
Per-trip / one-driver-per-trailer only. Driver relay/swap + per-hub pools → Phase 12. Projection → Phase 13. Endpoint/optimizer/UI → 14–17.
