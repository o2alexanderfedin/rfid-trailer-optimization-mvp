# 03-03 Summary — Simulation RFID emission (SIM-03)

Extends `@mm/simulation` to emit seeded, probabilistic `RfidObserved` events.

## What shipped

- **`packages/simulation/src/rfid.ts`** (new): `emitRfidReads(args)` +
  `RfidSimConfig`/`DEFAULT_RFID_CONFIG`/`resolveRfidConfig`. Pure, DI-only (an
  `Rng` and `occurredAt` are injected; no ambient state, no `Math.random`/`Date.now`).
- **`packages/simulation/src/engine.ts`**: `SimulateOptions` gained an optional
  `rfid?: Partial<RfidSimConfig>`; portal reads emitted on load (`departTrailer`),
  antenna bursts during dwell (`arriveTrailer`); `rfidTagId` attached to
  `PackageCreated` when RFID is enabled.
- **`packages/simulation/src/index.ts`**: exports the RFID surface.
- Tests: `rfid.unit.test.ts` (13) + `rfid-determinism.unit.test.ts` (5) = **18 new**.

## Emission semantics

- **Portal (dock door, on load):** reader `${hubId}-PORTAL`, antenna
  `${hubId}-PORTAL-A1`, base RSSI **-50 dBm** (strong). One candidate read per
  loaded tag, subject to `missRate`.
- **Antenna (trailer, during dwell):** reader `${trailerId}-ANT`, antenna
  `${trailerId}-ANT-A1`, base RSSI **-65 dBm** (zone-ish, noisier). A **burst**
  (`antennaBurst`, default 4) of reads per carried tag → exercises fusion dwell
  windowing. Each subject to `missRate`.
- Portal RSSI > antenna RSSI by construction (confidence is monotonic in RSSI).

## RfidSimConfig defaults

| Knob | Default | Meaning |
|------|---------|---------|
| `missRate` | 0.1 | P(drop) per candidate read; 0 ⇒ all, 1 ⇒ none |
| `rssiNoise` | 3 | ± dBm symmetric jitter (rng) |
| `wrongZoneRate` | 0.03 | P(payload trailer token corrupted, e.g. `T001-Z`) |
| `wrongTagRate` | 0.01 | P(tag id corrupted to `TAG-UNKNOWN-*`) |
| `antennaBurst` | 4 | reads per tag per dwell |
| `portalBaseRssi` | -50 | dBm |
| `antennaBaseRssi` | -65 | dBm |
| `maxConfidence` | 0.85 | per-read sim-confidence cap (anti-P5b at data layer) |

## Id / tag schemes (consumed by Plans 05/06/07)

- **tagId:** `TAG-${packageId}` (set on `PackageCreated.payload.rfidTagId`).
- **portal reader:** `${hubId}-PORTAL`; **antenna reader:** `${trailerId}-ANT`.
- A wrong-zone read corrupts only the OBSERVED payload `trailerId` token; the
  event is still routed to the **planned** `trailer-${trailerId}` stream, so the
  observed-vs-planned disagreement stays detectable downstream.

## Opt-in (not additive)

RFID is **opt-in**: it emits only when the `rfid` option is present. Two design
choices keep every pre-existing simulation golden byte-identical:
1. No `rfid` option ⇒ no `RfidObserved`, and no `rfidTagId` on `PackageCreated`.
2. RFID draws from a **separate seeded substream** (`makeRng(seed ^ salt)`), so
   enabling RFID never perturbs the operational rng — the non-RFID event order
   is identical with or without the option.

## Anti-pattern guarantees

- **Anti-P6 (data layer):** a dropped read is an OMITTED event. The simulator
  NEVER emits a "missing"/"absent" substitute. `missRate=1` ⇒ zero
  `RfidObserved` and no substitute event (test-asserted).
- **Anti-P5b (data layer):** per-read sim-confidence is capped ≤ 0.85.
- **Determinism (T-03-07):** every miss/jitter/wrong-zone/wrong-tag decision is
  rng-sourced; same seed + same rfid config ⇒ byte-identical stream (drops +
  noise included). The drop branch consumes the SAME base rng draws as a kept
  read, so a drop does not shift the downstream stream.

## Gates (run from the worktree)

`pnpm install` ✓ · turbo `pnpm build` ✓ (9/9) · `pnpm -r build` ✓ · `pnpm lint`
✓ (0 errors) · `pnpm test:all` ✓ **386 passed** (48 files; real Postgres via
Testcontainers/orbstack). 18 of those are new SIM-03 tests; all prior Phase-1/2
and Phase-3 tests remain green. `grep -E "Date.now|Math.random"
packages/simulation/src` ⇒ doc-comments only, zero usages.

## Integration into `feature/phase-3-rfid-assisted-validation`

- **Winner:** rival #1 (`wt/p3-03-r1`, sha `2e1ae267aa52b34d11acbd387649c766ad87630e`),
  merged `--no-ff` with no conflicts (engine/index/rfid + tests + this summary).
- **Gates re-verified on the integrated branch** (not just in the worktrees):
  `pnpm install` ✓ · turbo `pnpm build` ✓ **9/9** · `pnpm -r build` ✓ ·
  `pnpm lint` ✓ (0 errors) · `pnpm test:all` ✓ **386/386** across **48 files**
  with real Postgres via Testcontainers. This independently retires the judge's
  flagged risk that the full DB-backed suite had not been re-executed in the
  judging session.
- **Why #1 over #2 (carried context):** #1 attaches `rfidTagId` only when RFID is
  opt-in, so the non-RFID `PackageCreated` payload is byte-identical and cannot
  regress a downstream consumer or golden fixture; #2's unconditional `rfidTagId`
  was the latent regression vector. #1's wrong-tag corruption is namespaced
  (`TAG-UNKNOWN-${rng.int(1000)}`), so a corrupted tag cannot collide back onto a
  real package's tag (#2's `flipLastChar` could alias an adjacent real tag — a
  minor data-realism nit, not a gate failure).
- **Carried residual risk:** none gate-blocking. Wrong-tag/wrong-zone corruption
  is treated downstream as fusion evidence, not ground truth, so a rare collision
  degrades realism, not correctness. No integration regression observed.
- **Final merge sha:** `0ca81cb` on `feature/phase-3-rfid-assisted-validation`
  (pushed to origin). Rival worktrees/branches removed and pruned.
