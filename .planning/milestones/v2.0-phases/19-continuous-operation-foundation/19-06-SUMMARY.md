# Plan 19-06 Summary — LruMap optimizer memo + watermark verify

**Status:** complete · **Wave:** 2 · **Requirements:** CONT-04(a,c)

## What landed
- `packages/api/src/optimizer/lru-map.ts` (NEW): `LruMap<K,V>` — cap-bounded LRU on the ES6 `Map` insertion-order guarantee (`get` promotes to MRU; `set` evicts the oldest over cap). No deps.
- `packages/api/src/optimizer/rolling-service.ts`: `memo = new LruMap<string, EpochResult>(500)` (drop-in for the unbounded `Map`) + `memoSize()` testability accessor.
- `packages/api/test/lru-map.unit.test.ts`: 6/6 GREEN (removed the now-unnecessary `@ts-expect-error`).
- `packages/api/test/rolling-service.unit.test.ts` (NEW): memo stays bounded at 500 after 600 distinct `runOnce` calls; a memoized re-run does not grow the memo.

## CONT-04a watermark (verify-only)
`runCatchup` already reads from `projection_checkpoints.last_seq` (not `0n`). `projections-audit-geo.int` + `optimizer-rolling.int` GREEN (10 tests) — confirms the watermark works and the LruMap drop-in didn't regress the optimizer.

## Result
build/typecheck clean; lint 0 errors (also cleaned now-unnecessary assertions in the 19-01 stub tests); affected unit suites 24/24 GREEN.
