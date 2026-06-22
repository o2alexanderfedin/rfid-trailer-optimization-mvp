# Milestones

## v1.0 MVP (Shipped: 2026-06-20)

**Phases completed:** 5 phases, 34 plans, ~110–120 tasks across 34 plans

**Status:** 48/48 v1 requirements shipped and validated. Known deferred items at close: 0.

**Key accomplishments:**

1. **Event-sourced operational twin with deterministic replay (Phase 1):** append-only Postgres event log + per-stream optimistic concurrency + gap-free global ordering, pure-reducer projections, byte-identical golden-replay keystone.
2. **Route-aware LIFO/partial-LIFO load planner with an independent validator (Phase 2):** greedy nose→rear placement, separate-code-path virtual-unload validator (feasibility never folded into score), rehandle+utilization scoring, explainable rationale, FIFO baseline — the core IP.
3. **Probabilistic RFID validation (Phase 3):** rule-based Bayesian fusion (confidence capped <1.0), tag→package mapping, zone estimates, wrong-trailer + missed-unload detection with severity + action.
4. **Rolling-horizon optimizer (Phase 4):** custom time-expanded graph + SSP min-cost-flow (exact vs glpk.js LP oracle on 1,153 instances), custom VRPTW reusing the Phase-2 LIFO hard gate, sandboxed twin, freeze windows, scopeHash idempotency, split/reassign/hold/over-carry repair.
5. **Live realtime USA-map demo (Phase 5):** OpenLayers postrender trailer animation (zero per-frame alloc, flat-heap soak-proven), state coloring, versioned ws keyframe+delta protocol, scenario knobs driving visible re-optimization, exception feed, audit timeline, before/after KPI money slide.
6. **Adversarial code-grounded milestone audit + full closure:** a 10-agent audit caught 6 requirements "dark" on the live path behind a green 827-test suite; all fixed (TDD, rival-judged) and re-verified green at 872 unit+int tests / 98 files + 3 real chromium e2e.

---

## v1.1 Realistic Time Model + Hardening (Shipped: 2026-06-22)

**Phases completed:** 3 phases (Phases 6, 7, 8)

**Status:** 7/7 v1.1 requirements shipped and validated. Known deferred items at close: 0 blockers; 4 LOW-severity tech debt items carried to v1.2.

**Key accomplishments:**

1. **Shared deterministic timing foundation in `@mm/domain` (Phase 6):** `LogNormalParams`/`TimingConfig`/`DEFAULT_TIMING_CONFIG` + pure `expectedMinutes(p)=clamp(median·exp(σ²/2),min,max)` (log-normal MEAN) extracted as the DRY leaf consumed by both simulator and optimizer — single source of truth, no circular dependency.
2. **Distance-derived transit + center-hub re-dispatch dwell (Phase 6):** Per-leg transit medians from ORS `duration_s` for all 18 legs (haversine fallback) — long legs proportionally longer; distinct `dwellCenter` (≈65 min expected) fires at center turnaround exactly once, separate from spoke dwell (no double-count).
3. **Real road-following polylines end-to-end (Phase 6):** ORS `driving-hgv` polylines precomputed, RDP-simplified 8.5 MB → 82 KB, committed as `road-geometry.generated.json` with hub-checksum drift guard; trailers animate along real roads on the OpenLayers map; great-circle = fallback-when-absent.
4. **Time-aware rolling optimizer (Phase 7):** `TwinRoute.travelMin` feeds both the time-expanded min-cost-flow graph and the VRPTW oracle from ORS-duration expected transit; VRPTW `RouteStop.serviceMin` carries role-based expected dwell. Changing timing config changes the plan. Integer-rounded at graph boundary. glpk LP oracle + planner-vs-validator property tests stay green.
5. **Tolerant `parseEnvelope` + ws socket coverage (Phase 8):** Missing/invalid `speed` falls back to `DEFAULT_SPEED` with a warn-once guard (map still animates); malformed core fields still rejected. Four production socket behaviors (open-once, seq-gap→resync, snapshot-replace, tick-apply) verified via real MSW WebSocket through `WsProvider`. Orphaned `useWsEnvelope` dead-code excised.

**Gate numbers:** build 10/10 · typecheck 0 · lint 0 · unit 960 · ui 183 · integration 82/20

**Known LOW debt carried to v1.2:**
- Timing-config plumbing asymmetric: `RollingLoop`/`buildTwinSnapshot`/`runEpoch` hardcode `DEFAULT_TIMING_CONFIG` (harmless as shipped — both default agree; latent DRY break if non-default timing ever injected).
- `DEFAULT_SPEED` literal duplicated in 3 places (`wsClient.ts`, `SpeedControl.tsx`, backend speed-controller) — future DRY cleanup.
- `seq`/`simMs` accept `NaN` (`typeof === "number"`) — pre-existing.
- `GET /routes` integration assertion only checks `length > 1` (not road-vs-great-circle distinction at API boundary).

---
