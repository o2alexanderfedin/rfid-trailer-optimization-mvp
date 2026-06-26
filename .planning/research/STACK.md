# Stack Research — v3.0 "Continental OODA Network" (additions only)

**Domain:** Continental-scale middle-mile logistics simulation (event-sourced, deterministic, golden-replay)
**Researched:** 2026-06-26
**Confidence:** HIGH (versions registry-verified; dataset licenses checked; OL primitives Context7/docs-confirmed)

> **Scope guard.** This is a SUBSEQUENT-milestone stack note. The v1.0–v2.1 stack
> (TS 5.9 strict / Node 22 / pnpm 10 + Turborepo 2.9 / Fastify 5 + @fastify/websocket + ws /
> PostgreSQL + Kysely 0.29 + pg 8.22 / OpenLayers 10.9 + React 19 + Vite 7 / Vitest 4 /
> custom SSP min-cost-flow + custom VRPTW) is **already shipped and is NOT re-evaluated here**.
> This file covers ONLY what the four v3.0 capabilities need. The repo's standing bias —
> *prefer static data + custom TS over heavy runtime deps* (it already rejected graphology/ngraph
> for a hand-rolled time-expanded graph) — drives every recommendation below.
> (The v2.0 edition of this file is in git history at commit `e22020e`.)

## TL;DR Recommendation

| v3.0 need | Recommendation | New runtime dep? |
|-----------|----------------|------------------|
| **1. Big-city dataset** | **Vendor a static, pre-curated JSON** (build-time script consumes SimpleMaps US Cities *Basic* CSV, or `all-the-cities` GeoNames extract → emit a committed `us-big-cities.generated.json`). Pick top 1–3 metros/state at **build time**, not runtime. | **NO** at runtime (data is a committed `.json`); a dev-only generator dep at most |
| **2. Great-circle geometry** | **Keep the hand-rolled `greatCircle`** in `routes.ts`. Do NOT adopt `@turf/*` or `geodesy`. | **NO** |
| **3. OL at 100+ hubs** | **Already have it** — `ol` 10.9.0. Use built-in `ol/source/Cluster` + style-level `declutter` for hub labels; standard Canvas vector renderer. **Skip WebGL points.** | **NO** (uses installed `ol`) |
| **4. Async queue** | **Vendored `@alexanderfedin/async-queue` 1.1.0** wired as a workspace/`file:` dep for **runtime plumbing ONLY**. Keep its Jest config out of our Vitest build. | Yes, but **plumbing only — banned from the deterministic sim core** |

**Net new heavy runtime deps for v3.0: ZERO.** Everything is static data, existing libs, or a single zero-dep vendored queue confined to non-deterministic plumbing.

---

## 1. Big-city dataset

### Requirement recap
A static US big-cities table — `{ name, state, lat, lon, population|rank }` — to deterministically pick 1–3 hubs/state (~80–130 hubs). **No network, no clock, no RNG at runtime.** Must be golden-reproducible exactly like today's 10 IATA hubs (`hubs.ts` is a hand-typed `readonly Hub[]`).

### The determinism rule that decides the architecture
The selection (which cities become hubs, hub ids, ordering) must be **frozen into a committed artifact**, identical to how `road-geometry.generated.json` and the `USA_HUBS` constant already work. Therefore the dataset is a **build-time input to a generator script**, and the runtime imports only a committed `us-big-cities.generated.json` (or a hand-typed `.ts` const). **No city-data npm package is ever imported by the sim/runtime.** This sidesteps every "did the upstream package change?" determinism risk.

### Candidate datasets (registry + license verified 2026-06-26)

