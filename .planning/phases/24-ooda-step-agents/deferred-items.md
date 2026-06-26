# Phase 24 — Deferred Items (out-of-scope discoveries)

Logged by the 24-04 executor. These are PRE-EXISTING failures unrelated to plan
24-04's changes (which touched only `packages/simulation/**` + `eslint.config.ts`).
Verified identical on the plan base commit `6a73ddd` (before any 24-04 commit) — so
they are NOT regressions from this plan and are out of scope per the executor's
SCOPE BOUNDARY rule. Do NOT fix here.

| # | Failure | File | Symptom | Attribution |
|---|---------|------|---------|-------------|
| 1 | WS delivery wiring (VIZ-14) — "never places deliveryEvents on the initial snapshot payload" | `packages/api/test/ws-delivery.unit.test.ts` | `AssertionError: expected 0 to be greater than 0`; harness `TypeError: socket.close is not a function` | Pre-existing on `6a73ddd`; API/WS layer, untouched by 24-04 |
| 2 | WS induction wiring (VIZ-13) — "never places inductionEvents on the initial snapshot payload" | `packages/api/test/ws-induction.unit.test.ts` | Same Pitfall-7 snapshot assertion + WS mock `socket.close` defect | Pre-existing on `6a73ddd`; API/WS layer, untouched by 24-04 |

**Root cause (shared):** the WS mock harness's `socket` object lacks a `close` method,
so the test teardown throws and the snapshot-payload assertions evaluate against an
empty `0` count. This is a test-harness / WS-mock defect in the API package, not a
product determinism issue. Suggested owner: a future API/viz hardening pass (Phase 27
perf/plumbing/scale-viz, where the WS layer is revisited).
