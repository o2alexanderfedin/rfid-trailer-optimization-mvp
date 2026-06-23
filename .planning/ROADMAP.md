# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Milestones

- ✅ **v1.0 MVP** — Phases 1–5 (shipped 2026-06-20) — full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Realistic Time Model + Hardening** — Phases 6–8 (shipped 2026-06-22) — full details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Driver HOS & Hub Detail** — Phases 9–18 (shipped 2026-06-22) — full details: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–5) — SHIPPED 2026-06-20</summary>

- [x] Phase 1: Operational Data Foundation + Live Map Spike (7/7 plans) — completed 2026-06-19
- [x] Phase 2: Load Planning (6/6 plans) — completed 2026-06-19
- [x] Phase 3: RFID-Assisted Validation (7/7 plans) — completed 2026-06-19
- [x] Phase 4: Rolling Optimizer (6/6 plans) — completed 2026-06-19
- [x] Phase 5: Simulation + Visualization Wrapper (8/8 plans) — completed 2026-06-19

</details>

<details>
<summary>✅ v1.1 Realistic Time Model + Hardening (Phases 6–8) — SHIPPED 2026-06-22</summary>

- [x] Phase 6: Realistic Geography & Time Model — completed 2026-06-21 (VIZ-06, TIME-01, TIME-02)
- [x] Phase 7: Time-Aware Optimizer — completed 2026-06-21 (OPT-09, OPT-10)
- [x] Phase 8: Client Hardening & Coverage — completed 2026-06-22 (HRD-01, QA-01)

</details>

<details>
<summary>✅ v1.2 Driver HOS & Hub Detail (Phases 9–18) — SHIPPED 2026-06-22</summary>

> **Keystone constraint:** determinism. HOS-*off* stays byte-identical to the pre-v1.2 golden replay; HOS-*on* adds a new golden. All HOS RNG flows through one new isolated seeded substream.

- [x] Phase 9: Driver model + HOS config + duty/phase events ✅ 2026-06-22
- [x] Phase 10: Pure forward-labeling HOS engine (shared sim + optimizer) ✅ 2026-06-22
- [x] Phase 11: Sim HOS enforcement + load/unload events + determinism golden ✅ 2026-06-22
- [x] Phase 12: Driver relay / swap at hubs ✅ 2026-06-22
- [x] Phase 13: Driver-status projection + tables ✅ 2026-06-22
- [x] Phase 14: Hub-detail endpoint + ws driver buckets ✅ 2026-06-22
- [x] Phase 15: Optimizer HOS-aware ✅ 2026-06-22
- [x] Phase 16: Optimizer HOS-enforced ✅ 2026-06-22
- [x] Phase 17: Hub Detail panel UI + map duty styling ✅ 2026-06-22
- [x] Phase 18: README features + screenshots ✅ 2026-06-22

</details>

## Progress

| Milestone | Phases | Status | Shipped |
|-----------|--------|--------|---------|
| v1.0 MVP | 1–5 | ✅ Complete | 2026-06-20 |
| v1.1 Realistic Time Model + Hardening | 6–8 | ✅ Complete | 2026-06-22 |
| v1.2 Driver HOS & Hub Detail | 9–18 | ✅ Complete | 2026-06-22 |
