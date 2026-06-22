# Features Research — Milestone v1.1 "Realistic Time Model + Hardening"

**Researched:** 2026-06-21 (inline, codebase-grounded — see STACK.md note on the 529 overload)
**Confidence:** HIGH (the design pivot below is a closed-form statistics question, not an open research one).

## The central design pivot: stochastic draw → deterministic planning estimate (OPT-10)

The simulator draws each dwell/transit from a **log-normal** (`packages/simulation/src/timing.ts`):
`value = median · exp(σ·z)`, `z ~ N(0,1)`, clamped to `[min,max]`.

The optimizer's time-expanded graph is **pure and deterministic** — it cannot consume a random draw. It needs ONE representative number per leg/hub. The choice of central estimate matters and biases plans:

| Estimate | Formula (log-normal) | For transit (median 30, σ 0.3) | Meaning / bias |
|----------|----------------------|-------------------------------|----------------|
| **Median** | `exp(μ)` = `median` | **30.0 min** | Typical value; half of draws exceed it. Makes the planner **optimistic** (ignores the right tail). |
| **Mean (expected)** | `median · exp(σ²/2)` | 30·exp(0.045) ≈ **31.4 min** | The long-run average the simulation actually produces. **Unbiased** w.r.t. realized throughput. ← **RECOMMENDED default.** |
| **p80 / service-level** | `median · exp(σ·z_p)` | 30·exp(0.3·0.842) ≈ **38.6 min** | A safety margin for schedule robustness. Pessimistic; trades slack for fewer missed connections. A future knob, not MVP. |

**Recommendation (table stakes):** the optimizer uses the **MEAN** (`median·exp(σ²/2)`, then clamped to `[min,max]`) as its deterministic per-leg estimate. Rationale: it matches what the simulator generates on average, so the planner is neither systematically optimistic (median) nor over-conservative (percentile). It is a pure one-liner over the existing `LogNormalParams`, so the SAME config drives both the random sim draw and the deterministic plan estimate (DRY — see ARCHITECTURE).

**Dwell estimates** (same closed form): spoke ≈ 25·exp(0.08) ≈ **27.1 min**; center ≈ 60·exp(0.08) ≈ **65.0 min**.

## Feature behavior expectations

### Table stakes (v1.1)
- **OPT-09 — optimizer plans against expected dwell+transit.** Today `route.travelMin` and a flat 15-min step drive the graph; dwell appears only as a flat `waitCost`. Expected transit should populate `travelMin`; expected dwell should become a **minimum service time** before a trailer can depart a hub (a `serviceMin`-style concept — not currently in the graph types). Plans should visibly shift when timing config changes.
- **TIME-01 — distance-derived transit.** A leg's transit median should scale with its real road distance (ORS `distance_m`) at a representative HGV average speed, instead of every leg sharing a flat ~30-min median. Long legs (e.g. coast hubs) get larger medians; short legs smaller. σ (spread) can stay per-config.
- **TIME-02 — center-hub re-dispatch dwell.** A center hub is a cross-dock: arriving freight is unloaded, re-sorted, and **re-dispatched** — a materially longer dwell than a spoke. The wired-but-unused `dwellCenter` (median 60 vs spoke 25) models this; v1.1 must insert a distinct center dwell site into the modeled cycle so `dwellCenter` actually applies.
- **VIZ-06 — road-following routes.** Users expect trailers to track real highways on the map, not straight arcs across terrain. Precomputed ORS `driving-hgv` polylines; downstream animation is geometry-shape-agnostic so it "just works".
- **HRD-01 — tolerant envelope parsing.** A partial/older server envelope missing `speed` should still animate (fall back to a default speed) rather than blank the map — but must warn (not silently mask) a genuinely broken protocol.
- **QA-01 — coverage top-up.** Meaningful coverage of the `wsClient` socket path + branch coverage, asserting real behavior.

### Differentiators
- A single **shared timing source of truth** that both the sim (draws) and the optimizer (expects) read — makes "realistic time" coherent end-to-end and demoable (change config → both sim motion AND plan decisions shift together).
- Distance-derived medians make the map's geography and the plan's costs tell the **same** story.

### Anti-features (explicitly OUT for v1.1 — YAGNI / spec non-goals)
- ❌ **Full stochastic / robust optimization** (scenario sampling, Monte-Carlo planning, chance constraints) — the deterministic expected-value estimate is the MVP. (Out-of-scope per PROJECT.md.)
- ❌ **Per-segment live traffic / time-of-day routing** — ORS static precompute only.
- ❌ **Legally-mandated HGV break modeling (HOS rules)** — not in scope for a demo; medians absorb average overhead.
- ❌ **Runtime routing** — precompute only (see STACK).

## Sources
- `packages/simulation/src/timing.ts` (`DEFAULT_TIMING_CONFIG`, `sampleLogNormal`), `packages/optimizer/src/graph/{time-expanded,types}.ts`, `packages/optimizer/src/rolling/epoch.ts`, `packages/web/src/map/wsClient.ts`.
- Log-normal moment formulas (standard closed form).
