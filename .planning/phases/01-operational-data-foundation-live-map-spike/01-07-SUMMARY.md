# Plan 07 Summary — Live OpenLayers USA map (rival 1)

**Branch:** wt/p1-07-r1 · **Requirements:** VIZ-01

## What shipped

The full live map (`@mm/web`), superseding the Plan 01 `SkeletonMap` behind the
web entry. OpenLayers 10 + OSM USA basemap rendering all ~10 hub markers, all
linehaul route LineStrings, and simulated trailers as LIVE points fed by the
`@mm/api` `/ws` snapshot channel — with the validated single-reused-source,
in-place-update, dispose-on-teardown discipline (PITFALLS P10).

### Task 1 — Static map: OSM basemap + hubs + routes
- `src/api/client.ts` — `fetchHubs` / `fetchRoutes`, typed against the Plan 06
  `HubDto` / `RouteDto` contracts, over the same-origin `/api` prefix.
- `src/map/layers.ts` — `createHubLayer`, `createRouteLayer`, `createTrailerLayer`,
  each backed by ONE reused `ol/source/Vector` (`useSpatialIndex: true`) and a
  SINGLE shared `Style` instance per layer (no per-feature style allocation).
- `src/map/MapView.tsx` — the `ol/Map` + every `VectorSource` held in `useRef`
  (never React state), created EXACTLY ONCE. OSM source with
  `crossOrigin: 'anonymous'`; view centred on the continental USA (zoom 4). On
  mount it fetches hubs + routes and inserts the hub/route layers UNDER the
  trailer layer. On unmount it clears every vector source, `setTarget(undefined)`,
  disposes the map, and aborts the in-flight geo fetch.
- `src/App.tsx` / `index.html` — thin shell over `MapView` (title de-skeletoned).
- `vite.config.ts` — `/api` proxy now forwards the `/api/ws` upgrade (`ws: true`)
  so live trailers work under `pnpm dev` (human-verify).

### Task 2 — Live trailer points + leak guard
- `src/map/useTrailerSnapshots.ts` — `useTrailerSnapshots(onSnapshot)`: opens the
  `/api/ws` WebSocket once, parses `{ t:'snapshot', trailers:[...] }` with a
  read-side guard, and pushes each snapshot to a ref-held handler — so snapshots
  flow to the OL map OFF the React render path (no re-render storm). Socket closed
  on unmount.
- `src/map/layers.ts` — `updateTrailerFeatures(source, trailers)` upserts one
  Point feature per `trailerId`: existing features mutate geometry IN PLACE via
  `getGeometry().setCoordinates(...)`; new ones are created + `setId` + added. The
  source is NEVER cleared/rebuilt, so the feature count stays bounded to the fleet
  size. No interpolation/animation (deferred to Phase 5) — points jump to latest.

## Tests (strict TDD — RED → GREEN, guard proven non-vacuous)
- `test/map.e2e.ts` (Playwright): stubs `/api/hubs`, `/api/routes`, and the `/ws`
  channel; asserts the OSM basemap loads over HTTPS, ALL hub markers + ALL route
  lines render, the map is created once, and counts are stable across a re-layout.
- `test/leak.e2e.ts` (Playwright): drives 40 ws snapshots over a stubbed
  `routeWebSocket`; asserts the trailer source feature count stays equal to the
  fleet size (no growth), the map + trailer source are each created once, AND the
  OL uid of a stable trailer feature is unchanged across all snapshots — proving
  TRUE in-place mutation, not recreation. Verified the guard fails RED when the
  impl is regressed to recreate features each tick.
- The superseded Plan 01 skeleton (`SkeletonMap.tsx`, `hubs.ts`,
  `skeleton-map.e2e.ts`) was removed (its assertions — "1 hub" / Memphis-only —
  no longer hold under the full map).

## Gates (run from the worktree)
- `pnpm install` — OK
- `pnpm -r build` — OK (all 6 packages)
- `pnpm lint` — OK (no `any`, no unsafe)
- `pnpm test:all` — OK (18 files, 116 tests; incl. real Postgres integration on
  OrbStack via the Testcontainers fixture; golden replay green)
- `pnpm --filter @mm/web build` — OK
- `pnpm --filter @mm/web test:e2e` — OK (2/2: map + leak guard)

## Integration re-verification (merge into feature branch)

Merged into `feature/phase-1-operational-data-foundation-live-map-spike` via
`git merge --no-ff e514c5b` (rival #1) — no conflicts. All gates re-run GREEN in
the main repo against real infra:
- `pnpm install` — OK (lockfile up to date)
- `pnpm -r build` — OK (6/6 packages)
- `pnpm lint` — OK (0 errors)
- `pnpm test:all` — OK (18 files, 116 tests; real Postgres via Testcontainers on
  OrbStack)
- `pnpm --filter @mm/web build` — OK (single ~508 kB chunk; non-blocking Vite
  chunk-size warning, code-splitting deferred — YAGNI for the demo)
- `pnpm --filter @mm/web test:e2e` — OK (2/2: map static layers + leak guard,
  both VIZ-01)

No merge-only breakage; no test weakening required.

## Notes / carried items
- The web e2e is fully hermetic: HTTP + ws boundaries are stubbed at the network
  level (Playwright `route` + `routeWebSocket`), so it needs no API/DB/sim.
- OSM tile DoS (T-01-23) is accepted at demo scale; a local tile cache is deferred
  to Phase 5, as is smooth interpolation/animation (this slice is jump-to-latest).
- The human-verify checkpoint (`pnpm dev` against live API + sim) is the remaining
  manual confirmation of live on-screen motion + flat memory over a multi-minute
  run.
