# Plan 01-01 — Walking Skeleton — Summary

**Phase:** 1 — Operational Data Foundation + Live Map Spike
**Plan:** 01-01 (Walking skeleton: monorepo + OrbStack Postgres + one event → inline projection → API read → live OSM map)
**Winner:** rival #2 (`wt/p1-01-r2`, `53f6a4b657b8fd4e4a3a024f8f59f3fe84242101`)
**Integrated:** merged `--no-ff` into `feature/phase-1-operational-data-foundation-live-map-spike`.

## What Shipped

An end-to-end vertical spine, proven by real-Postgres integration tests and a Playwright e2e:

1. A `HubRegistered` domain event is appended to an append-only Postgres `events` table
   under optimistic concurrency (`UNIQUE(stream_id, version)` + a `SELECT max(version)`
   pre-check, with SQLSTATE `23505` → `ConcurrencyError` as the durable safety net).
2. An **inline projection** upserts the `hubs` read model in the **same transaction**
   (read-your-writes); the reducer is a pure function and idempotent on re-apply.
3. Fastify `GET /hubs` (factory `buildApp(db)`, plus `GET /health`) serves the projection.
4. A React 19 + OpenLayers 10 web app renders an OSM USA basemap with one real hub marker
   (Memphis, 35.1495 / -90.0490), `ol/Map` created once in a ref, a single reused
   `VectorSource`, disposed on unmount, with `data-hub-count` for leak assertions.

## Packages (downward-only deps)

`domain` (zero-dep, zod-validated event union) ← `projections` / `simulation` /
`event-store` ← `api` ← `web` (type-only). Tooling: pnpm workspaces + Turborepo 2.9,
TypeScript 5.9 strict (no `any`, ESLint 9 flat), Vitest 4 (unit + integration projects),
Testcontainers Postgres 17 on OrbStack, `docker-compose.yml` for a local DB.

## Gate Results (re-verified post-merge, all green)

| Gate | Command | Result |
|---|---|---|
| Install | `pnpm install` | PASS (cosmetic cyclic-workspace WARN only) |
| Build (6 pkgs, strict TS) | `pnpm -r build` | PASS, 0 errors |
| Lint | `pnpm lint` | PASS, 0 errors |
| Tests (unit + integration) | `pnpm test:all` | PASS — 15/15 (11 unit + 4 real-Postgres integration) |
| Web build | `pnpm --filter @mm/web build` | PASS |

## Integration Notes

- **Merge-only fix:** added `**/.remember/**`, `**/.turbo/**`, `**/.playwright-mcp/**`
  to `eslint.config.js` `ignores` (mirroring `.gitignore`). A stray local agent-memory
  file in the main working tree (`.remember/tmp/last-ndc.ts`) was outside the typed TS
  project and broke `pnpm lint`; this file does not exist in the rival worktrees and is
  not part of the shipped code. No test or lint rule was weakened.
- **Version pins (drift to track):** this slice pins `react`/`react-dom` `19.2.7` and
  `vite` `7.3.5` (vs rival #1's `19.2.0` / `7.1.12`). Both within STACK ranges. As the
  only slice on the phase branch, there is no sibling pin to align against yet — align
  if a later slice pins differently.

## Carried-Forward Risks (from judge; do NOT re-litigate scope here)

1. OCC is read-then-write guarded by the `UNIQUE(stream_id, version)` constraint (correct
   for Phase 1 single-writer sim). Consider an atomic conditional CAS append if Phase 2+
   introduces concurrent writers.
2. Web e2e exercises the in-place source-update / resize re-render path but not a full
   unmount/dispose loop — strengthen leak coverage in a later slice.
3. No deterministic golden-replay test yet (rebuild-from-`readAll` == live). Add before
   relying on rebuildable read models.

## Out of Scope (deferred — `HubRegistered`-only slice)

Any event beyond `HubRegistered`; WS realtime + live trailer points; route LineStrings;
the full SIM tick engine; async catch-up projection poller + checkpoints + golden-replay
CI test. SIM-01 ships the static ~10 US metro hub network model; the map shows the single
Memphis hub. See SKELETON.md for the full deferral list and subsequent-slice plan.
