# Phase 11 — Sim HOS enforcement + load/unload events + determinism golden — PLAN

**Branch:** `feature/phase-11-sim-hos-enforcement-load-unload-events-determinism-golden`
**Reqs:** SIM-HOS-01, SIM-HOS-02, SIM-HOS-03, SIM-HOS-05, SIM-HOS-06
**Mode:** TDD (RED → GREEN → artifacts). DETERMINISM-KEYSTONE phase — byte-identical golden-replay is the single most important gate.

## Goal

Wire driver Hours-of-Service into the deterministic simulator: assign a driver per trip, accrue duty minutes through the **Phase-10 shared HOS engine** (`applyDrivingLeg`, reused — not reimplemented), inject mandatory break/rest as scheduled queue time, and emit driver-duty + load/unload phase events — all behind an **opt-in `hosEnabled` flag (DEFAULT FALSE)** so the pre-v1.2 seeded golden stays byte-identical and a NEW HOS-on golden is added.

## Design (executed)

All changes are in `packages/simulation/src/engine.ts` + the new test `packages/simulation/test/hos-determinism.unit.test.ts`. Reuse `@mm/domain` Phase-9 events + Phase-10 engine; reuse the existing event-queue / VirtualClock / seeded-substream conventions.

### The opt-in flag (the keystone)
- `SimulateOptions` gains `hosEnabled?: boolean` (default false) and `hosConfig?: HosConfig` (default `DEFAULT_HOS_CONFIG`, consulted only when `hosEnabled`).
- `const hosOn = hosEnabled === true`. Every new behavior is gated on `hosOn`. OFF ⇒ no driver/HOS/load-unload events, **ZERO `hosRng` draws** ⇒ byte-identical to the pre-v1.2 golden. The existing `determinism.unit.test.ts` / `rfid-determinism.unit.test.ts` fixtures are UNCHANGED and pass.

### SIM-HOS-01 — fifth RNG substream
- New exported salt `HOS_RNG_SALT = 0x10510901` (distinct from rfid `0x5f1da7c3`, over-carry `0x3ca71d5f`, timing `0x00007717`). The three existing salts are also lifted to exported constants (`RFID_RNG_SALT`/`OVER_CARRY_RNG_SALT`/`TIMING_RNG_SALT`) so the salt-collision test asserts pairwise distinctness without re-typing literals.
- `hosRng = makeRng((seed ^ HOS_RNG_SALT) >>> 0)` is CONSTRUCTED unconditionally (independent state — constructing it does not perturb the other four generators) but only DRAWN when `hosOn`.

### SIM-HOS-02 — per-trip driver assignment + accrual
- **Driver seeding:** at bootstrap (tick 0, when `hosOn`), one `DriverRegistered` per trailer — `T00n → D00n`, `homeHubId = center`, fresh post-reset `HosClock` anchored at the epoch. Mirrors one-driver-per-spoke trailer seeding; precedes the first dispatch (tick 1).
- **Assignment:** on each center-origin `departTrailer`, after the load scans, emit `LoadStarted`, then `TrailerDeparted`, then `DriverAssignedToTrip` (the driver↔trip binding — `TrailerDeparted`'s `.strict()` payload has no driver field) + `DriverDutyStateChanged(driving, "trip-dispatched")`.
- **Accrual:** the drawn transit ticks are the leg's DRIVING minutes; `accrueDrivingLeg` pushes them through `applyDrivingLeg(clock, hosLimits, transitTicks, departIso)` and stores the advanced clock in `clockByDriver`.

### SIM-HOS-03 — mandatory break/rest injection
- `applyDrivingLeg` returns `segments`; for each non-`drive` segment the sim adds `seg.minutes + jitter` to the leg's wall-clock and emits a `DriverDutyStateChanged` (`on_break`/`30-min-break-due` or `resting`/`10h-reset`); a recovering `driving`/`rest-complete` transition follows any pause. The arrival fires later by exactly the inserted rest minutes → **a parked trailer = a resting driver**.
- **Randomness:** a small `hosRng.int(HOS_REST_JITTER_TICKS+1)` jitter (0..15 min) is drawn PER inserted pause, at deterministic evaluation time (departure dispatch), in event-queue order — never at the wall-clock instant the rest begins. ZERO draws when `hosOn` is false.

### SIM-HOS-05 — load/unload phase events
- `LoadStarted` before `TrailerDeparted` (after load scans); `UnloadStarted` after `TrailerDocked`; `UnloadCompleted` after the last unload scan. Payload is EXACTLY `{trailerId, hubId, tripId, occurredAt}` (no RNG). All gated on `hosOn`.

### SIM-HOS-06 — determinism goldens
- HOS-off byte-identical to the pre-v1.2 golden (proven by sha256 before/after + the unchanged existing tests).
- New HOS-on golden test: same seed + same `HosConfig` ⇒ byte-identical; different seed ⇒ different; every event validates; non-decreasing `occurredAt`.

## Test plan (written FIRST — `packages/simulation/test/hos-determinism.unit.test.ts`)
- **SIM-HOS-01:** salts pairwise distinct; existing salts are the verified constants.
- **SIM-HOS-06 (off):** no driver/HOS/load-unload events when off; `hosEnabled:false` byte-identical to absent; off stream byte-stable.
- **SIM-HOS-06 (on):** same-seed/config byte-identical (default + explicit config); different seed differs; all events validate; non-decreasing occurredAt.
- **SIM-HOS-02:** exactly one `DriverRegistered` per trailer (9); registration precedes first assignment; every departure trip is assigned; driving transitions + positive `driveTodayMin` accrual.
- **SIM-HOS-03:** long legs force resting/on_break; a driver shows resting→driving recovery.
- **SIM-HOS-05:** load/unload events emitted; `LoadStarted` precedes its `TrailerDeparted`; `UnloadStarted` < `UnloadCompleted`; payload keys exactly `{trailerId,hubId,tripId,occurredAt}`.

## Gate (all four must be green)
`pnpm build` (turbo) · `pnpm typecheck` (tsc exit 0) · `pnpm lint` (eslint 0) · `pnpm test:all` (vitest unit+integration+ui). **HOS-off MUST be byte-identical to the pre-v1.2 golden** — verified by re-running the existing determinism tests with zero changes to their expectations + a sha256 before/after comparison.

## Out of scope (deferred)
Driver relay/swap + per-hub pools → Phase 12 (SIM-HOS-04/DRV-04). Driver-status projection → Phase 13. Endpoint/optimizer/UI → Phases 14–17. Sleeper-berth split injection in the sim is not exercised here (the engine supports it; the sim's per-trip legs trigger break/10h-rest paths).
