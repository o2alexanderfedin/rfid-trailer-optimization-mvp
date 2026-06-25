# Recent

```

# Recent

## 2026-06-21
Post-v1.0 sprint: coverage 71.6%→95.2% (measurement fix revealed honest backend coverage + jsdom/Playwright harness); sim-speed gauge (0.25–8× slider, /api/sim/speed); log-normal timing (Box–Muller, deterministic). v1.1 scoped (7 reqs, optimizer-timing coupling primary). Phase 6 impl'd: fixed 12 int failures (timing propagation). 941 tests ✓.

## 2026-06-22
v1.2 shipped: phases 9–18 (35/35 reqs live-wired), HOS enforcement + projection determinism verified. Closed OPT-HOS-02/03 gap (HosClock persistence for driver_status twin). Hub-detail UI ✓; 1472 tests ✓; v1.2 milestone archived.

## 2026-06-23
v1.1 & v1.2 shipped to main (7+35 reqs; ORS geometry, HOS enforcement, Hub detail). Paced-loop SP1 merged (accumulator+worker optimizer, fold-batching, 64× speed, 1213 tests ✓, no-freeze verified). SP2 rest/fuel-stops: both rival impls green (51 files, fuel-aware optimization, verdicts pending). Engine.ts lifecycle investigation initiated (inbound induction, outbound delivery, continuous-ops planned).

## Identity Candidates
- IDENTITY CANDIDATE: 14-agent parallel test gen (jsdom+Playwright harness, RTL+MSW) → 95.2% coverage jump; measurement accuracy breakthrough
- IDENTITY CANDIDATE: Deterministic replay+persisted-snapshot audit pattern (caught OPT-HOS-02/03 dark-gap via live HosClock twin)
- IDENTITY CANDIDATE: 10-phase single-day delivery (v1.2 complete, 35/35 reqs, phases 9–18 merged to develop)