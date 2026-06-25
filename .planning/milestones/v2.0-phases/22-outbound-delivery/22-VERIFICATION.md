---
phase: 22
name: Outbound Delivery
status: passed
verified: 2026-06-25
gate: "build 10/10 + typecheck clean + lint clean + unit 1500/1500 + ui 233/233 + integration verified per-file (delivery-kpi 1/1, open-ended-driver 3/3); goldens byte-identical"
---

# Phase 22 Verification — Outbound Delivery

**Goal:** Freight reaching its destination hub exits the network via a `PackageDelivered` terminal
event with an on-time SLA flag, projections stay bounded, and delivery highlights appear on the map.

**Result: PASSED.** Built via 2 rival worktrees (TDD) → adversarial judge (winner **R2** — R1's feature
was correct but never wired into the API driver, dead in the live demo) → 3 graft-fixes folded in →
authoritative clean-memory gate.

## Requirements — all met
| Req | Status | Evidence |
|-----|--------|----------|
| OUT-01 `PackageDelivered` terminal event | ✅ | 5-file (+`src/index.ts` barrel = 6) closed-union ceremony; one-shot `deliverPackage` EventQueue task fired at destination-spoke arrival after a strictly-positive seeded dwell; `PackageArrivedAtHub` no longer terminal. |
| OUT-02 lifecycle ordering + dwell | ✅ | `deliverPackage` one-shot; dwell `1 + outboundRng.int(20)` (≥1 tick) ⇒ delivery always a strictly-later tick than arrival ⇒ `(fireTick,seq)` comparator UNCHANGED (D-22-2). Lifecycle-ordering + terminal-completeness tests green. |
| OUT-03 onTime flag | ✅ | `onTime = deliveredAt <= slaDeadlineIso` (ISO lexicographic); `slaDeadlineByPackage` populated at induction (gated on flag), captured in `SimContinuation.world`; center-origin freight → onTime=true. |
| OUT-04 projection DELETE purge (bounded) | ✅ | Hard DELETE on `packageLocation` (`Map.delete`), `hubInventory` (`placePackage(...,null)`), `zoneEstimate` (`${packageId}|` prefix scan — R1 graft, fixes an RFID zone-row leak R2 left as a no-op). All idempotent no-ops on missing rows (D-22-1). |
| VIZ-14 destination highlight | ✅ | tick-only `deliveryEvents` WS field (never in snapshot → no reconnect re-flash, Pitfall-7), collected on all 3 driver broadcast paths; `createDeliveryLayer`/`flashDelivery` (green `#16a34a`) + MapView wiring (ui 233/233). |
| OUT-05 (P2) delivered-out + on-time% KPI | ✅ | Event-derived `deliveryKpiReducer` + `GET /api/delivery-kpi` folding the immutable `events` log (`COUNT(*) FILTER`) — NEVER a row-count over the purged tables (D-22-3); `DeliveryKpi` operator widget. |

## Determinism keystone — verified
- `outboundDeliveryEnabled:false` (default) ⇒ ZERO `PackageDelivered`, ZERO `outboundRng` draws, ZERO
  purges ⇒ seed-42 10k-tick golden SHA `3920accc…` **byte-identical** + seed-1234 byte-identical
  (`determinism.unit` green; explicit-`false` == absent).
- `OUTBOUND_RNG_SALT = 0xc4f832b6` — 7 named substream salts pairwise-distinct (`fuel-determinism` green).
- Outbound substream PRNG state + `pendingDeliveryByHub`/`deliveryCounter`/`slaDeadlineByPackage`
  captured in `SimContinuation` → flag-ON continuation-equivalence (chunked == all-at-once byte-identical) green.

## Judge verdict + graft-fixes (folded into the merge)
Winner **R2** (full end-to-end wiring incl. API driver + a KPI integration test). Three fixes applied
on top of the merge (commit `95ddab0` + lint `12b0674`):
1. **SHARED defect both rivals missed:** `packages/domain/test/events.unit.test.ts` not updated for the
   25th event — `describeEvent` switch + the `expectTypeOf<DomainEventType>` literal union. Vitest passed
   (esbuild strips types) but `pnpm typecheck` failed. Fixed (this is the `typecheck-gate-separate-from-build-lint` trap).
2. **Graft R1→R2:** `zone-estimate.ts` active `${packageId}|` prefix-DELETE purge (R2 left a no-op that
   leaks one stale zone row per RFID-observed delivered package — the Phase-21 is_active filter only gates
   READS, not row reclamation).
3. **Lint:** `optimizer/rolling/scope.ts` no-fallthrough (made the scope-neutral case labels contiguous);
   removed unnecessary type assertions + a now-unused import.

## Gate evidence
- `pnpm build` 10/10 · `pnpm typecheck` clean · `pnpm lint` clean.
- `vitest --project unit` **1500/1500**; `--project ui` **233/233**.
- Integration verified **per file** (project protocol — the full-serial testcontainers lane flakes under
  load, a pre-existing v2.0 infra condition, see `v2-gate-hygiene-oom`): new `delivery-kpi.int.test.ts`
  **1/1** (26s isolated); the 118 other integration tests green in the main-tree lane run.

## Investigated + cleared: open-ended-driver timeout (NOT a Phase-22 regression)
The main-tree (external-drive) integration lane showed `open-ended-driver.int.test.ts` (a **Phase-19**
CONT-01/02 test) timing out at 60s. Root-caused as a **disk/environment confound**, not a code defect,
via a controlled same-disk experiment:
- base `e846932` on internal disk: **3/3 pass, 88s**; HEAD `12b0674` on internal disk: **3/3 pass, 56s**
  (Phase-22 is *faster*). The external drive (`/Volumes/Unitek-B`) + cumulative testcontainers load pushes
  this DB-bound multi-chunk test past its 60s budget; on internal disk it passes comfortably.
- Phase-22's only flag-off cost in the driver is a cheap per-tick `collectDeliveries` event scan; every new
  engine path is gated on `outboundOn` (proven by the byte-identical golden). The Phase-19 test was left
  unchanged (out of scope; the slowness is the documented `detection-cost-scales-with-state` condition).

## Build method
Google AI Mode consult (2 rounds, udm=50) locked D-22-1..5 → `gsd-plan-phase` (7 plans, 5 waves,
checker-passed) → 2 rival worktrees on internal disk (TDD) → adversarial judge with reproduced test
results → graft-fixes → authoritative gate. Determinism keystone held.
