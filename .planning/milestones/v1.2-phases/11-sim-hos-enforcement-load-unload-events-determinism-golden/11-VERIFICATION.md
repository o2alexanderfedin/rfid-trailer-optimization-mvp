---
status: passed
---

# Phase 11 — Sim HOS enforcement + load/unload events + determinism golden — VERIFICATION

**Verdict: PASSED.** All four phase success criteria are met, the determinism keystone holds (HOS-off byte-identical to the pre-v1.2 golden, new HOS-on golden green), and the full gate is green.

## Gate (all four GREEN)

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` (turbo) | 10/10 tasks successful (exit 0) |
| Typecheck | `pnpm typecheck` (`tsc -p tsconfig.eslint.json --noEmit`) | exit 0 |
| Lint | `pnpm lint` (eslint) | exit 0 (no `any`, strict TS, `noUncheckedIndexedAccess`) |
| Tests | `pnpm test:all` (vitest unit+integration+ui) | **1323 passed / 127 files, exit 0** |

Test count: 1303 baseline → **1323** (exactly +20, the new `hos-determinism.unit.test.ts`).

## Determinism keystone (the single most important gate)

- **HOS-OFF byte-identical to the pre-v1.2 golden — PROVEN.** sha256 of the canonical seed-1234 / 6000-tick stream is UNCHANGED before vs after this phase: `0f11c75f490e7c4aa73c371f21fe45ead9cee3f898731cec4640e841197d5c0a` (len 3391). The RFID stream (`908f4e12…`) and over-carry stream (`d2a9dc0d…`) are likewise byte-unchanged. The existing `determinism.unit.test.ts` + `rfid-determinism.unit.test.ts` fixtures pass UNCHANGED (13/13). With `hosEnabled` absent the stream contains NO `DriverRegistered`/`DriverAssignedToTrip`/`DriverDutyStateChanged`/`UnloadStarted`/`UnloadCompleted`/`LoadStarted`, and `hosRng` is never drawn.
- **HOS-ON golden — GREEN.** Same seed + same `HosConfig` ⇒ byte-identical (default and explicit config); different seed ⇒ different stream. Stable sha256 `10d4a4379b5753166970c77a065bcc8a73c83e59a0489750bfe7bdfdc34735aa` (len 3323). Every emitted HOS-on event passes `validateEvent`; `occurredAt` is non-decreasing.

## Success-criteria checklist

- [x] **SC1 — 5th `hosRng` substream + salt-collision test.** `HOS_RNG_SALT = 0x10510901` added in `engine.ts`, distinct from `0x5f1da7c3`/`0x3ca71d5f`/`0x00007717`. *Evidence:* `hos-determinism.unit.test.ts` "the four salts … are pairwise distinct — no collision" + "the documented existing salts are the verified constants" — green.
- [x] **SC2 — Drivers accrue driving minutes; 30-min break / 10h rest injected on breach with duty-state transitions.** `accrueDrivingLeg` pushes transit ticks through the reused `applyDrivingLeg`; non-`drive` segments become scheduled queue time + `DriverDutyStateChanged(on_break|resting)` and a recovering `driving` transition. *Evidence:* tests "the HOS clock accrues drive minutes" (positive `driveTodayMin`), "long legs force at least one rest/break transition", "a resting→driving recovery" — green.
- [x] **SC3 — Load/unload phase events emitted in deterministic event-queue order.** `LoadStarted` before `TrailerDeparted`, `UnloadStarted` after `TrailerDocked`, `UnloadCompleted` after the last unload scan; payload exactly `{trailerId,hubId,tripId,occurredAt}`. *Evidence:* tests "emits UnloadStarted/UnloadCompleted/LoadStarted", "LoadStarted is emitted immediately BEFORE its TrailerDeparted", "UnloadStarted follows TrailerDocked and precedes UnloadCompleted", "phase-event payloads carry ONLY {trailerId,hubId,tripId,occurredAt}" — green.
- [x] **SC4 — Same seed + `HosConfig` → byte-identical; HOS-off byte-identical to pre-v1.2 golden; new HOS-on golden-replay test green.** See the Determinism keystone section above. *Evidence:* tests "hosEnabled:false is byte-identical to hosEnabled absent (the keystone)", "same seed + default HosConfig ⇒ byte-identical stream", "same seed + an EXPLICIT HosConfig ⇒ byte-identical stream", "different seed ⇒ a different HOS-on stream" + the unchanged existing determinism goldens + the sha256 before/after comparison.

## Requirement coverage

| Req | Where | Evidence |
|---|---|---|
| **SIM-HOS-01** | `engine.ts` `HOS_RNG_SALT` + `hosRng` substream | salt-collision + verified-constants tests |
| **SIM-HOS-02** | `engine.ts` driver seeding (bootstrap), `departTrailer` (`DriverAssignedToTrip` + `DriverDutyStateChanged(driving)`), `accrueDrivingLeg` (reuses `applyDrivingLeg`) | "one DriverRegistered per trailer", "registration precedes first assignment", "every departure trip is assigned", "HOS clock accrues drive minutes" |
| **SIM-HOS-03** | `engine.ts` `accrueDrivingLeg` (break/rest as queue time; `hosRng` jitter at evaluation time) | "long legs force rest/break", "resting→driving recovery" |
| **SIM-HOS-05** | `engine.ts` `emitPhase` (`LoadStarted`/`UnloadStarted`/`UnloadCompleted`) | load/unload ordering + payload-shape tests |
| **SIM-HOS-06** | opt-in `hosEnabled` flag + the HOS-on golden | byte-identical-off keystone test + HOS-on golden-replay tests + unchanged existing goldens + sha256 before/after |

## Reuse honored
- `@mm/domain` Phase-9 events and Phase-10 engine (`applyDrivingLeg`, `DEFAULT_HOS_CONFIG`, `HosConfig`/`HosClock`/`DutyStatus`) are imported and reused — NOT reimplemented.
- Strict TS, no `any`; the one stray type assertion flagged by eslint was removed.

## Scope honored / deferred
Per-trip / one-driver-per-trailer only (a trailer parks while its driver rests). Driver relay/swap + per-hub pools → Phase 12 (SIM-HOS-04/DRV-04). Driver-status projection → Phase 13. Endpoint/optimizer/UI → 14–17.
