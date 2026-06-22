# Phase 12: Driver relay / swap at hubs - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (grounding-enriched; touches the HOS-on determinism golden)

<domain>
## Phase Boundary

Add **per-hub driver pools** and **relay/swap** to the (Phase-11) HOS-enabled simulation: when an assigned driver is out of legal hours at a hub, hand the trailer to a fresh driver from that hub's pool (`DriverSwappedAtHub`) so freight keeps moving, while the tired driver goes off-duty/resting. Deterministic.

**In scope:** DRV-04 (per-hub driver pool/roster runtime), SIM-HOS-04 (relay/swap-at-hub handoff in the sim).
**OUT of scope:** driver-status projection (Phase 13), endpoint/optimizer/UI (14–17).
</domain>

<decisions>
## Implementation Decisions

### Driver pool + relay (DRV-04, SIM-HOS-04)
- Each hub maintains a **driver pool/roster**. Seed pools deterministically at sim start (mirror trailer/driver seeding). Pool size: enough that a fresh driver is usually available at a hub (Claude's discretion — pick a deterministic default; if no fresh legal driver is available, fall back to the Phase-11 behavior of parking the trailer until its driver is legal again).
- On arrival at a hub, if the assigned driver **cannot legally complete the next leg** (use the Phase-10 engine `remainingLegalDriveMinutes`/`mayDriveNow`), perform a relay: select a fresh legal driver from the hub pool **deterministically** (stable ordering / `hosRng` in queue order — never wall-clock), emit `DriverSwappedAtHub`, reassign the trailer's next trip to the fresh driver (`DriverAssignedToTrip`), and put the tired driver off-duty/resting (`DriverDutyStateChanged`). The trailer then departs on time instead of parking.

### 🔑 Determinism (regression invariant + golden update)
- Relay is active **only when `hosEnabled` is true**. **HOS-off MUST remain byte-identical to the pre-v1.2 golden** — the existing `determinism.unit` + `rfid-determinism.unit` fixtures pass UNCHANGED. Verify this explicitly.
- The **HOS-on golden expectation WILL change** (drivers now swap instead of parking). Regenerate the HOS-on golden fixture deterministically and assert same-seed + same `HosConfig` → byte-identical; different seed differs. All pool selection + any relay randomness flows through `hosRng` in deterministic queue order.

### Claude's Discretion
Pool size/seeding, fresh-driver selection policy (e.g. most-rested-first, deterministic), how the off-duty driver re-enters the pool after a 10h reset — follow Phase-11 conventions. **TDD mandatory:** test the swap fires when the assigned driver is out of hours, the fresh driver is deterministic, the tired driver rests, the trailer keeps moving, and determinism holds (HOS-off unchanged, HOS-on new golden).
</decisions>

<code_context>
## Existing Code Insights

### Reuse (do NOT reimplement)
- Phase-11 sim HOS wiring in `packages/simulation/src/engine.ts` (5th `hosRng` substream salt `0x10510901`, `hosEnabled` flag, per-trip driver assignment, `accrueDrivingLeg`, break/rest injection) — extend it with the pool + relay.
- `packages/simulation/src/scenario.ts` (config), `clock.ts` (VirtualClock).
- `@mm/domain` Phase-9 `DriverSwappedAtHub`/`DriverAssignedToTrip`/`DriverDutyStateChanged` events + Phase-10 engine (`remainingLegalDriveMinutes`, `mayDriveNow`).
- `packages/simulation/test/hos-determinism.unit.test.ts` — the HOS-on golden to update; `determinism.unit.test.ts` + `rfid-determinism.unit.test.ts` — HOS-off goldens that MUST stay byte-identical.

### Established Patterns
- Deterministic seeded pools/queues; isolated RNG substreams; `DriverSwappedAtHub` already in the closed union (Phase 9). The "parked truck while driver rests" is the Phase-11 fallback; relay is the Phase-12 upgrade (fresh driver continues the freight).
</code_context>

<specifics>
## Specific Ideas

Reqs: **DRV-04, SIM-HOS-04**. Grounding: `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md` (driver-relay handling / hub-and-spoke fresh-driver-swap). The relay is the demo's "fresh-driver swap at hub" moment — freight keeps moving while a tired driver rests. Keystone: HOS-off byte-identical; HOS-on golden regenerated deterministically.
</specifics>

<deferred>
## Deferred Ideas
- Driver-status projection (status, remaining drive minutes per driver) → Phase 13.
</deferred>
