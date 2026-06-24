# Plan 19-05 Summary — WS backpressure + simDay envelope + UI

**Status:** complete · **Wave:** 2 · **Requirements:** CONT-03, CONT-04(b)

## What landed
- `packages/api/src/ws/envelope.ts`: `simDay: number` on BOTH `WsEnvelope` union members (envelope-level, bypasses `diffTick` — same convention as `speed`).
- `packages/api/src/ws/snapshots.ts`:
  - `BACKPRESSURE_BYTES = 256 * 1024` + pure exported `shouldSendToSocket(socket)` guard used by `sendRawIfOpen` (tick deltas only; initial/resync snapshots send at 0 bytes — unguarded, Pitfall 4).
  - `deriveSimDay(simMs)` (exported, pure) derived from the virtual clock, clamped `>= 0`, NEVER `Date.now()`; applied to all three envelope sites.
- `packages/web/src/map/wsClient.ts`: tolerant `simDay` parse (accept-with-default 0) so the client carries it through.
- `packages/web/src/panels/KpiDashboard.tsx`: "Sim Day N" readout via the existing `useWsEnvelope` path (ref-guarded, re-renders only on change).
- `simDay: 0` added to every `WsEnvelope` literal across api + web tests (required field).

## Result
api unit (snapshots backpressure + ws-envelope simDay) 10/10 GREEN; web ui 214/214 GREEN; ws.int + live-demo.int GREEN. build/typecheck/lint clean.
