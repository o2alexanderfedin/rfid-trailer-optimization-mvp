# Handoff (2026-06-23)

## Both sub-projects DONE — on `develop`, NOT pushed
**SP1 — Paced-loop redesign** (`34f02cc`): accumulator pacer (speed=sim-time/frame) + worker_threads optimizer (inline default) + per-frame fold-batching + maxTicksPerFrame 32→4. Gate green; browser-verified (1×–64×, no freeze).

**SP2 — Rest/fuel stops + optimizer fuel-awareness** (`eb65a75`): visible mid-route rests (reuse HOS) + refuels; opt-in `FuelConfig` (off ⇒ golden byte-identical); odometer uses ORS road `distance_m` (shared basis w/ twin+projection); optimizer `Stop.refuelMin` folded as `max(restMin,refuelMin)`. Built via rival subagents (judge→rival-2) + 5 review fixes (typecheck×4, int-test timeout, mid-leg interpolation, ORS odometer). Gate GREEN: build 10/10, **typecheck 0**, unit 1291, ui 214, integration 97, lint clean. Determinism keystones intact.

## Verification gap (low risk)
- Live BROWSER visual of parked/refueling trucks NOT captured this session (Playwright browser locked from pre-resume instance). End-to-end path is proven by `fuel-stops-live.int.test.ts` (events→projections→keyframes→twin→fuel-aware timing) + ui tests + the interpolation fix. Demo was running at :5173. To eyeball: run the demo (below) + open :5173; or retry browser with an isolated profile.

## Demo run (FRESH DB each run — dirty DB → OCC conflicts)
`docker compose down -v && docker compose up -d` → `export DATABASE_URL=postgres://mm:mm@localhost:5432/mm` → `OPTIMIZER_EXECUTION=worker FLEET_PER_SPOKE=3 FUEL_ENABLED=1 pnpm --filter @mm/api demo` (:3001; `pnpm build` first so worker dist is current) → `pnpm --filter @mm/web dev` (:5173). Speed: `POST /sim/speed {multiplier|paused}`.

## Open follow-ups (out of scope, flagged)
- `develop` ahead of origin by SP1+SP2 merges — NOT pushed (push on request / release).
- Detection pass + twin-snapshot full-log refold slow on very long runs (pre-existing/LOW) — memory: detection-cost-scales-with-state.
- Memory: typecheck-gate-separate-from-build-lint (include `pnpm typecheck` in gates), paced-loop-redesign.
- Pre-existing uncommitted .remember/.planning bookkeeping + untracked demo-01..09 PNGs predate this work.
