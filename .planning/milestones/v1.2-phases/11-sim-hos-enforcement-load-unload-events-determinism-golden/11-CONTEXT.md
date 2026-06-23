# Phase 11: Sim HOS enforcement + load/unload events + determinism golden - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; DETERMINISM-KEYSTONE phase — highest risk)

<domain>
## Phase Boundary

Wire driver Hours-of-Service into the **deterministic simulation**: assign a driver per trip, accrue duty time using the Phase-10 engine, inject mandatory rest/breaks, and emit the driver duty + load/unload phase events — all **deterministically**, behind an opt-in flag so the pre-v1.2 seeded golden stays byte-identical and a new HOS-on golden is added.

**In scope:** SIM-HOS-01/02/03/05/06 — 5th RNG substream; per-trip driver assignment + HOS accrual; mandatory break/rest injection; load/unload phase-event emission; determinism goldens (off=pre-v1.2 byte-identical, on=new).
**OUT of scope:** driver relay/swap + per-hub pools (Phase 12 — SIM-HOS-04); projection (Phase 13); endpoint/optimizer/UI (14–17).
</domain>

<decisions>
## Implementation Decisions

### 🔑 Determinism design (the keystone — get this exactly right)
- Add an **opt-in flag** (e.g. `hosEnabled` on the scenario/sim config), **DEFAULT `false`**. When `false`, the sim emits NO driver events, NO HOS rest/breaks, NO load/unload events, and makes ZERO `hosRng` draws → the event stream is **byte-identical to the pre-v1.2 golden**. The EXISTING `packages/simulation/test/determinism.unit.test.ts` golden(s) MUST pass UNCHANGED (they run the default config = HOS off). Do not edit their expected fixtures.
- When `true`: all the new behavior below activates, and you add a **NEW golden-replay test** asserting same-seed + same `HosConfig` → byte-identical stream (HOS-on). 
- **5th RNG substream (SIM-HOS-01):** `hosRng = seed XOR <NEW distinct salt>` (existing salts: rfid `0x5f1da7c3`, over-carry `0x3ca71d5f`, timing `0x00007717` — see `engine.ts` ~L182). Pick a new salt that cannot collide; add a salt-collision assertion test.
- **All HOS randomness** (e.g. any jitter in rest/break placement) is drawn from `hosRng` at **deterministic evaluation time in event-queue order** — never at wall-clock/rest-start. No `Date.now()`.

### Driver assignment + HOS accrual (SIM-HOS-02/03)
- Minimal **per-trip** model: one driver bound per trailer (seed a `DriverRegistered` per trailer at sim start, mirroring how trailers are seeded one-per-spoke; assign via `DriverAssignedToTrip` on `TrailerDeparted`). (Pool + relay/swap is Phase 12.)
- Accrue driving minutes across the transit ticks into the driver's `HosClock`. Before scheduling the next departure, call the Phase-10 engine (`applyDrivingLeg` / `remainingLegalDriveMinutes` from `@mm/domain` — **reuse, do NOT reimplement**). When it returns a required break/rest, inject it as scheduled queue time (a parked trailer = a resting driver — the demo moment), emitting `DriverDutyStateChanged` transitions (driving→on_break/resting→driving).

### Load/unload phase events (SIM-HOS-05)
- Emit `UnloadStarted` after `TrailerDocked`, `UnloadCompleted` after the last unload scan, and `LoadStarted` before `TrailerDeparted`, in deterministic event-queue order. These carry only `{trailerId, hubId, tripId, occurredAt}` (no RNG). Gated by the same `hosEnabled` flag (so off-mode stays byte-identical).

### Determinism goldens (SIM-HOS-06)
- Existing golden (HOS off) passes unchanged.
- New golden (HOS on) added and green; same seed + `HosConfig` → byte-identical.

### Claude's Discretion
Exact flag name/placement, driver-seeding details, how breaks are represented in the queue — follow `engine.ts`/`scenario.ts`/`clock.ts` conventions. **TDD mandatory.**
</decisions>

<code_context>
## Existing Code Insights

### Reuse (do NOT reimplement)
- `@mm/domain` Phase-9 events (`DriverRegistered`/`DriverAssignedToTrip`/`DriverDutyStateChanged`; `UnloadStarted`/`LoadStarted`/`UnloadCompleted`) + Phase-10 engine (`applyDrivingLeg`, `remainingLegalDriveMinutes`, `mayDriveNow`, `DEFAULT_HOS_CONFIG`).
- `packages/simulation/src/engine.ts` — event-queue engine; 4 seeded RNG substreams via XOR salts (`departTrailer`/`arriveTrailer` emit trip events; `drawDwellTicks`/`drawTransitTicks` sample log-normal). Add the 5th substream + HOS hooks here.
- `packages/simulation/src/scenario.ts` — scenario/config (where `hosEnabled` likely lives).
- `packages/simulation/src/clock.ts` — `VirtualClock` (1 tick = 1 min; ISO↔epoch via the argument, never wall clock).
- `packages/simulation/test/determinism.unit.test.ts` + `rfid-determinism.unit.test.ts` — the golden-replay keystone tests. Existing ones must stay byte-identical; add a new HOS-on golden alongside.

### Established Patterns
- Trailers seeded one-per-spoke at tick 1; isolated RNG substreams; deterministic event-queue ordering; `assertNeverEvent` exhaustive switches (Phase 9 added no-op cases — fill in real handling where this phase needs it for the new events in `@mm/simulation`).
</code_context>

<specifics>
## Specific Ideas

Reqs: **SIM-HOS-01, SIM-HOS-02, SIM-HOS-03, SIM-HOS-05, SIM-HOS-06** (SIM-HOS-04 relay is Phase 12). Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` (determinism keystone section + the 4 existing salts). The determinism golden is the single most important acceptance gate of this phase — if HOS-off is not byte-identical to the pre-v1.2 golden, the phase is NOT done.
</specifics>

<deferred>
## Deferred Ideas
- Driver pool per hub + relay/swap-at-hub → Phase 12 (SIM-HOS-04).
- Driver-status projection → Phase 13.
</deferred>
