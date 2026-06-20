---
phase: 1
slug: operational-data-foundation-live-map-spike
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-18
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 01-RESEARCH.md "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (latest) |
| **Config file** | `vitest.config.ts` (per package) — Wave 0 installs |
| **Quick run command** | `pnpm test` (unit, no DB) |
| **Full suite command** | `pnpm test:all` (unit + integration via Testcontainers on OrbStack) |
| **Estimated runtime** | ~30–90 seconds (integration spins Postgres container) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` (unit — pure reducers, sim determinism, zod validation)
- **After every plan wave:** Run `pnpm test:all` (adds event-store + projection integration tests)
- **Before `/gsd-verify-work`:** Full suite must be green incl. the golden replay test
- **Max feedback latency:** ~90 seconds

---

## Per-Requirement Verification Map

| Requirement | Behavior to prove | Test Type | Automated Command |
|-------------|-------------------|-----------|-------------------|
| FND-01 | Domain changes persisted as append-only JSONB events; round-trip via `readStream` | integration | `pnpm --filter event-store test` |
| FND-02 | Concurrent append w/ same `expectedVersion` → one succeeds, other throws `ConcurrencyError` (23505); no version gaps | integration | `pnpm --filter event-store test occ` |
| FND-03 | Invalid event payload rejected by zod at ingestion; valid persists | unit | `pnpm --filter domain test` |
| FND-04 | **Golden replay:** live twin == state rebuilt from `global_seq=0` (deep-equal); purity guard (no Date.now/Math.random in reducers) | integration | `pnpm --filter projections test replay` |
| FND-05 | "Where was package X?" → last location + confidence + timestamp | integration | `pnpm --filter api test packages` |
| FND-06 | "What's on trailer T?" → current assignment/observations | integration | `pnpm --filter api test trailers` |
| FND-07 | Hub inventory (inbound/outbound/staged) correct | integration | `pnpm --filter api test hubs` |
| FND-08 | Package audit timeline = ordered event history | integration | `pnpm --filter api test history` |
| SIM-01 | ~10 US hubs with valid coords + connected routes | unit | `pnpm --filter simulation test network` |
| SIM-02 | Same seed ⇒ identical event stream (determinism) | unit | `pnpm --filter simulation test determinism` |
| VIZ-01 | Map renders OSM + hub markers + route lines; trailer points update on ws; no source/layer leak (stable feature count) | e2e (Playwright) | `pnpm --filter web test:e2e` |

---

## Wave 0 Requirements

- [ ] pnpm workspace + Turborepo + root `tsconfig` (strict, `noUncheckedIndexedAccess`)
- [ ] Vitest configured per package; `pnpm test` / `pnpm test:all` scripts
- [ ] Testcontainers (`@testcontainers/postgresql`) wired to OrbStack Docker socket; `docker-compose.yml` Postgres service
- [ ] Shared test fixtures: seeded-sim fixture, ephemeral-Postgres fixture, golden-replay helper

*Determinism + optimistic concurrency are cheapest to bake in at Wave 0 and very costly to retrofit (PITFALLS P3/P4).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live map visually shows trailers moving across the USA as the sim runs | VIZ-01 | Visual/animation smoothness is subjective | Run `pnpm dev`, open the web app, start the sim, confirm hubs/routes render and trailer points advance |

---
*Validation strategy for Phase 1 — Nyquist coverage of FND/SIM/VIZ requirements.*
