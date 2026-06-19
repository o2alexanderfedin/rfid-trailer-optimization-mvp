---
phase: 04-rolling-optimizer
plan: 01
type: summary
requirements: [OPT-04]
status: complete
---

# 04-01 SUMMARY — Plan-lifecycle events (PlanGenerated + PlanAccepted)

## Objective
Extend the Phase-1 CLOSED, VERSIONED `DomainEvent` union (`@mm/domain`) with the two
plan-lifecycle events the Rolling Optimizer needs:

- **`PlanGenerated`** — a candidate plan was produced over the twin. Purely
  observational (OPT-04: evaluating candidates has NO side effect). Carries the
  weighted-objective value (`objectiveCost`) and a HARD `feasible` flag kept
  DISTINCT from the score (anti-P2: feasibility is never folded into the objective).
- **`PlanAccepted`** — the ONE operational side effect when a candidate plan is
  committed (OPT-04). Carries only identifiers + idempotency keys (`epochId`,
  `scopeHash`, `planId`, `trailerId`, `occurredAt`).

## What changed
| File | Change |
|------|--------|
| `packages/domain/src/events/schemas.ts` | Added `planGeneratedSchema` + `planAcceptedSchema` (zod, `.strict()` payloads, `schemaVersion` literal) and appended both to the `domainEventSchema` discriminated union. |
| `packages/domain/src/events/domain-event.ts` | Added `PlanGenerated` + `PlanAccepted` `z.infer` member types and appended both to the `DomainEvent` union. |
| `packages/domain/src/events/contract.assert.ts` | Added `case "PlanGenerated":`/`case "PlanAccepted":` to `assertExhaustive`. The `Exact<Inferred, DomainEvent>` proof was NOT weakened — it still compiles, proving schema/union parity. |
| `packages/domain/src/events/index.ts`, `packages/domain/src/index.ts` | Re-exported the two new type names + two schema names. |
| `packages/domain/src/events/plan-events.test.ts` | New test (TDD RED→GREEN): accept well-formed, reject malformed (missing/typed `objectiveCost`, non-boolean `feasible`, empty id, extra field, unsupported `schemaVersion`), plus type-level union-membership proofs. |
| `packages/projections/src/reducers/{audit-timeline,geo-track,hub-inventory,package-location,trailer-state}.ts` | Widened-union fallout: the exhaustive `assertNever` switches forced handling of the new members. Added both as no-ops to the existing "no state change" case group of each reducer (plan-lifecycle events are optimizer concerns, not operational-state mutations). |

## Determinism / discipline
- No `Date.now()` / `Math.random()` introduced. `occurredAt` is a caller-supplied
  ISO-8601 domain-clock string (the sim/epoch clock), never read from the wall clock.
- No `any`; payloads are `.strict()` so extra fields are rejected at the ingestion
  boundary (threat T-04-01 Tampering).
- `@mm/domain` stays a zero-(workspace-)dependency leaf; no optimizer import.

## Build-gate proof (must_have)
Temporarily removing the `case "PlanAccepted":` from `contract.assert.ts` made
`tsc -b` fail with `TS2345: ... not assignable to parameter of type 'never'`,
confirming the build gate still enforces exhaustiveness/parity. Restored to green.

## Gates (run with MM_PG_URL → shared Postgres, per-run isolated DB)
- `pnpm install` — OK
- `pnpm build` (turbo) — 8/8 successful
- `pnpm -r build` — green
- `pnpm lint` — clean
- `pnpm test:all` — 42 files, 335 tests passing (12 new plan-event tests; all prior tests GREEN, incl. Postgres integration)

## Requirements covered
- **OPT-04**: PlanGenerated (no-side-effect evaluation marker) + PlanAccepted (the
  single accepted-plan side effect) are first-class, zod-validated, contract-asserted
  members of the closed versioned union — the domain contract every later Phase-4
  plan emits against.
