---
status: resolved
trigger: "Two failing unit tests: ws-delivery.unit.test.ts and ws-induction.unit.test.ts > 'never places {delivery,induction}Events on the initial snapshot payload (Pitfall 7)' — AssertionError: expected 0 to be greater than 0. Also TypeError: socket.close is not a function during the run."
created: 2026-06-26T00:00:00Z
updated: 2026-06-26T00:00:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: REVISED. These are PURE unit tests (no sim, EMPTY_SNAPSHOT via injected buildPayload). The "expected 0 to be greater than 0" is socket.sent.length === 0 — the initial snapshot frame was NEVER sent to the fake socket. The cause is the unhandled TypeError "socket.close is not a function" at snapshots.ts:718 (closeIfOpen): a Phase-23/24 change to attachSnapshotSocket's initial-snapshot path now calls socket.close() (e.g. on a guard/early-exit), which the FakeSocket doesn't implement, so the send throws before pushing to socket.sent.
test: Read snapshots.ts attachSnapshotSocket + closeIfOpen (lines ~700-850) to see why the initial-snapshot path calls socket.close() and pushes nothing.
expecting: A new guard added in v3.0 that, in the unit-test conditions, takes a close() branch instead of send().
next_action: Read packages/api/src/ws/snapshots.ts around attachSnapshotSocket and closeIfOpen (700-860).

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Sim fixture produces >0 induction/delivery events; test then asserts those events are NOT on the initial WS snapshot payload (Pitfall 7).
actual: Precondition assertion fails — event count is 0 (expected 0 to be greater than 0). Fixture no longer produces those events.
errors: |
  AssertionError: expected 0 to be greater than 0 (both ws-delivery.unit.test.ts and ws-induction.unit.test.ts, "Pitfall 7" test)
  TypeError: socket.close is not a function (mock-socket teardown, possibly unrelated noise)
reproduction: DATABASE_URL=postgres://mm:mm@localhost:5432/mm pnpm exec vitest run packages/api/test/ws-delivery.unit.test.ts packages/api/test/ws-induction.unit.test.ts
started: Possibly v3.0 (Phase 23/24) work on branch feature/phase-24-ooda-step-agents. To confirm via git history at 4df9e18 and 39eca85.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-06-26T00:10:00Z
  checked: Reproduced both tests + read both test files.
  found: Tests are PURE unit tests (no sim). buildPayload returns EMPTY_SNAPSHOT. The failing line is `expect(socket.sent.length).toBeGreaterThan(0)` — the fake socket received ZERO frames. Unhandled rejection "TypeError: socket.close is not a function" at snapshots.ts:718.
  implication: The initial-snapshot send path threw BEFORE sending, then hit the .catch() which calls closeIfOpen(socket) -> socket.close(). My sim-fixture hypothesis was WRONG.

- timestamp: 2026-06-26T00:15:00Z
  checked: snapshots.ts attachSnapshotSocket initial-snapshot .then() (lines 818-849) + FAKE_SPEED mock in both tests + SpeedController interface (speed-controller.ts).
  found: Line 833 calls `speedController.getLastSimMs()`. SpeedController interface declares getLastSimMs() (speed-controller.ts:80). BUT FAKE_SPEED in both tests only defines `snapshot` + `noteSimMs` (cast `as unknown as SpeedController`). So getLastSimMs() is undefined -> TypeError inside .then() -> .catch() -> closeIfOpen -> socket.close() (also undefined on FakeSocket) -> unhandled rejection. Nothing ever sent.
  implication: ROOT CAUSE: stale test mock. FAKE_SPEED missing getLastSimMs (and FakeSocket missing close, though close is only reached because of the prior throw).

