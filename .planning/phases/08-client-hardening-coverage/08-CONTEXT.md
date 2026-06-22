# Phase 8: Client Hardening & Coverage - Context

**Gathered:** 2026-06-21 · **Status:** Ready for planning · **Mode:** Smart discuss (autonomous) — decisions from requirements + PITFALLS P7/P8.

<domain>
## Phase Boundary
Harden the realtime web client against partial ws envelopes (HRD-01) and raise meaningful coverage on the ws socket path (QA-01). Web-only — no sim/optimizer/api-logic changes, so the integration suite is unaffected (verify = unit + ui lanes). Last phase of v1.1.
</domain>

<decisions>
## Implementation Decisions

### HRD-01 — tolerant `parseEnvelope` (packages/web/src/map/wsClient.ts)
- Today `parseEnvelope` hard-rejects a missing/invalid `speed` (`if (!isSimSpeedState(r["speed"])) return null;`, line 65), so a stale/older server build with no `speed` would make the client silently drop ALL ticks → blank map.
- Change: when `v/type/seq/simMs/payload` are ALL valid but `speed` is missing/invalid, **synthesize a `DEFAULT_SPEED`** and accept the envelope; **warn ONCE** (module-level flag → `console.warn("envelope missing speed; using DEFAULT_SPEED")`) for observability — do NOT spam per tick.
- Still return `null` for genuinely malformed envelopes (bad `v`/`type`/`seq`/`simMs`/`payload`). The fallback is ONLY for `speed` — it must not mask real protocol/version errors (PITFALLS P7).
- `DEFAULT_SPEED: SimSpeedState = { multiplier: 1, tickIntervalMs: 500, simSpeed: 120, paused: false }` (the speed-controller's 1× default: 60000 ms/tick ÷ 500 ms = 120× compression). Define it in web (e.g. wsClient.ts) — confirm values against `packages/api/src/sim/speed-controller.ts`.

### QA-01 — behavior-asserting coverage of the ws socket path
- Cover `useWsEnvelope` / `WsProvider` socket behavior (the ~56% raw-socket path) with REAL assertions, not metric-gaming: socket opens ONCE per mount (handler in a ref — changing onEnvelope does NOT reopen); a `seq` gap triggers a `{v:1,type:"resync"}` request; a `snapshot` REPLACES the entity maps; a `tick` applies a delta. Use a mock WebSocket (jsdom/ui lane) — no live socket.
- Add parseEnvelope branch tests: missing `speed` → accepted with `DEFAULT_SPEED` (+ warn-once); each malformed core field (`v`/`type`/`seq`/`simMs`/`payload`) → `null`.
- Raise branch coverage toward the project bar; assert outcomes, not just execution (PITFALLS P8).

### Cross-cutting
Strict TS (no `any`); TDD (failing test first); existing 949 unit + web ui tests stay green.
</decisions>

<code_context>
## Existing Code Insights
- `packages/web/src/map/wsClient.ts` — `parseEnvelope`, `isSimSpeedState`, `applySnapshot`, `applyTick`, `makeEntityMaps`; header notes `useWsEnvelope` (single socket, ref handler, seq-gap resync).
- `packages/web/src/map/WsProvider.ts` — exports `useWsEnvelope` (App + MapView subscribe).
- `SimSpeedState` — `@mm/api/ws/envelope.ts:35` (multiplier, tickIntervalMs, simSpeed, paused), imported by web via `@mm/api`.
- Existing tests: `wsClient.test.ts` (unit/node), `WsProvider.test.ts`, `WsProvider.render.test.tsx` (ui/jsdom). Vitest lanes: `.test.ts`→unit, `.test.tsx`→ui, `.browser.test.tsx`→browser.

## Integration Points
parseEnvelope hardening (wsClient.ts) + socket-path tests (WsProvider/wsClient). No server/sim/optimizer change.
</code_context>

<specifics>
## Specific Ideas
DEFAULT_SPEED = {multiplier:1, tickIntervalMs:500, simSpeed:120, paused:false}; warn-once module flag; mock WebSocket for socket-path tests.
</specifics>

<deferred>
## Deferred Ideas
Consolidating the two ws connections in web App (v1.0 tech debt) — out of scope for HRD-01/QA-01.
</deferred>
