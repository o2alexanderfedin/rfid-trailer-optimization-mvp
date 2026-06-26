# Phase 23: Multi-Center Topology - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

The FOUNDATION phase of v3.0. Generalize the engine from a single fixed-center (Memphis) 10-hub
hub-and-spoke to a continental network of ~80–130 deterministically-generated big-city hubs (1–3 per
state) spoked to **multiple regional sort centers** over a near-full-mesh backbone — and key-scope the
projection fold + optimizer scope so the hub-count jump does not re-create the v2.1 freeze. Everything
in Phases 24–28 reads this topology.

In scope: big-city hub generation (HUB-01..04), multi-center topology + backbone + spoke assignment +
per-center scope partition (NET-01..05), the `applyHubInventory` key-scoping (PERF-01, P1-BLOCKING),
and the topology flag + flags-off golden gate (DET-01).

Out of scope (later phases): OODA agents (24), coordinators (25/26), async-queue/cursor-fold/scale-viz
hardening (27), consolidated determinism audit (28).
</domain>

<decisions>
## Implementation Decisions

### Big-city dataset & ranking
- **Source: `all-the-cities` (MIT npm, offline)** — deterministic vendoring via a pinned package version
  (no manual CSV download, no commercial backlink obligation); provides population + lat/lon + GeoNames
  admin1 per city. SimpleMaps US Cities Basic rejected as primary (manual download, mandatory
  simplemaps.com backlink, site 403'd).
- **Ranking metric: population** (top 1–3 metros per state by population rank).
- **Per-state selection: floor 1, cap 3** — always include each state's largest; add 2nd/3rd only above a
  documented population threshold (single tunable const in the generator), yielding ~80–130 hubs.
- **Cross-state metros de-duplicated** to a single hub (assigned to its highest-population state).
- A transcribed **50-row state → {2-letter postal, region, IANA timezone} const** supplies region/timezone
  for partitioning (determinism-safe; not a runtime dep). GeoNames CC BY 4.0 attribution shipped (HUB-04).
- Output is a **committed, content-checksummed `us-big-cities.generated.json`**; the runtime imports ONLY
  the committed JSON (mirrors the `road-geometry.generated.json` pattern). No city-data dep at runtime.

### Regional centers & backbone
- **Center count parameterized** (config/env), NOT hard-coded; default ~6, **chosen empirically THIS phase**
  from a real continental run that validates trailer-fill/consolidation; never collapse to a single primary.
- Centers selected as the largest metro per **freight-corridor + timezone** partition; spokes assigned to
  their center by that partition with a great-circle **nearest tie-break by stable id** under a **leg-length cap**.
- **Inter-center backbone: full mesh** (cheap at ≤8 centers → ≤28 legs) with an **anti-SPOF**
  (remove-any-center connectivity) check; great-circle geometry (reuse the existing pure `greatCircle`).
- Freight flow: **spoke → nearest center → backbone → destination center → destination spoke**;
  `detectAffectedScope` gains a **per-center scope partition** (the real scaling fix).

### Perf (P1-BLOCKING — ships in THIS phase)
- **`applyHubInventory` key-scoped to the touched hub id(s)** — mirror the exact v2.1 surgery already
  applied to the other inline appliers. A per-event projection-cost test proves row reads are independent
  of hub count (10-hub vs 100-hub equal per event). NOT deferred to Phase 27.

### Determinism (keystone)
- Flag `continentalTopology` (off by default). Two-part flags-off gate: `flag:false === absent` AND
  `absent ⇒ seed-42 10k-tick golden 3920accc…` byte-identical.
- The generalized multi-center `buildRoutes` MUST produce the **identical `Route[]`** for the legacy
  10-hub single-center input (the key flags-off equivalence).
- Keep great-circle transcendentals out of hashed payloads / round at the boundary (cross-platform float).
- The continental model captures its **own new golden** on a small **12–20-hub deterministic fixture**
  (fast hash), constructed only when the flag is on.

### Claude's Discretion
- Exact module layout (e.g. `network/centers.ts`, generator under `scripts/`), the population-threshold
  constant values, the precise leg-length-cap distance, and the parameterization mechanism (env var vs
  config field) — all at Claude's discretion, following existing `precompute-routes.ts` / `network/` patterns.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/simulation/src/network/hubs.ts` — `USA_HUBS` (10 IATA hubs w/ lat/lon), `MEMPHIS` center, `hubRegisteredEvent` — the seed to generalize.
- `packages/simulation/src/network/routes.ts` — `buildRoutes` (single-center star on `USA_HUBS[0]`), existing pure `greatCircle` + haversine helpers (reuse, do NOT swap).
- `scripts/precompute-routes.ts` + committed `road-geometry.generated.json` + hub-checksum drift guard — the exact pattern to mirror for the big-city dataset generator.
- `packages/projections/src/runner/inline.ts` — `applyHubInventory` (~L397) is the residual full-table-scan applier; the other appliers already show the key-scoped surgery to copy.
- `packages/optimizer/src/rolling/scope.ts` — `detectAffectedScope` (gains the per-center partition).
- `packages/simulation/test/determinism.unit.test.ts` — the seed-42 golden `3920accc…` + DET-01 two-part gate harness.

### Established Patterns
- Committed-static-generated-data + checksum drift guard (road geometry) — apply to hub dataset.
- Closed event union + zod + exhaustive switches in `@mm/domain`; pure reducers; per-key inline fold.
- Flag-gated features with two-part flags-off golden gate; seeded RNG substreams salted per feature.

### Integration Points
- `network/hubs.ts` / new `network/centers.ts` / `network/routes.ts` (topology), engine `const center = hubs[0]` → `centerOf(spoke)` map, `detectAffectedScope` per-center partition, `inline.ts` `applyHubInventory`, web map layer (renders the new hubs/centers/backbone — VIZ baseline only this phase).
</code_context>

<specifics>
## Specific Ideas

- Center count is a deliberate **Phase-23 empirical decision** (the user explicitly deferred the number);
  the phase must record the chosen value + rationale in a committed partition snapshot, with leg-length
  cap + anti-SPOF mandatory regardless of count.
- Mirror the v2.1 `applyHubInventory` fix exactly — this is the known P1 freeze and must not ship without it.
</specifics>

<deferred>
## Deferred Ideas

- Full ~100-hub determinism golden (use the small 12–20-hub fixture this phase; consolidated audit is Phase 28).
- Scale-viz hardening (Cluster/declutter/VectorImageLayer) and per-tick payload optimization — Phase 27
  (this phase only renders the new topology at a baseline).
- async-queue plumbing, cursor-fold twin-snapshot — Phase 27.
</deferred>