| Dataset | Form | License | Has pop + lat/lon + state? | Size | Verdict |
|---------|------|---------|----------------------------|------|---------|
| **SimpleMaps US Cities — Basic** | CSV/XLSX download | CC BY 4.0; free/Basic tier requires a **backlink to simplemaps.com/data/us-cities** from a public page | YES — `city, state_id (2-letter), state_name, lat, lng, population, ranking, density, timezone` | ~30k rows (free Basic), single CSV | **RECOMMENDED primary.** Cleanest schema: 2-letter `state_id`, `population`, `ranking`, IANA `timezone` (useful for region partition), and curated dedup of metros. |
| **`all-the-cities` (npm 3.1.0)** | npm package, MIT, GeoNames-derived | MIT (code) over GeoNames **CC BY 4.0** data | YES — `name, country, adminCode, population, loc:[lon,lat]` | 6.4 MB unpacked, 138k world cities | **RECOMMENDED fallback / fully-offline path.** Pure npm, no website backlink. Downside: `adminCode` for US is a **GeoNames admin1 code, NOT the 2-letter postal abbrev** → you must map admin1→state at build time; world-wide so you filter `country === "US"`. |
| **GeoNames `cities1000` dump** | raw TSV (`download.geonames.org`) | CC BY 4.0 (attribution: link to geonames.org) | YES — tab-delimited, admin1 codes | ~130k cities (zip) | Use only if you want to control filtering yourself; same admin1→state mapping chore as `all-the-cities`. Network download = a **build-time** step, never runtime. |
| `cities.json` (npm 1.1.59) | npm, CC-BY-4.0 | CC BY 4.0 | partial — world cities, **no population** in core | 19 MB unpacked | **Reject** — no population (can't rank "big" cities); huge. |
| `cities` (npm 2.0.0), `us-cities` (0.0.1) | npm, MIT | MIT | thin / stale (2022) | small | **Reject** — too thin / unmaintained, no reliable population ranking. |

### State metadata helper (region/timezone partition for regional centers)
For the **regional-center partition** (feature 2 below — group states into regions/timezones), pin a tiny static state-metadata table. Two options, both build-time:
- **`us` (npm 2.0.0, MIT)** — maps each state to 2-letter abbrev, FIPS, name, and **Census region/division**. Use it in the generator script (or just transcribe its 50-row table into a committed const — it's 50 rows). **Dev-only or transcribed; not a runtime dep.**
- Or hand-author a `STATE_REGION` const (50 entries, postal→{region, tz}) directly in the generator. Given the repo's "static const like `USA_HUBS`" pattern, **transcribing is the most determinism-safe and dependency-free choice.**

### Recommended vendoring pattern (deterministic)
1. **`scripts/generate-hubs.ts`** (offline, dev-only, mirrors the existing `scripts/precompute-routes.ts` pattern):
   - Reads the SimpleMaps Basic CSV (committed under `scripts/data/` or fetched once and committed) **or** imports `all-the-cities` filtered to `country==="US"`.
   - Maps to `{ name, state(2-letter), lat, lon, population, rank }`.
   - Sorts by population per state, takes top 1–3 per state (a fixed, documented rule — e.g. "rank-1 always; rank-2 if pop ≥ T₂; rank-3 if pop ≥ T₃"), assigns **stable deterministic hub ids** (e.g. a slug or a curated IATA-like 3-letter code), emits `packages/simulation/src/network/us-big-cities.generated.json` with a **coords checksum** field exactly like `hubCoordsChecksum` / `road-geometry.generated.json` already do (drift guard).
2. **Runtime** (`hubs.ts`) imports the committed JSON and `as const`-asserts it into `readonly Hub[]`. No clock/RNG/network — byte-identical replay preserved.
3. **Attribution:** if SimpleMaps Basic is used, add the required backlink to the web app footer / README (CC BY 4.0 + their backlink clause). If `all-the-cities`/GeoNames is used, add a "city data © GeoNames, CC BY 4.0" credit. **Flag this for the roadmap as a non-optional compliance task.**

> **Determinism flag:** the *only* safe place for any city dataset is the build-time generator.
> Importing a city-data package at runtime (even a static one) couples replay to an upstream
> version bump. The committed-JSON-with-checksum pattern is already proven in this repo — reuse it.

---

## 2. Great-circle geometry — KEEP THE CUSTOM ONE

### Decision: do NOT adopt a library. Keep `greatCircle` in `packages/simulation/src/network/routes.ts`.

The repo already has a **correct, pure, dependency-free** slerp implementation (`toVec3`/`toLonLat`/`greatCircle`) that:
- returns exact endpoints (anchors geometry at hub coords — critical for the ws/OL animation seam),
- handles the near-coincident degenerate case (linear fallback),
- is a pure function of its args (no clock/RNG/I/O) → **byte-identical golden replay**, which is the whole milestone keystone.

### Why a library loses here

| Option | Version (verified) | License | Cost | Determinism risk | Verdict |
|--------|--------------------|---------|------|------------------|---------|
| **Custom `greatCircle` (existing)** | — | repo | 0 deps, ~40 LOC, already tested | **None** (pure) | **KEEP** |
| `@turf/great-circle` | 7.3.5 | MIT | pulls `arc` + `@turf/helpers` + `@turf/invariant` + `@types/geojson` + `tslib` | new transitive surface; outputs GeoJSON Feature (impedance mismatch with the `LonLat[]` the sim already uses); **antimeridian-splitting MultiLineString behavior** would change geometry vs current goldens | **Reject** |
| `@turf/turf` (full) | 7.3.5 | MIT | ~entire turf monorepo as deps | huge for one function | **Reject** |
| `geodesy` | 2.4.0 | MIT | last published **2022-06-18** (stale); 271 KB | great accuracy (Vincenty) but **different numerical results** than current slerp → would invalidate goldens for zero demo benefit | **Reject** |

**Scale reality:** v3.0 has ~hundreds of legs (≤~130 spokes + a small inter-center backbone), each sampled at `ROUTE_POINTS = 24`. That's a few thousand slerp evals computed **once at startup** — the custom function is more than fast enough. A library buys nothing and threatens the golden baseline.

**Bundle-size lens (web):** great-circle geometry is computed **server-side** in `@mm/simulation` and shipped to the client as plain coords over ws — so the client bundle is unaffected regardless. There is no web-bundle argument for turf/geodesy here either.

> **Determinism flag:** swapping the great-circle implementation = changing route geometry =
> new goldens for *flags-off* too. That breaks the "flags-off byte-identical to v2.0" guarantee.
> **Do not touch `greatCircle`.** New multi-center legs simply reuse the existing function.

---

## 3. OpenLayers at 100+ hubs — already in-stack, use built-ins

### You already have the right version: `ol` 10.9.0 (verified latest; **no OL 11 exists yet**).

**Reality check on scale:** 100–130 hub point features + a few hundred backbone/spoke LineStrings + a handful of suggestion overlays is **small** for OpenLayers' standard Canvas vector renderer. WebGL is for *tens of thousands to hundreds of thousands* of points. The actual problem at this scale is **visual clutter** (overlapping hub labels/markers), not render throughput.

### What OL 10.9 offers (Context7-resolved `/openlayers/openlayers`; docs-confirmed)

| Tool | What it does | Use for v3.0? |
|------|--------------|---------------|
| **`ol/source/Cluster`** | Wraps a vector source; merges nearby point features into cluster features within a pixel `distance`. Style the cluster with a count badge; expands as you zoom in. | **YES** — primary clutter control for hub markers at continental zoom. Standard, stable API in 10.9. |
| **Style `declutter: true`** (vector layer / per-style) | Hides overlapping labels/icons, keeping the highest-priority ones readable. Works on the Canvas renderer. | **YES** — for hub *name labels* and suggestion badges so they don't overprint. Combine with Cluster (cluster the dots, declutter the text). |
| **Standard Canvas `VectorLayer`** | Instruction-based renderer with caching; trivially handles a few hundred features. | **YES** — backbone/spoke LineStrings + animated trailers stay on the existing `postrender`/`getVectorContext` path (unchanged from v1–v2). |
| **`WebGLPointsLayer` / WebGL points renderer** | GPU instanced quads for *huge* point counts; optimized for 10k–100k+ points. | **NO** — overkill at 130 hubs; loses easy per-feature canvas styling, label/declutter integration, and the existing animation approach. **Skip it.** |

### Recommended viz approach
- **Hub markers:** `VectorLayer` over `Cluster` source. Tune cluster `distance` so a continental zoom shows regional groupings; individual hubs separate on zoom-in. Cluster style shows a count; single-feature style shows the hub dot + (decluttered) label.
- **Backbones & spokes:** plain `VectorLayer` of LineStrings (great-circle geometry from feature 2), styled by tier (inter-center backbone vs spoke) and state. No clustering.
- **Trailers:** unchanged — keep the proven `postrender` + `getVectorContext` keyframe-tween path; do **not** migrate trailers to WebGL (would fork the animation model and risk the smooth-motion work already proven in v1–v2).
- **Suggestion overlays** (`ActionSuggested` from coordinators): a separate lightweight `VectorLayer` (or `ol/Overlay` for HTML badges) with `declutter` so advisory markers don't pile up; toggle via the existing flag-gating.

> **No new dependency.** All of the above is in `ol` 10.9.0. `ol-ext` (the community extension
> set) is **not** needed for clustering/declutter and would add surface area for no v3.0 benefit.

---

## 4. Async queue — vendored, plumbing-only, Jest-isolated

### What it is
`vendor/async-queue` = `@alexanderfedin/async-queue` **1.1.0**, MIT, **zero runtime deps**, single `src/index.ts`, CJS build (`main: dist/index.js`, `types: dist/index.d.ts`), Node ≥12. O(1)-memory bounded circular-buffer producer/consumer with backpressure (`enqueue` blocks when full, `dequeue` blocks when empty), async-iterator support, graceful close/drain. **Note:** the vendored copy has **no committed `dist/`** today — its `main`/`types` point at a build output that must be produced (or repointed at `src`).

### The hard determinism boundary (restate + enforce)
It is **Promise/microtask-based**. Microtask interleaving is **not** part of the seeded, tick-driven, golden-replay model. Therefore:

> **BANNED from the deterministic sim core** (`@mm/simulation` engine, `@mm/domain` reducers,
> `@mm/projections` folds, `@mm/optimizer` pure planning, anything that feeds a golden).
> **ALLOWED only in runtime plumbing** that lives *outside* the replayable event stream:
> worker↔optimizer handoff, **ws backpressure** (server→client diff throttling),
> continuous-mode **chunk handoff**, and **DB write-batching** of projection upserts.
> These are I/O/scheduling concerns, not model decisions — they don't enter the event log.

A practical guard: only `@mm/api` (and possibly a continuous-loop runner) may import it. Add an ESLint `no-restricted-imports` rule forbidding `@alexanderfedin/async-queue` inside `@mm/simulation`/`@mm/domain`/`@mm/projections`/`@mm/optimizer` to make the ban mechanical (matches the repo's "enforce constraints with lint" habit).

### How to wire a vendored (non-`packages/*`) submodule into this pnpm workspace

The workspace globs only `packages/*` (`pnpm-workspace.yaml`), so `vendor/async-queue` is **not** auto-discovered. Three wiring options, ranked:

1. **RECOMMENDED — add `vendor/*` to the workspace, consume via `workspace:*`.**
   - `pnpm-workspace.yaml`:
     ```yaml
     packages:
       - "packages/*"
       - "vendor/*"
     ```
   - In the consumer (e.g. `packages/api/package.json`): `"@alexanderfedin/async-queue": "workspace:*"`.
   - **Resolve the missing dist:** its `main`/`types` point at `dist/`, which is **not committed**. Either: (a) run its `tsc` build as a pre-step and **commit `dist/`** (simplest; matches "static committed artifact" ethos), or (b) point the package's `main`/`types` at `src/index.ts` and let our Vite/tsx/Vitest transform the TS directly (cleaner, no build step — but then *our* TS config governs it).
   - Turborepo: it will be picked up as a workspace pkg; either give it a `build` task or mark it as having no build if you consume `src` directly.

2. **`file:` link** — consumer dep `"@alexanderfedin/async-queue": "file:../../vendor/async-queue"`. Works without touching the workspace glob, but pnpm treats it more like an external tarball; **less ergonomic for HMR/incremental** than `workspace:*`. Use only if you want to keep it out of the workspace graph entirely.

3. **Direct path import** (`import { AsyncQueue } from "../../vendor/async-queue/src/index.js"`) — avoid; brittle, bypasses package boundaries and type resolution.

### Keeping its Jest setup OUT of our Vitest build (the explicit ask)
The vendored package ships `jest.config.js`, `ts-jest`, `@types/jest`, a `test/` dir, and `benchmark/` — none of which must enter our build or test graph.

- **`pnpm install` does NOT run its `test`/Jest scripts** — only lifecycle scripts (`prepare`/`postinstall`); this package has none that run Jest, so install is clean. Its `devDependencies` (jest, ts-jest, @types/jest, ts-node, benchmark) install into *its own* `node_modules` and never leak into ours.
- **Vitest never sees its tests:** our `vitest.config.ts` `include` globs are scoped to `packages/*/src/**` and `packages/web/**` (no `vendor/**`), so `vendor/async-queue/test/**/*.test.ts` is **out of every project**. Belt-and-suspenders: add `vendor/**` to each project's `exclude` and to the root `eslint` ignore so its `test/`/`benchmark/` files are never linted or type-checked by our gates.
- **Don't import its tests/benchmarks:** consume only the package entry (`AsyncQueue` from the built `dist/` or `src/index.ts`). The `files` allowlist in its `package.json` already ships only `dist/`, `LICENSE`, `README` for publish — but since we're vendoring the whole repo, the exclude rules above are what actually keep `test/`/`jest.config.js`/`ts-jest` out of our pipeline.
- **TS interop:** its `tsconfig` is `module: commonjs` / `target: ES2020`. Our base is `NodeNext` ESM. If you consume the built CJS `dist/` + `.d.ts`, `esModuleInterop` (already on in `tsconfig.base.json`) handles the default/named import cleanly. If you instead consume `src/index.ts` directly, note it must satisfy our stricter flags (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`) — committing its prebuilt `dist/` avoids subjecting vendored code to our stricter typecheck gate. **Prefer committing `dist/`.**

---

## Installation

```bash
# (1) Big-city dataset — NO runtime dep. Dev-only generator inputs:
#   Option A (SimpleMaps): download Basic CSV once, commit under scripts/data/, add backlink attribution.
#   Option B (offline npm, build-time only):
pnpm add -D -w all-the-cities          # 3.1.0, MIT (GeoNames CC BY 4.0) — used by scripts/generate-hubs.ts ONLY
pnpm add -D -w us                      # 2.0.0, MIT — state→region/tz table for the generator (or transcribe it)
#   -> emits committed packages/simulation/src/network/us-big-cities.generated.json (with coords checksum)

# (2) Great-circle: NOTHING. Keep packages/simulation/src/network/routes.ts greatCircle.

# (3) OpenLayers: NOTHING new — ol@10.9.0 already installed (Cluster + declutter are built in).

# (4) Async queue: vendored, plumbing-only.
#   pnpm-workspace.yaml: add "vendor/*"
#   packages/api/package.json: "@alexanderfedin/async-queue": "workspace:*"
#   (build + commit vendor/async-queue/dist, OR point main/types at src and let our transform handle it)
```

> **All four "new" capabilities add ZERO new heavy runtime dependencies.** Dataset packages, if used
> at all, are **devDependencies feeding a build-time generator**; the runtime imports a committed JSON.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Static committed `us-big-cities.generated.json` from a build-time generator | Runtime import of a city-data npm package | Never for this repo — couples golden replay to an upstream version; the committed-JSON+checksum pattern already exists (`road-geometry.generated.json`). |
| SimpleMaps US Cities Basic (clean 2-letter state, pop, rank, tz) | `all-the-cities` (npm, MIT/GeoNames) | If you want a **fully offline npm-only** input with no website backlink; accept the GeoNames admin1→postal mapping chore. |
| Custom `greatCircle` (existing) | `@turf/great-circle` 7.3.5 / `geodesy` 2.4.0 | Never here — different numerics break flags-off goldens; turf adds transitive deps + GeoJSON impedance + antimeridian-split behavior; geodesy is stale (2022). |
| `ol/source/Cluster` + `declutter` (Canvas) | `WebGLPointsLayer` | Only at **tens of thousands+** of points. At ~130 hubs it's overkill and loses per-feature styling/label integration. |
| `@alexanderfedin/async-queue` as `workspace:*` (vendor in glob) | `file:` link | If you specifically want it OUT of the workspace graph; less ergonomic for incremental builds. |
| Consume vendored **prebuilt `dist/` (commit it)** | Consume `src/index.ts` directly | Use `src` only if you accept subjecting vendored code to our stricter TS flags; committing `dist/` keeps it off our typecheck gate. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@turf/turf` / `@turf/great-circle` / `geodesy` for arcs | New deps + different numerics → **invalidates flags-off goldens** for zero benefit; turf is GeoJSON-shaped (impedance mismatch) and splits at the antimeridian | Existing pure `greatCircle` in `routes.ts` |
| Importing **any** city dataset at **runtime** (sim/`@mm/domain`) | Replay determinism becomes hostage to upstream data updates; clock/version coupling | Build-time generator → committed `us-big-cities.generated.json` (+ checksum) |
| `cities.json` (npm) | 19 MB, **no population** → can't rank "big" cities | SimpleMaps Basic or `all-the-cities` |
| `cities` / `us-cities` (npm) | Thin, stale (2022), unreliable population | SimpleMaps Basic or `all-the-cities` |
| `WebGLPointsLayer` for hubs | Overkill at ~130 points; forks styling/animation model; loses declutter/label integration | Canvas `VectorLayer` + `ol/source/Cluster` + `declutter` |
| `ol-ext` for clustering/declutter | Unneeded extra surface — core OL 10.9 already has both | Built-in `ol/source/Cluster` + style `declutter` |
| `@alexanderfedin/async-queue` **inside the sim core** (`@mm/simulation`/`@mm/domain`/`@mm/projections`/`@mm/optimizer`) | **Promise/microtask scheduling is non-deterministic** → breaks seeded golden replay | Confine to `@mm/api` plumbing (ws backpressure, worker handoff, DB batching); enforce with ESLint `no-restricted-imports` |
| Pulling vendor `test/`/`jest.config.js`/`ts-jest` into our build | Jest stack conflicts with our Vitest 4 gates; bloats typecheck | Add `vendor/**` to Vitest `exclude` + ESLint ignore; consume only the package entry |

## Stack Patterns by Variant

**If you choose SimpleMaps Basic (cleanest schema):**
- Generator reads the committed CSV; `state_id` is already 2-letter; `ranking`/`population` drive the per-state top-1–3 rule; `timezone` feeds the regional-center partition.
- **Mandatory:** add the SimpleMaps backlink (CC BY 4.0 + Basic-tier clause) to the web footer/README — make it a roadmap task.

**If you choose `all-the-cities`/GeoNames (offline, npm-only):**
- Generator filters `country === "US"`, maps GeoNames **admin1 → 2-letter state** (build a 50-row admin1→postal map — pair with `us`/transcribed const), then top-1–3 per state by `population`.
- Add "city data © GeoNames (CC BY 4.0)" attribution.

**Regardless of source:**
- Emit a `hubCoordsChecksum`-style digest in the generated file (drift guard, mirrors `road-geometry.generated.json`).
- New multi-center legs (spoke→nearest-center, inter-center backbone) reuse the existing `greatCircle` + `routeId` + `buildRoutes` machinery — `buildRoutes` is generalized from single-center to multi-center, but the **geometry primitive is unchanged**.

## Version Compatibility

| Package | Version (verified 2026-06-26) | Compatible With | Notes |
|---------|-------------------------------|-----------------|-------|
| `ol` | **10.9.0** (latest; no 11.x) | React 19, Vite 7 (already in `@mm/web`) | `Cluster` + style `declutter` are stable built-ins; keep the map in a ref, drive imperatively (existing pattern). |
| `all-the-cities` | **3.1.0**, MIT (GeoNames CC BY 4.0) | Node 22 (dev/build-time only) | 6.4 MB; `loc` is `[lon,lat]`; US `adminCode` is GeoNames admin1, needs mapping. Dev dep ONLY. |
| `us` | **2.0.0**, MIT | Node 22 (dev/build-time only or transcribed) | State→postal/FIPS/Census-region table. |
| SimpleMaps US Cities Basic | current free CSV | n/a (committed CSV → generator) | CC BY 4.0; Basic tier needs a backlink to simplemaps.com/data/us-cities. |
| `@alexanderfedin/async-queue` | **1.1.0**, MIT, 0 runtime deps | Node ≥12 (runs on 22); CJS `dist` + `.d.ts` | `esModuleInterop` (already on) handles the CJS default/named import. **Commit `dist/`** (none today) to keep vendored code off our stricter typecheck gate. |
| `@turf/great-circle` | 7.3.5, MIT | — | **NOT adopted** (listed for completeness; pulls `arc`+turf helpers, antimeridian split). |
| `geodesy` | 2.4.0, MIT, **stale 2022** | — | **NOT adopted.** |

## Sources

- npm registry (`npm view`, 2026-06-26) — verified: `ol` 10.9.0 (latest, no 11.x), `@turf/turf`/`@turf/great-circle` 7.3.5 (MIT, deps: `arc`+`@turf/helpers`+`@turf/invariant`), `geodesy` 2.4.0 (MIT, modified 2022-06-18), `cities.json` 1.1.59 (CC-BY-4.0, 19 MB, no pop), `all-the-cities` 3.1.0 (MIT, 6.4 MB, GeoNames), `us` 2.0.0 (MIT), `@alexanderfedin/async-queue` 1.1.0 (MIT, 0 deps, CJS). **HIGH.**
- Context7 `/openlayers/openlayers` (resolved) + OL 10.9.0 API docs (`ol/source/Cluster`, WebGL points, declutter) — clustering/declutter are built-ins; WebGL is for 10k–100k+ points. **HIGH.**
- https://simplemaps.com/data/us-cities + https://simplemaps.com/data/license — US Cities Basic: CC BY 4.0, Basic tier requires backlink; fields incl. `state_id`, `population`, `ranking`, `timezone`. **MEDIUM-HIGH** (site behind 403 to fetch; corroborated via search + multiple references).
- https://github.com/zeke/all-the-cities — MIT over GeoNames; 138,398 cities ≥1000 pop; fields incl. `population`, `loc:[lon,lat]`, `adminCode`. **HIGH.**
- http://download.geonames.org/export/dump/readme.txt + https://wiki.creativecommons.org/wiki/GeoNames — GeoNames data is CC BY 4.0 (attribution = link to geonames.org); `cities1000` ≈130k cities. **HIGH.**
- Repo files read: `packages/simulation/src/network/{hubs,routes}.ts` (existing `greatCircle`, `buildRoutes`, `hubCoordsChecksum`, `road-geometry.generated.json` pattern), `pnpm-workspace.yaml`, root `package.json`, `vitest.config.ts`, `tsconfig.base.json`, `packages/web/package.json` (`ol` 10.9.0), `vendor/async-queue/{package.json,tsconfig.json,jest.config.js,README.md}`, `.planning/PROJECT.md`, `.planning/v3.0-DESIGN-NOTES.md`. **HIGH.**

---
*Stack research for: v3.0 Continental OODA Network (additions to a shipped TS/Node event-sourced sim)*
*Researched: 2026-06-26*
