# Phase 5 (Simulation + Visualization Wrapper) — Code Review Dispositions

Adversarial review of the 8-plan Phase-5 build (live-integration focus). 22 confirmed
findings, 12 marked merge-blocking — overwhelmingly the **"passes synthetic unit tests
but is dark/broken on the live demo path"** anti-pattern (the 802-test suite was too
synthetic to catch it). Closed via a 3-subagent fix burst (A1 producers, A2 runtime +
end-to-end smoke test, B frontend), all TDD. The new `packages/api/test/live-demo.int.test.ts`
drives 120 real ticks and is the safety net the synthetic keystones lacked.

| # | Severity | Issue | Disposition |
|---|----------|-------|-------------|
| OPT-07 dead [1,6,17] | HIGH | `localRepair` never called by `runEpoch`; repair recs advertised but never produced live | **FIXED** (A1): `repairRecommendations` added to `EpochRecommendation`; `runEpoch` calls `localRepair` for infeasible trailers; route reads the real field; guarded test assertions removed |
| Live rehandle = 0 [3,7] | HIGH | `epoch.ts metricsFor` hardcoded `rehandleScore: 0` ⇒ live KPIs always 0 rehandle | **FIXED** (A1): Phase-2 `scorePlan` run over the trailer's plan feeds real rehandle |
| VIZ-03 zero buckets [2,8,13,18] | HIGH/MED | `buildSnapshotPayload` hardcoded hub buckets=0, routes=[] ⇒ no coloring variation live | **FIXED** (A1): real hub volume/congestion/SLA buckets from `hub_inventory` + open exceptions; route load buckets from in-flight trips |
| GET /kpis baseline copy [22] | LOW | `baseline` sub-object was a bitwise copy of live values (misleading) | **FIXED** (A1): removed; before/after lives only in `/kpis/comparison` |
| No live ticks after startup [12] | HIGH | `driveSimulation` ran to completion BEFORE `app.listen` ⇒ map static after connect | **FIXED** (A2): `driveSimulationPaced` after `listen`, wall-clock-paced broadcasts (deterministic event-gen intact) |
| Scenario injection re-run [5,9] | HIGH/MED | injection re-ran base stream from tick 0 + re-appended (duplicate/corrupt) | **FIXED** (A2): drives only the scenario DELTA from the current head + one dedicated epoch |
| KEYSTONE (c) trivial [20] | HIGH | scenario→re-opt passed without asserting a real change | **FIXED** (A2): now asserts new `epochId` + changed `objectiveCost`; `hubCongestion` implicates a trailer so re-opt actually fires |
| ws resync dropped [14] | MED | no `socket.on('message')` ⇒ client seq-gap resync ignored | **FIXED** (A2): resync handler replies with a fresh full snapshot |
| Animation clock basis [11] | HIGH | sim clock mixed `performance.now()` vs OL `frameState.time` (`Date.now()`) ⇒ tween broken | **FIXED** (B): unified to `Date.now()`; test pins single-basis fraction |
| Per-tick LineString alloc [15] | LOW | `new LineString`+`getLength` every tick (P10) | **FIXED** (B): cached per `routeId`, rebuilt only on leg change |
| 3 ws connections [16] | LOW | map/feed/KPI each opened a socket sharing one server seq | **FIXED** (B): single socket via `WsProvider` fanned out |
| UI-04 synthetic comparison [4,10,19] | LOW | money slide uses a calibrated 2-metric seed-42 scenario, not the live stream | **ACCEPTED (MVP)**: the live KPI dashboard (UI-03) is now fully live; the money slide is an intentional **calibrated before/after** demo artifact (reviewer-recommended for MVP). Live full-A/B is a v2 enhancement. |
| Keystone a/b synthetic fixtures [21] | LOW | soak + money-slide e2e use synthetic fixtures | **MITIGATED**: the new `live-demo.int.test.ts` drives the REAL sim and asserts non-zero buckets + non-empty recs (incl. repair) + non-zero KPIs + scenario→new-epoch — the server-backed net the synthetic keystones lacked |

## Live-demo smoke test (the new keystone)
`packages/api/test/live-demo.int.test.ts` — drives 120 real ticks (DEMO_RFID_CONFIG + live optimizer loop) and asserts on the LIVE path: (a) ws carries ≥1 non-zero hub bucket + non-empty routes; (b) `GET /optimizer/recommendations` non-empty w/ real repair recs; (c) `GET /kpis` non-zero live values; (d) `POST /scenario` ⇒ new epoch. Fails if any regress to a stub.

## Summary
- **FIXED:** 11 distinct issues (incl. all 7 distinct merge-blockers).
- **ACCEPTED (MVP):** UI-04 calibrated money slide (live KPI dashboard is real).
- **MITIGATED:** keystone-fixture synthetic-ness, via the live-demo smoke test.
