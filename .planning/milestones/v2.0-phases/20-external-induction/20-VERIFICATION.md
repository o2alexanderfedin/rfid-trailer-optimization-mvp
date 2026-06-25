---
phase: 20
name: External Induction
status: passed
verified: 2026-06-24
gate: "pnpm check (lint+typecheck+test:all) — 170 files / 1758 tests passed, 0 failures"
---

# Phase 20 Verification — External Induction

**Goal:** Freight enters the network from outside at spoke hubs via a new `PackageInducted` domain event, shapes optimizer priority, and animates on the live map.

**Result: PASSED.** Built via 2 rival worktrees → judge (winner `p20-r2`) → fold-ins (fail-loud invariant + cherry-picked adversarial doc + MapView VIZ-13 wiring test) → authoritative gate.

## Requirements — all met
| Req | Status | Evidence |
|-----|--------|----------|
| IND-01 `PackageInducted` event | ✅ | New event in closed `DomainEvent` union (5-file ceremony, `.strict()`, `contract.assert` exhaustive, `validate()` round-trip), COEXISTS with `PackageCreated`. |
| IND-02 spoke induction, dedicated salt | ✅ | Self-rescheduling `inductPackage` EventQueue task at spokes; `INDUCTION_RNG_SALT` (7th substream, built only when on) asserted pairwise-distinct; `inductionEnabled` opt-in (off by default). **Captured in `SimContinuation`** (RNG state + pending task + `inductionCounter`) → continuation-equivalence with induction ON green across chunk boundaries between arrivals. |
| IND-03 destHub + SLA deadline → optimizer | ✅ | `destHubId` + `slaDeadlineIso` (locked at induction = `occurredAt + expectedTransit(induction→center→dest) + SLA buffer`, whole-minute); `hub_inventory.inbound` demand path; `detectAffectedScope` → `[inductionHubId, destHubId]`; `TwinBlock.deadlineMin?` via `buildInductionDeadlines()`. |
| VIZ-13 induction map animation | ✅ | WS `TickPayload.inductionEvents` (tick-only, never snapshot → no reconnect re-flash), collected per-tick in the driver on all 3 paths; `createInductionLayer`/`flashInduction` pulsing purple marker; MapView `onEnvelope` wiring tested (browser lane). |

## Determinism keystone — verified
- `inductionEnabled:false` (default) ⇒ ZERO `PackageInducted` ⇒ seed-1234 + seed-42 (`3920accc…`) goldens **byte-identical**.
- Induction RNG substream + pending self-rescheduling task + counter fully captured in `SimContinuation` (continuation-equivalence + adversarial clone/freeze green) → continuous/chunked runs byte-identical with induction ON.
- `INDUCTION_RNG_SALT = 0x8f2c4ae1` pairwise-distinct from all 6 prior salts. Deterministic `(tick,sequenceId)` tie-break preserved.

## Judge + fold-ins
- Winner `p20-r2` chosen on VIZ-13 architecture (prescribed per-tick-window collection through `Broadcast`, production path under test, stronger Pitfall-7 guard) over `p20-r1`'s injectable log-cursor port (added coupling + untested SQL).
- Fold-ins: fail-loud induction invariant (impossible self-destined induction throws, goldens unaffected); 7-substream adversarial doc; MapView VIZ-13 wiring test (plan-required, missing in both rivals).

## Google AI Mode consult (udm=50) — folded in
Deterministic arrival process across resume boundaries; pending-task capture; deadline from a service estimate (not flat offset); hash-split salt; same-tick tie-break.

**Gate:** `pnpm check` → 170 files / 1758 tests passed, 0 failures (2026-06-24).
