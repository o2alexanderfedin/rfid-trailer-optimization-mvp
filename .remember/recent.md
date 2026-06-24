# Recent

```

# Recent

## 2026-06-20
v1.0.0 shipped to main (827 tests, 48 reqs, 10/10 e2e). Gap audit closed 10 issues via TDD across optimizer, networking, e2e, coloring, packaging. Lint 176→0, TS-everywhere. Integration gate caught & fixed 2 regressions (duplicate routes, KPI contract).

## 2026-06-21
Post-v1.0 sprint: coverage 71.6%→95.2% (measurement fix revealed honest backend coverage + jsdom/Playwright harness); sim-speed gauge (0.25–8× slider, /api/sim/speed); log-normal timing (Box–Muller, deterministic). v1.1 scoped (7 reqs, optimizer-timing coupling primary). Phase 6 impl'd: fixed 12 int failures (timing propagation). 941 tests ✓.

## 2026-06-22
v1.2 shipped: phases 9–18 (35/35 reqs live-wired), HOS enforcement + projection determinism verified. Closed OPT-HOS-02/03 gap (HosClock persistence for driver_status twin). Hub-detail UI ✓; 1472 tests ✓; v1.2 milestone archived.

## Identity Candidates
- IDENTITY CANDIDATE: 14-agent parallel test gen (jsdom+Playwright harness, RTL+MSW) → 95.2% coverage jump; measurement accuracy breakthrough
- IDENTITY CANDIDATE: Deterministic replay+persisted-snapshot audit pattern (caught OPT-HOS-02/03 dark-gap via live HosClock twin)
- IDENTITY CANDIDATE: 10-phase single-day delivery (v1.2 complete, 35/35 reqs, phases 9–18 merged to develop)