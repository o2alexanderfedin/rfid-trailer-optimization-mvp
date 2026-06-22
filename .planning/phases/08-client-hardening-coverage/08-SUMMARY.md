# Phase 8: Client Hardening & Coverage — Summary

**Completed:** 2026-06-22 · **Branch:** `feature/v1.1-realistic-time-model` · **Status:** ✅ COMPLETE & verified.

## What was delivered

| REQ | Status | Notes |
|-----|--------|-------|
| **HRD-01** — tolerant `parseEnvelope` | ✅ Done | `parseEnvelope` (`packages/web/src/map/wsClient.ts`) now accepts an envelope with a missing/invalid `speed` by falling back to a new `DEFAULT_SPEED` (`{multiplier:1, tickIntervalMs:500, simSpeed:120, paused:false}` — the speed-controller 1× default) and `console.warn`s **exactly once** (module-level guard) — so a partial/older server envelope still animates the map instead of blanking it. It STILL rejects (`null`) genuinely malformed envelopes (bad `v`/`type`/`seq`/`simMs`/`payload`) — the fallback is `speed`-only and never masks a real protocol error (PITFALLS P7). `isSimSpeedState` upgraded to a real `value is SimSpeedState` type guard (removed a cast). |
| **QA-01** — ws socket-path coverage | ✅ Done | Behavior-asserting tests (not metric-gaming): parseEnvelope branches (missing-speed→DEFAULT_SPEED + warn-once across 5 envelopes; each malformed core field→null) in `wsClient.test.ts`; production socket path (`WsProvider`) covered for seq-gap→`{v:1,type:"resync"}`, snapshot-replace, tick-delta, single-open. `wsClient.ts` parse path at 100%. |

## Verification (independently re-confirmed by the orchestrator)
- `pnpm build` 10/10 · `pnpm typecheck` 0 · `pnpm lint` 0 · **unit 960** · **ui 183** (web `unit`+`ui` lanes; the integration suite is unaffected by web-only changes and was independently green at 82/20 after Phase 6/7).

## Adversarial audit + cleanup (the QA-01 quality check, applied)
The audit (pass, no HIGH) flagged a **MEDIUM**: the first QA-01 socket test exercised an **orphaned `useWsEnvelope` hook in `wsClient.ts`** — dead code superseded by `WsProvider.tsx`'s live hook (FIX-16); testing it inflated coverage of dead code. Per "fix pre-existing issues," the orphaned hook (`useWsEnvelope`, `wsUrl`, `EnvelopeHandler`) + its dead-code test (`wsClient.socket.test.tsx`) were **removed** (`18c68ce`); the production socket path stays covered by `WsProvider` tests, and the HRD-01 parse tests are untouched in `wsClient.test.ts`. (ui 190→183 reflects the 7 removed dead-hook tests, not lost production coverage.)

## Known minor debt (LOW, deferred)
- `DEFAULT_SPEED` literal is mirrored in `wsClient.ts`, `SpeedControl.tsx`, and the backend speed-controller — could drift; a shared constant is a future DRY cleanup.
- `seq`/`simMs` accept `NaN` (`typeof === "number"`) — pre-existing, outside HRD-01's surface.

## Commits
`faf69a8` (HRD-01 + QA-01) · `18c68ce` (orphaned-hook + dead-test cleanup).
