# Plan 19-01 Summary — Wave 0 RED test stubs

**Status:** complete · **Wave:** 1 · **Requirements:** DET-01/02, CONT-01/02/03/04

## What landed
Five test files defining the Phase-19 contracts before any implementation:
- `packages/simulation/test/open-ended.unit.test.ts` — CONT-01/02 (open-ended loop, self-rescheduling) + VQ#2 tie-break verification.
- `packages/simulation/test/determinism.unit.test.ts` — appended DET-02 10k-tick SHA-256 golden block (placeholder) + DET-01 flags-off regression cases.
- `packages/api/test/lru-map.unit.test.ts` — CONT-04c LruMap eviction (RED via dynamic import of not-yet-existing module).
- `packages/api/test/snapshots.unit.test.ts` — CONT-04b backpressure guard (RED; expects `shouldSendToSocket` + `BACKPRESSURE_BYTES`).
- `packages/api/test/ws-envelope.unit.test.ts` — CONT-03 `deriveSimDay` derivation (RED; expects exported helper).

## Result
`pnpm typecheck` green (one `@ts-expect-error` on the lru-map import, later removed in 19-06). RED tests fail with clear messages; GREEN immediately: VQ#2 tie-break, DET-01 flags-off, existing 8 determinism tests.