- timestamp: 2026-06-26T00:20:00Z
  checked: git history — `git log -S getLastSimMs -- snapshots.ts`; ancestry of 9318ccc vs 39eca85 / 4df9e18; source at 9318ccc~1 vs 9318ccc.
  found: Commit 9318ccc "fix(ws): anchor connect/resync snapshot at live sim clock" replaced `simMs: 0` (literal, line 819) with `simMs: speedController.getLastSimMs()` in BOTH initial-snapshot and resync paths. At 9318ccc~1 the send path used `simMs: 0` (no getLastSimMs) — FAKE_SPEED was sufficient. 9318ccc updated snapshots.test.ts with 3 new guards but did NOT update FAKE_SPEED in ws-induction/ws-delivery unit tests. 9318ccc is an ANCESTOR of BOTH 39eca85 (pre-Phase-23) and 4df9e18 (post-Phase-23).
  implication: REGRESSION ORIGIN = 9318ccc, a v2.x fix that PREDATES all v3.0 (Phase 23/24) work. This is a PRE-EXISTING break, NOT a v3.0 regression. The tests last passed at 9318ccc~1.

reasoning_checkpoint:
  hypothesis: "The Pitfall-7 tests fail because FAKE_SPEED mock lacks getLastSimMs(), which snapshots.ts initial-snapshot path calls (since commit 9318ccc). The call throws inside the .then(), diverting to .catch() which calls socket.close() (also absent on FakeSocket), so the snapshot frame is never sent -> socket.sent.length === 0."
  confirming_evidence:
    - "snapshots.ts:833 calls speedController.getLastSimMs(); FAKE_SPEED defines only snapshot + noteSimMs."
    - "Unhandled rejection originates at snapshots.ts:718 closeIfOpen->socket.close, reached ONLY from the initial-snapshot .catch() (line 848)."
    - "9318ccc diff: simMs:0 literal replaced with speedController.getLastSimMs() in send path; FAKE_SPEED never updated."
  falsification_test: "Add getLastSimMs to FAKE_SPEED. If the tests still fail with socket.sent.length===0, the hypothesis is wrong."
  fix_rationale: "Adding getLastSimMs to FAKE_SPEED makes the .then() succeed, sending the snapshot frame, so socket.sent.length>0. The Pitfall-7 assertion (snapshot payload has no induction/deliveryEvents) is UNCHANGED and still verified. Also add close() to FakeSocket for robust teardown (defense in depth — removes the socket.close noise if any error path is hit). Neither change weakens the test."
  blind_spots: "Whether other unit tests share the same stale FAKE_SPEED/FakeSocket mocks and would also benefit; will grep. Whether the api integration lane uses a different (correct) mock (it does — snapshots.test.ts has its own)."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: Commit 9318ccc changed the WS initial-snapshot/resync send path to anchor at the live sim clock via `speedController.getLastSimMs()`, but the FAKE_SPEED test double in ws-induction.unit.test.ts and ws-delivery.unit.test.ts was never updated to provide getLastSimMs. At runtime getLastSimMs() is undefined -> TypeError in the .then() -> .catch() runs closeIfOpen -> socket.close() (also absent on the FakeSocket) -> unhandled rejection. The snapshot frame is never sent, so `socket.sent.length` is 0 and the Pitfall-7 precondition `toBeGreaterThan(0)` fails.
fix: Added `getLastSimMs: () => 0` to the FAKE_SPEED mock and a `close()` method to FakeSocket (interface + factory) in both unit test files. No production code changed; the Pitfall-7 assertion is preserved (snapshot payload still proven to exclude induction/deliveryEvents).
verification: |
  - Target tests: 2 files / 6 tests PASS; the "socket.close is not a function" unhandled rejections are gone.
  - api unit lane (vitest --project unit packages/api/): 29 files / 311 tests PASS, 0 errors.
  - pnpm typecheck (tsc -p tsconfig.eslint.json --noEmit): clean, 0 errors.
  - No stray vitest workers / testcontainers after the run.
  - Sim/ooda determinism core untouched (API/test-fixture-only change).
files_changed:
  - packages/api/test/ws-induction.unit.test.ts
  - packages/api/test/ws-delivery.unit.test.ts
