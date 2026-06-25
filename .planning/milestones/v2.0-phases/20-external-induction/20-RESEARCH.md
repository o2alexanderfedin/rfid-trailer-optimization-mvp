# Phase 20: External Induction - Research

**Researched:** 2026-06-24
**Domain:** Domain event extension — new `PackageInducted` event, seeded RNG substream, resumable continuation, optimizer scope, ws envelope, OL map layer
**Confidence:** HIGH (all claims anchored to live source files with exact file:line citations)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **`PackageInducted` COEXISTS with `PackageCreated`** (Decision 1). `PackageCreated` = internal center-origin spawn (unchanged); `PackageInducted` = first network-visible entry of externally-originated freight. Existing goldens untouched.
- **Optimizer picks up inducted freight AUTOMATICALLY via the existing `hub_inventory` projection** (Decision 3) — `PackageInducted` populates `hubInventory[inductionHubId].inbound` via the same reducer path `PackageArrivedAtHub` uses. No new optimizer demand-source concept.
- **Spoke→spoke routing is via the center** (Decision 2) — not relevant until Phase 21, but induction destinations may be any hub; multi-hop routes via center.
- **The induction RNG substream state MUST be carried in `SimContinuation`** — `INDUCTION_RNG_SALT` substream's PRNG state captured/restored so a chunked/continuous run is byte-identical to all-at-once with `inductionEnabled: true`.
- **Self-rescheduling `EventQueue` task** — new induction scheduling mirrors `createPackageBatch` (engine.ts:904); never an external append.
- **`INDUCTION_RNG_SALT` pairwise-distinct** from ALL existing 5 salts (asserted in salt-collision test).
- **Opt-in:** `inductionEnabled: false` (default) → ZERO `PackageInducted` events → existing seed-1234 + seed-42 goldens byte-identical.
- **Continuation must capture the pending induction task itself** (its absolute `fireTick`) in the `SimContinuation` queue, not just the PRNG state — so a resume mid-gap between inductions doesn't lose/reorder it.
- **`slaDeadlineIso` derivation:** `occurredAt + expectedTravel(inductionHub→destHub) + SLA-class buffer`; lock at induction; fall back to flat class offset only if estimate unavailable.
- **`INDUCTION_RNG_SALT` hash-split** — a large well-separated constant (not `seed+1`), pairwise-distinct.

### Claude's Discretion
- Induction arrival process shape (per-spoke rate / batch size / schedule) — deterministic, seeded from `inductionRng`; tuned so the demo is visually interesting without overwhelming trailer capacity (defer exact tuning to scenario config).
- `slaDeadlineIso` derivation: `occurredAt + SLA-class offset` (reuse existing `SlaClass`/`DeadlineBucket` from `@mm/domain`); deterministic.
- Whether to add a dedicated `packageLifecycleReducer` vs extend existing reducers — pick the simplest consistent with existing projection patterns.
- `externalOriginRef` deterministic id format (e.g. `EXT-P000NN`).

### Deferred Ideas (OUT OF SCOPE)
- Spoke→center consolidation freight (Phase 21 / FLOW).
- Outbound delivery / `PackageDelivered` (Phase 22 / OUT).
- Mixed-direction same-hub local short-circuit (IND-FUT-01, future).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IND-01 | New `PackageInducted` domain event joins closed union (Zod `.strict()`, `contract.assert.ts`, `validate()` round-trip) | VQ#1: exact add-event protocol documented; 5-file touch list identified |
| IND-02 | Inducted at spoke hubs on repeating schedule via `INDUCTION_RNG_SALT` substream; `inductionEnabled:false` → zero events | VQ#2: mirrors `createPackageBatch` self-rescheduling at engine.ts:904; salt pattern at engine.ts:71-103; continuation capture at continuation.ts:96-136 |
| IND-03 | Inducted packages carry `destHubId` + `slaDeadlineIso`; deadline flows to optimizer via `TwinBlock.deadlineMin` | VQ#3: `SlaClass`/`DeadlineBucket`/`PlanningPackage` exist in planning/index.ts; `expectedTransitMinutes` in timing-geo.ts:87; `TwinBlock` in optimizer/types.ts:50-56 |
| VIZ-13 | Pulsing marker at induction hub on `PackageInducted` ws message | VQ#5: new ws message type on envelope; new OL layer in layers.ts mirroring `createTrailerStopLayer()` pattern |
</phase_requirements>

---

## Summary

Phase 20 is a **closed-union domain event extension** touching six packages in a well-established pattern. The codebase already has everything needed: the `eventSchema` factory, `assertNever` exhaustiveness gate, seeded RNG substreams with captured state, the `SimContinuation` DTO, and the OL layer/coloring infrastructure. The work is mechanical but multi-file, and the determinism keystone is the primary engineering risk.

**The most important finding:** Phase 19 built `runToHorizon` + `SimContinuation` (continuation.ts) with the EXACT continuation-equivalence infrastructure Phase 20 needs. The `SimContinuation.rng` field (continuation.ts:122) already has `fuel: number | undefined` showing how an opt-in substream's state is conditionally captured. Phase 20 adds `induction: number | undefined` following the IDENTICAL pattern. The `SimContinuation.queue` (continuation.ts:124) captures all pending `SimTask`s as DATA — so the pending induction task (its `fireTick`) is automatically captured when the induction task is added to the queue as a new `SimTask` variant.

**The second most important finding:** The `dispatch()` function (engine.ts:1488-1517) is the ONLY place `SimTask` kinds are dispatched. `SimTask` (continuation.ts:27-51) is a discriminated union of DATA tasks. Adding `inductionEnabled` follows the EXACT same opt-in pattern as `hosEnabled` (engine.ts:427, line `const hosOn = hosEnabled === true`) and `fuelOn` (engine.ts:436).

**The third most important finding:** ALL inline projection reducers that have a `switch(event.type)` with `default: return assertNeverEvent(event)` WILL FAIL TO COMPILE the moment `PackageInducted` joins `DomainEvent` without a matching case. The planner must list every reducer as a task. Reducer files with `switch(event.type)` confirmed: `hub-inventory.ts`, `package-location.ts`, `trailer-state.ts`, `driver-status.ts`, `driver-assignment.ts`, `tag-registry.ts`, `zone-estimate.ts`, `exceptions.ts`, `audit-timeline.ts`, and `scope.ts` (optimizer). Additionally `contract.assert.ts` has an exhaustive switch.

**Primary recommendation:** Add `PackageInducted` end-to-end following the 4-phase pattern (domain → simulation → projections → api+web), with the determinism keystone validated first (gate-hygiene: keep horizons short, chunk matrix bounded).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `PackageInducted` schema + closed union | `@mm/domain` events | — | Zero-dep leaf; all consumers import from here |
| `contract.assert.ts` exhaustiveness gate | `@mm/domain` build | — | Part of tsc -b, not just test; build fails if missed |
| Induction RNG substream + self-rescheduling task | `@mm/simulation` engine | — | Engine owns all seeded draws + EventQueue |
| `INDUCTION_RNG_SALT` in continuation | `@mm/simulation` continuation | — | `SerializedRngStates` extended; `captureContinuation()` updated |
| `inductionEnabled` flag gating | `@mm/simulation` engine | `@mm/api` driver | Engine gating matches hosEnabled/fuelOn patterns |
| Salt-collision assertion | `@mm/simulation` test | — | `fuel-determinism.unit.test.ts` already owns this |
| Reducer `PackageInducted` cases | `@mm/projections` reducers | — | Every reducer with `switch(event.type)` must gain a case |
| `hubInventory[inductionHubId].inbound` update | `@mm/projections` hub-inventory | — | Decision 3: same path as `PackageArrivedAtHub` |
| `detectAffectedScope`/`hubsOf` classification | `@mm/optimizer` scope | — | `scope.ts` has an exhaustive switch too |
| `TwinBlock.deadlineMin?` additive field | `@mm/optimizer` types | — | Additive optional — pre-Phase-20 twins reproduce byte-identically |
| Induction ws message | `@mm/api` ws/envelope | `@mm/web` ws client | New envelope field or new message type in `WsEnvelope` |
| `inductionLayer` pulsing-circle | `@mm/web` map/layers | `@mm/web` map/coloring | New `createInductionLayer()` + `inductionStyle` following `createTrailerStopLayer()` |

---

## VQ#1 — How to add a new event end-to-end

**The 5-file protocol** (all must be touched in lockstep or the build fails):

### Step 1: `packages/domain/src/events/schemas.ts` — add the schema

```typescript
// Source: packages/domain/src/events/schemas.ts — follow the existing pattern
export const packageInductedSchema = eventSchema(
  "PackageInducted",
  z.object({
    packageId:       id,
    inductionHubId:  id,
    destHubId:       id,
    slaClass:        slaClassSchema,       // from ../planning/index.js
    slaDeadlineIso:  z.string().min(1),    // ISO-8601 deadline (locked at induction)
    externalOriginRef: id,                 // e.g. "EXT-P00001" (deterministic)
    occurredAt,                            // virtual clock ISO string
  }),
);
```

`eventSchema(type, payload)` wraps with `{ type: z.literal(type), schemaVersion, payload: payload.strict() }` [VERIFIED: schemas.ts:34-43]. The `.strict()` is applied by `eventSchema` to the payload shape — no need to call it separately.

`slaClassSchema` is exported from `packages/domain/src/planning/index.ts:32-38` and re-exported from `packages/domain/src/index.ts:134`. Import it in schemas.ts via `"../planning/index.js"`.

### Step 2: `packages/domain/src/events/domain-event.ts` — add the TS type + union member

```typescript
// Add the inferred type:
export type PackageInducted = z.infer<typeof packageInductedSchema>;

// Add to DomainEvent union (after TruckRefueled or in a v2.0 section):
export type DomainEvent =
  | ...existing members...
  | TruckRefueled
  // v2.0 external induction (IND-01)
  | PackageInducted;
```

[VERIFIED: domain-event.ts:140-165]

### Step 3: `packages/domain/src/events/contract.assert.ts` — add to exhaustive switch

```typescript
// assertExhaustive function — add a case before the default:
case "PackageInducted":
  return;
```

The `default: assertNever(event)` at contract.assert.ts:50 stops compiling the moment `PackageInducted` is missing from the switch [VERIFIED: contract.assert.ts:25-53].

### Step 4: `packages/domain/src/events/index.ts` — re-export

Add `PackageInducted` to both type and schema exports [VERIFIED: index.ts:1-56].

### Step 5: `packages/domain/src/index.ts` — barrel re-export

Add type + schema to the barrel [VERIFIED: index.ts lines 116+ for existing patterns].

**Type-equality proof:** `contract.assert.ts:68` — `const _zodMatchesHandWrittenUnion: Exact<Inferred, DomainEvent> = true` automatically covers the new member because `domainEventSchema` in schemas.ts:393 (the discriminated union) must also be extended with `packageInductedSchema`. [VERIFIED: schemas.ts:393-419]

**`validate()` round-trip:** `packages/domain/src/index.ts:170` exports `validateEvent`. A test calling `validateEvent(buildPackageInducted(...))` and checking it round-trips without error validates IND-01.

---

## VQ#2 — Simulation engine: induction task, flag gating, salt, continuation

### The `inductionEnabled` opt-in gate

Pattern from `hosEnabled` [VERIFIED: engine.ts:427-429]:
```typescript
// engine.ts — in runToHorizon opts destructuring, after fuel setup
const inductionOn = opts.inductionEnabled === true;
// Construct ONLY when inductionOn (the off path never draws, byte-identical golden)
const inductionRng: Rng | undefined = inductionOn
  ? (restoredRng && restoredRng.induction !== undefined
      ? makeRngFromState(restoredRng.induction)
      : makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0))
  : undefined;
```

`SimulateOptions` gains `inductionEnabled?: boolean` following the `hosEnabled?: boolean` (engine.ts:~171) pattern.

### `INDUCTION_RNG_SALT` — the new constant

```typescript
// engine.ts — after FUEL_RNG_SALT (line 103)
// v2.0 IND-02: SEVENTH substream salt for external induction draws. A NEW, DISTINCT
// constant (salt-collision test asserts it differs from the six above) so inducting
// packages never perturbs any prior stream. The `inductionRng` is constructed ONLY
// when `inductionEnabled`, so a flag-off run draws ZERO induction values.
export const INDUCTION_RNG_SALT = 0x8f_2c_4a_e1; // example — must be pairwise-distinct
```

The value must be chosen to be pairwise-distinct from all 5 existing salts (`0x5f_1d_a7_c3`, `0x3c_a7_1d_5f`, `0x00_00_77_17`, `0x10_51_09_01`, `0x2b_3d_91_e7`). The exact value is implementation-level discretion; the salt-collision test enforces it mechanically. [VERIFIED: engine.ts:71-103, fuel-determinism.unit.test.ts:43-56]

### New `SimTask` variant for induction

```typescript
// continuation.ts — add to SimTask union:
| { readonly kind: "inductPackage"; readonly tick: number }
```

This follows `{ readonly kind: "createPackageBatch"; readonly tick: number }` (continuation.ts:28). The self-rescheduling pattern: each `inductPackage` task draws from `inductionRng` to schedule the NEXT induction at an absolute tick, then emits one or more `PackageInducted` events. [VERIFIED: continuation.ts:27-51]

### The self-rescheduling pattern (mirrors `createPackageBatch`, engine.ts:904)

```typescript
// engine.ts — new function, gated behind inductionOn
const inductPackage = (tick: number): void => {
  if (!inductionOn || inductionRng === undefined) return; // never runs when off

  // Draw which spoke hub inducts this batch (from inductionRng — byte-isolated)
  const inductionHub = inductionRng.pick(spokes);
  const destHub      = inductionRng.pick(spokes.filter(s => s.hubId !== inductionHub.hubId));
  const slaClass     = SLA_CLASSES[inductionRng.int(SLA_CLASSES.length)];
  // ... emit PackageInducted (uses clock.nowIso() for occurredAt) ...

  // Deadline: occurredAt + expectedTransit(inductionHub→center→destHub) + SLA buffer
  // fallback: flat SLA_CLASS_OFFSET_MIN[slaClass] minutes

  // Self-reschedule — absolute next tick
  const nextTick = tick + INDUCTION_INTERVAL_TICKS; // tunable constant
  scheduleNext(nextTick, { kind: "inductPackage", tick: nextTick });
};
```

The `scheduleNext()` helper (engine.ts:1484) always schedules — the drain loop's horizon ceiling handles bounded execution. This is the SAME discipline as `createPackageBatch` (confirmed at engine.ts:1416-1425). [VERIFIED: engine.ts:1484-1486]

### `dispatch()` extension

```typescript
// engine.ts:dispatch() — add case:
case "inductPackage":
  inductPackage(task.tick);
  return;
```

[VERIFIED: engine.ts:1488-1517]

### Bootstrap: first induction task

```typescript
// engine.ts — in the `if (!resuming)` bootstrap block:
if (inductionOn) {
  schedule(INDUCTION_START_TICK, { kind: "inductPackage", tick: INDUCTION_START_TICK });
}
```

Where `INDUCTION_START_TICK` is a small offset (e.g. `1`) so the first induction doesn't fire at tick 0 alongside bootstrap hub/route registration. [VERIFIED: engine.ts:1520-1533 for bootstrap pattern]

### `SerializedRngStates` extension

```typescript
// continuation.ts — SerializedRngStates gains:
/** Present only when inductionEnabled (the off path never constructs it). */
readonly induction: number | undefined;
```

Pattern directly mirrors `fuel: number | undefined` (continuation.ts:103). [VERIFIED: continuation.ts:96-104]

### `captureContinuation()` extension

```typescript
// engine.ts — captureContinuation() in rng block:
rng: {
  base:       rng.getState(),
  rfid:       rfidRng.getState(),
  overCarry:  overCarryRng.getState(),
  timing:     timingRng.getState(),
  hos:        hosRng.getState(),
  fuel:       fuelRng?.getState(),
  induction:  inductionRng?.getState(), // NEW — undefined when off
},
```

[VERIFIED: engine.ts:1590-1597 for the existing capture block]

**CRITICAL (Google AI consult point 1):** The pending induction task is captured AUTOMATICALLY into `continuation.queue` via `queue.snapshot()` (engine.ts:1598: `queue: queue.snapshot()`). Because the induction task is a DATA task in the `SimTask` union, `scheduleNext()` places it in the queue, and `queue.snapshot()` captures its `fireTick`. No special handling needed beyond adding the `SimTask` variant. [VERIFIED: engine.ts:1564-1602, continuation.ts:53-58]

---

## VQ#3 — SLA deadline derivation

### Available tools in `@mm/domain`

`expectedTransitMinutes(from: Hub, to: Hub, config: TimingConfig): number` [VERIFIED: timing-geo.ts:87-88] returns the deterministic log-normal MEAN for a directed leg in minutes. Signature: takes two `Hub` objects (not hub IDs) and a `TimingConfig`.

`expectedDwellMinutes(role: "center" | "spoke", config: TimingConfig): number` [VERIFIED: timing-geo.ts:103-107].

Both are pure, exported from `@mm/domain` index.ts:164. The simulation engine already has `Hub` objects for all hubs in its `hubs` array.

### Deadline calculation at induction time

```typescript
// In inductPackage(), with hubs available in scope:
const inductHub = hubById.get(inductionHubId)!;
const destHub   = hubById.get(destHubId)!;
const config    = timingConfig; // already in scope

// Multi-hop via center (Decision 2): inductionHub→center + center→destHub
const transitMin = expectedTransitMinutes(inductHub, center, config)
                 + expectedDwellMinutes("center", config)
                 + expectedTransitMinutes(center, destHub, config);

const SLA_BUFFER_MIN: Record<SlaClass, number> = {
  express:  60,
  priority: 120,
  standard: 240,
  economy:  480,
};
const deadlineMin = isoToEpochMinutes(clock.nowIso()) + transitMin + SLA_BUFFER_MIN[slaClass];
const slaDeadlineIso = epochMinutesToIso(deadlineMin);
```

`isoToEpochMinutes` and `epochMinutesToIso` are already imported from `@mm/domain` in engine.ts [VERIFIED: engine.ts:28-33].

### `TwinBlock.deadlineMin?` — optional additive field

```typescript
// optimizer/src/rolling/types.ts — TwinBlock gains:
export interface TwinBlock {
  readonly blockId: string;
  readonly nextUnloadHubId: string;
  readonly volume: number;
  /**
   * IND-03 — OPTIONAL additive SLA deadline in epoch-minutes (from `slaDeadlineIso`).
   * When present, the optimizer uses it for slack/critical-ratio prioritization.
   * Absent → pre-Phase-20 plans reproduce byte-identically (additive, non-breaking).
   */
  readonly deadlineMin?: number;
}
```

[VERIFIED: optimizer/src/rolling/types.ts:50-56 — existing `TwinBlock` interface]

The `deadlineMin` flows into planning priority via the twin snapshot builder: when building `TwinBlock` from induction-origin packages, set `deadlineMin` from `slaDeadlineIso` converted to epoch-minutes. The optimizer can then compute slack = `deadlineMin - nowMin` and sort/weight blocks by critical-ratio.

---

## VQ#4 — All reducers requiring `PackageInducted` cases

**Every file with `switch(event.type)` and `default: return assertNeverEvent(event)` MUST gain a `case "PackageInducted":` or the build fails.**

The reducers identified (all in `packages/projections/src/reducers/`):

| File | Action for PackageInducted | Rationale |
|------|---------------------------|-----------|
| `hub-inventory.ts` | **REAL ACTION**: `placePackage(state, packageId, { hubId: inductionHubId, bucket: "inbound" })` | Decision 3 — optimizer reads inducted freight via this bucket |
| `package-location.ts` | `return state` (no-op) OR update location to inductionHubId | Depends on whether we want induction to register as last-known-location |
| `trailer-state.ts` | `return state` (no-op) | Trailers unaffected |
| `driver-status.ts` | `return state` (no-op) | Drivers unaffected |
| `driver-assignment.ts` | `return state` (no-op) | Assignments unaffected |
| `tag-registry.ts` | `return state` (no-op) | No RFID tag in induction event |
| `zone-estimate.ts` | `return state` (no-op) | No RFID zone evidence |
| `exceptions.ts` | `return state` (no-op) | Not an exception event |

[VERIFIED: hub-inventory.ts:162-216, package-location.ts:60-107 — both files use `assertNeverEvent` in default]

**`audit-timeline` and `geo-track`** (catch-up projections in `packages/projections/src/runner/catchup.ts`) — need to verify if they have a similar exhaustive switch, or whether they only respond to specific event types. The catch-up reducers likely need a no-op case for `PackageInducted` too.

**`@mm/optimizer` scope.ts:** `hubsOf()` at scope.ts:27-76 has an exhaustive switch with `default: { const _never: never = event; return _never; }`. Add:
```typescript
case "PackageInducted":
  return [event.payload.inductionHubId, event.payload.destHubId];
```
[VERIFIED: scope.ts:27-76 — the exact exhaustiveness pattern, confirmed at line 70-75]

**The simplest approach for package lifecycle:** Extend `hub-inventory.ts` (required for Decision 3) and add no-op cases to all others. Do NOT create a dedicated `packageLifecycleReducer` unless other phases need it — the existing pattern is lowest-surface.

---

## VQ#5 — ws envelope + OL map layer (VIZ-13)

### ws envelope approach

**Option A (recommended): add `inductionEvents` array to `TickPayload`**

```typescript
// packages/api/src/ws/envelope.ts — extend TickPayload:
export interface InductionEvent {
  readonly packageId:       string;
  readonly inductionHubId:  string;
  readonly destHubId:       string;
  readonly slaClass:        string;
  readonly slaDeadlineIso:  string;
  readonly occurredAt:      string;
}

// TickPayload gains:
readonly inductionEvents?: readonly InductionEvent[];
```

This follows the `exceptionsNew?: readonly ExceptionItem[]` additive pattern [VERIFIED: envelope.ts:200]. The `diffTick` function ignores fields not explicitly diffed (it passes them through), so the planner can include `inductionEvents` as a direct array on the tick.

The broadcast path in `snapshots.ts` populates this from `PackageInducted` events processed in the current tick. The client consumes it to trigger the pulsing animation.

**Because induction events are transient (animate once, then disappear):** the pulsing animation is purely client-side triggered by receiving the message — no persistent map feature needs to be stored. This is different from trailer stop markers (which persist for a duration).

### OL layer: pulsing circle (VIZ-13)

**Pattern to follow:** `createTrailerStopLayer()` in layers.ts:225-229 — a `VectorSource` + `VectorLayer` with a `StyleFunction`.

For induction, the animation is a pulsing circle that appears briefly and fades. Two approaches:

**A (simpler, recommended for MVP):** A timed feature — add an `InductionFlash` feature to the source, then use `setTimeout` to remove it after N ms. This keeps the OL source as the single source of truth and avoids manual animation logic.

**B (more visual):** Use `postrender` + `requestAnimationFrame` for a CSS-like pulse. This matches the trailer tween approach in `animate.ts` but is more complex.

The planner should choose A (simpler). New files:
- `packages/web/src/map/inductionColoring.ts` — `inductionStyle` pre-allocated `Style` (pulsing purple/orange circle with a "+" glyph)
- `packages/web/src/map/layers.ts` — add `createInductionLayer(): Layer` function

[VERIFIED: layers.ts:225-271 for `createTrailerStopLayer()` + `applyTrailerStops()` pattern; stopColoring.ts:53-92 for zero-alloc style pattern]

---

## VQ#6 — Determinism keystone: golden byte-identity with flag OFF

**The gate:** `inductionEnabled: false` (or absent from opts) → `inductionRng` is `undefined` → zero `PackageInducted` events → existing `seed-1234/durationTicks-6000` golden and `seed-42/durationTicks-10000` golden are byte-identical.

**Evidence of the pattern working:** `fuelOn = fuelConfig.enabled === true` (engine.ts:436). When `fuelOn` is false, `fuelRng` is `undefined` (engine.ts:496-500: `const fuelRng: Rng | undefined = fuelOn ? ... : undefined`). Zero fuel events. The `fuel-determinism.unit.test.ts:62-68` confirms this as a gate: "fuel absent ⇒ NO TruckRested / TruckRefueled events".

**Test to write (DET-01 regression for induction):**
```typescript
// packages/simulation/test/induction-determinism.unit.test.ts
it("inductionEnabled absent → ZERO PackageInducted events (DET-01)", () => {
  const s = simulate({ seed: 42, durationTicks: 3000 });
  expect(s.map(e => e.event.type)).not.toContain("PackageInducted");
});

it("inductionEnabled: false → byte-identical to no-flag (DET-01)", () => {
  const a = simulate({ seed: 42, durationTicks: 1000 });
  const b = simulate({ seed: 42, durationTicks: 1000, inductionEnabled: false });
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});
```

---

## VQ#7 — Continuation-equivalence: the induction case

**The critical scenario:** A chunked run with `inductionEnabled: true` where a chunk boundary falls between two scheduled induction firings. The continuation must carry:
1. `rng.induction` — the inductionRng state after the last draw (so the next chunk picks up exactly where it left off).
2. The pending `{ kind: "inductPackage", tick: N }` task in `continuation.queue` — so the resume re-fires at tick N, not at tick 0 or later.

Both are automatic given the implementation in VQ#2: `inductionRng?.getState()` captures the RNG state, and `queue.snapshot()` captures all pending tasks including any un-fired `inductPackage`. [VERIFIED: engine.ts:1590-1598]

**Test to add to `continuation-equivalence.unit.test.ts`:**

```typescript
// In the existing SEEDS × HORIZONS matrix, add a combo with inductionEnabled:true
// Keep horizon SHORT (≤ 200 ticks) and chunk coarse (7 or 50) for gate-hygiene.
// SCALE-BOUND: do NOT add another O(horizon × seeds) matrix — extend ONE seed + short horizon.

const INDUCTION_ON: Omit<FeatureOpts, "seed" | "durationTicks"> = {
  inductionEnabled: true,
  timing: SHORT_TIMING, // reuse existing SHORT_TIMING constant
};
it("inductionEnabled: chunked(7) == all-at-once (seed 42, h 100) — chunk boundary between arrivals", () => {
  const allAtOnce = simulate({ seed: 42, durationTicks: 100, inductionEnabled: true });
  const chunked   = chunkedStream(42, 100, 7, INDUCTION_ON);
  expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
  expect(chunked.length).toBe(allAtOnce.length);
});
```

[VERIFIED: continuation-equivalence.unit.test.ts:66-100 for the existing matrix structure and `chunkedStream` helper]

**Gate-hygiene rationale:** The adversarial test (`continuation-adversarial.unit.test.ts`) already proves the property at chunk-1 over a short horizon for ALL_ON flags (lines 140-155). The new induction case slots in at the SAME scale (horizon ≤ 200, chunk ≥ 7) — never a long-horizon + many-seed + chunk-1 matrix. [VERIFIED: continuation-adversarial.unit.test.ts:140-155]

---

## Standard Stack

No new runtime dependencies. Phase 20 is a pure extension of existing packages.

| Package | Version | Role |
|---------|---------|------|
| `@mm/domain` | internal | `PackageInducted` schema + union |
| `@mm/simulation` | internal | `inductionRng` + `SimTask` + `SimContinuation` |
| `@mm/projections` | internal | reducer cases for `PackageInducted` |
| `@mm/optimizer` | internal | `TwinBlock.deadlineMin?` + `scope.ts` classification |
| `@mm/api` | internal | ws message for induction events |
| `@mm/web` | internal | `inductionLayer` + `inductionColoring` |
| `zod` | 4.4.x (existing) | `packageInductedSchema` |
| `ol` | 10.9.x (existing) | `createInductionLayer()` |
| `vitest` | 4.1.x (existing) | new test files |

---

## Architecture Patterns

### System Architecture Diagram

```
[inductionRng (seed ^ INDUCTION_RNG_SALT)]
        |
        v
[inductPackage(tick) — self-rescheduling EventQueue task]
  |-- draw: inductionHubId, destHubId, slaClass from inductionRng
  |-- derive: slaDeadlineIso = occurredAt + expectedTransitMinutes(...) + SLA_BUFFER
  |-- emit: PackageInducted → event stream
  |-- scheduleNext(tick + INTERVAL, { kind:"inductPackage", tick: N })
        |
        v
[Event store append-only log]
        |
    ┌───┴───────────────────────────────────────┐
    v                                           v
[hub-inventory reducer]                [scope.ts detectAffectedScope]
  → inbound[inductionHubId].add(pkgId)    → [inductionHubId, destHubId]
        |                                           |
        v                                           v
[hub_inventory projection table]        [Rolling optimizer epoch]
  (optimizer reads automatically —        → TwinBlock.deadlineMin?
   Decision 3 satisfied)                  → slack/critical-ratio priority
        |
        v
[broadcast(simMs)] in snapshots.ts
  → TickPayload.inductionEvents = [{ hubId, ... }]
        |
        v
[WsProvider in web client]
  → inductionLayer feature add + timeout remove
  → pulsing circle at inductionHubId lon/lat
```

### Recommended Project Structure (new files only)

```
packages/domain/src/events/
├── schemas.ts              # ADD packageInductedSchema
├── domain-event.ts         # ADD PackageInducted type + union member
├── contract.assert.ts      # ADD "PackageInducted" case
└── index.ts                # ADD re-exports

packages/simulation/src/
├── engine.ts               # ADD INDUCTION_RNG_SALT, inductPackage(), dispatch case, flag gate
└── continuation.ts         # ADD SimTask variant, SerializedRngStates.induction field

packages/simulation/test/
└── induction-determinism.unit.test.ts  # NEW — IND-02 golden/flag-off tests

packages/projections/src/reducers/
├── hub-inventory.ts        # ADD PackageInducted → inbound case (Decision 3)
├── package-location.ts     # ADD no-op case
├── trailer-state.ts        # ADD no-op case
├── driver-status.ts        # ADD no-op case
├── driver-assignment.ts    # ADD no-op case
├── tag-registry.ts         # ADD no-op case
├── zone-estimate.ts        # ADD no-op case
└── exceptions.ts           # ADD no-op case

packages/optimizer/src/rolling/
├── scope.ts                # ADD hubsOf case for PackageInducted
└── types.ts                # ADD TwinBlock.deadlineMin? optional field

packages/api/src/ws/
└── envelope.ts             # ADD InductionEvent + TickPayload.inductionEvents?

packages/web/src/map/
├── inductionColoring.ts    # NEW — pre-allocated Style for pulsing induction marker
└── layers.ts               # ADD createInductionLayer()
```

### Pattern: Adding to the closed event union (IND-01)

The canonical 5-file sequence documented in VQ#1. Key invariant: all 5 changes must land in the SAME commit or the build (`pnpm build` + `pnpm typecheck`) fails due to:
1. `Exact<Inferred, DomainEvent>` type-equality proof in `contract.assert.ts:68` failing if `domainEventSchema` has the new member but `DomainEvent` does not (or vice versa).
2. `assertExhaustive` switch in `contract.assert.ts:25` failing if `DomainEvent` has the new member but the switch does not.

### Pattern: Opt-in RNG substream (IND-02)

Mirrors `hosEnabled`/`fuelOn` at engine.ts:427-500. Three properties must be consistent:
1. Salt constant exported (for salt-collision test) [engine.ts:71-103]
2. `Rng | undefined` constructed only when enabled [engine.ts:496-500]
3. State captured as `T | undefined` in `SerializedRngStates` [continuation.ts:103]

### Anti-Patterns to Avoid

- **Do NOT pre-schedule far ahead:** The induction task should schedule at most ONE next induction at a time (`inductPackage` reschedules at `tick + INTERVAL`). Never schedule multiple future inductions upfront — this would bloat the queue and could mis-order with other events.
- **Do NOT draw from `inductionRng` when `inductionOn` is false:** Even a single errant draw would perturb the stream at seed ^ INDUCTION_RNG_SALT if someone accidentally constructs the RNG off-path.
- **Do NOT put `slaDeadlineIso` on the `SimContinuation`:** It is derived at event-emission time from the virtual clock and is part of the emitted event payload, not the continuation state. The continuation only carries RNG state + queue.
- **Do NOT add `PackageInducted` to `SnapshotPayload.induction` as a persistent set:** Induction events are transient — they fire once and the resulting `hub_inventory.inbound` row persists. The ws message carries them as a transient `inductionEvents` array in the tick delta; no snapshot accumulation needed.
- **Do NOT use `Date.now()` for `slaDeadlineIso`:** Must derive from `clock.nowIso()` (virtual clock) only.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hub→hub travel estimate | Custom distance calc | `expectedTransitMinutes(from, to, config)` from `@mm/domain` | Pure, tested, same function the optimizer uses |
| SLA vocabulary | New enums | `SlaClass`, `SLA_CLASS_WEIGHT` from `packages/domain/src/planning/index.ts` | Single source of truth already shared with aggregation + load planner |
| RNG substream capture | Manual state dump | `rng.getState()` / `makeRngFromState(state)` from `rng.ts` | Existing contract; changing this would invalidate goldens |
| Exhaustiveness enforcement | Runtime checks | `assertNever()` / `assertNeverEvent()` — compile-time contract.assert.ts | Already enforced at build gate |
| Queue persistence | Custom serialization | Add to `SimTask` union — captured automatically by `queue.snapshot()` | Existing serialization infrastructure handles it |

---

## Common Pitfalls

### Pitfall 1: Breaking the build by touching domain without touching all 5 files atomically
**What goes wrong:** Adding `PackageInducted` to `DomainEvent` but forgetting `contract.assert.ts` → compile error. Or adding to schemas.ts but not to `domainEventSchema` discriminated union → type-equality proof fails.
**How to avoid:** Wave 0 task should add all 5 domain files in ONE commit. Run `pnpm build` (turbo) immediately — it will catch the contract mismatch as a TS error, not a test failure.
**Warning signs:** `Type 'false' is not assignable to type 'true'` from the `_zodMatchesHandWrittenUnion` constant.

### Pitfall 2: Forgetting reducer no-op cases (silent build failure)
**What goes wrong:** `PackageInducted` joins `DomainEvent`; any reducer with `default: return assertNeverEvent(event)` now has `event: PackageInducted` hitting the default at runtime — OR the TypeScript compiler catches it at `pnpm typecheck`. The build fails ONLY if TypeScript's exhaustiveness narrows correctly (which it does for the `never` pattern).
**How to avoid:** After adding the union member, run `pnpm typecheck`. Each missing case is a TS error. The planner should list ALL 8+ reducer files as tasks.
**Warning signs:** `Argument of type 'PackageInducted' is not assignable to parameter of type 'never'` at `assertNeverEvent(event)`.

### Pitfall 3: `scope.ts` forgetting `PackageInducted` → optimizer silent no-op
**What goes wrong:** `hubsOf()` in scope.ts has an exhaustive switch. Missing `PackageInducted` case → TypeScript exhaustiveness error (same pattern as reducers). But if accidentally placed in the `return []` group (instead of returning `[inductionHubId, destHubId]`), inducted packages are scope-neutral and the optimizer never reacts to them.
**How to avoid:** The case MUST return `[event.payload.inductionHubId, event.payload.destHubId]` — not `[]`. Verify with an integration test that after a `PackageInducted` event, the rolling epoch's scope includes both hub ids.

### Pitfall 4: `SerializedRngStates.induction` forgotten → continuation diverges with inductionEnabled:true
**What goes wrong:** The continuation is captured without `induction: inductionRng?.getState()`. On resume, the induction substream restarts from `makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0)` instead of from the captured state → different draws → different `PackageInducted` events → chunked ≠ all-at-once.
**How to avoid:** The continuation-equivalence test with `inductionEnabled: true` catches this immediately (hash mismatch). This is the make-or-break gate.
**Warning signs:** Chunked hash ≠ all-at-once hash in `induction-continuations.unit.test.ts`.

### Pitfall 5: `slaDeadlineIso` uses wall clock
**What goes wrong:** `new Date(Date.now() + offsetMs).toISOString()` instead of virtual clock → deadlines are wall-clock anchored → not deterministic across runs → continuation equivalence test flakes on timing.
**How to avoid:** Always `epochMinutesToIso(isoToEpochMinutes(clock.nowIso()) + deadlineMin)`. Both helpers are already imported in engine.ts.

### Pitfall 6: Heavy continuation-equivalence matrix in the gate
**What goes wrong:** Adding a full `SEEDS × HORIZONS × chunks` matrix for `inductionEnabled: true` — e.g., 4 seeds × 3 horizons × 3 chunks = 36 test cases, each running the full stream — bloating gate runtime past the ~15 min target.
**How to avoid:** Add EXACTLY ONE induction continuation-equivalence case: `seed=42, horizon=100, chunk=7`. The property is seed-independent once proven at worst-case chunk-1 (which the adversarial test already covers for ALL_ON). If the planner extends `ALL_ON` in the adversarial test to include `inductionEnabled: true`, no separate test file is needed.

### Pitfall 7: `InductionEvent` in `SnapshotPayload` instead of `TickPayload`
**What goes wrong:** Placing `inductionEvents` in `SnapshotPayload` — the full baseline sent on connect — means the client re-animates all inductions ever on every reconnect, and `diffTick` must handle them.
**How to avoid:** Place in `TickPayload` only (additive optional field). The snapshot has no `inductionEvents` (they're transient). The `diffTick` function passes TickPayload fields through unchanged.

---

## Runtime State Inventory

Phase 20 is not a rename/refactor/migration phase. No runtime state inventory required.

---

## Environment Availability

Phase 20 is purely code changes to existing packages. No new external dependencies.

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| Node.js 22 LTS | Engine, tests | ✓ | No change |
| Postgres (existing) | Integration tests | ✓ | No schema changes for Phase 20 |
| `ol` 10.9.x | `createInductionLayer()` | ✓ | Already in web package |
| `vitest` 4.1.x | New test files | ✓ | No change |

---

## Validation Architecture

`workflow.nyquist_validation` is not set to `false` in config.json — validation section required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x |
| Config file | `vitest.config.ts` at repo root |
| Quick run command | `pnpm test` (turbo build + vitest unit) |
| Full suite command | `pnpm test:all` (unit + integration + ui) |
| Type gate | `pnpm typecheck` (MUST run after every domain change) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IND-01 | `packageInductedSchema` validates a well-formed event | unit | `vitest run packages/domain` | ❌ Wave 0 |
| IND-01 | `validate(buildPackageInducted(...))` round-trips without error | unit | same file | ❌ Wave 0 |
| IND-01 | `contract.assert.ts` exhaustiveness — build gate, not a test | build | `pnpm build` / `pnpm typecheck` | n/a |
| IND-02 | `inductionEnabled: false` → zero `PackageInducted` events | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ Wave 0 |
| IND-02 | `inductionEnabled: false` → byte-identical to absent flag (DET-01 regression) | unit | same file | ❌ Wave 0 |
| IND-02 | `INDUCTION_RNG_SALT` pairwise-distinct from all 5 existing salts | unit | `vitest run packages/simulation/test/fuel-determinism.unit.test.ts` | ✅ extend existing |
| IND-02 | `inductionEnabled: true` → `PackageInducted` events present | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ Wave 0 |
| IND-02 | Continuation-equivalence with `inductionEnabled: true` (chunk boundary between arrivals) | unit | `vitest run packages/simulation/test/continuation-equivalence.unit.test.ts` | ✅ add case |
| IND-03 | `slaDeadlineIso` is deterministic and > `occurredAt` | unit | `vitest run packages/simulation/test/induction-determinism.unit.test.ts` | ❌ Wave 0 |
| IND-03 | `hub_inventory[inductionHubId].inbound` gains the package on `PackageInducted` | unit | `vitest run packages/projections/test/hub-inventory.unit.test.ts` | ✅ extend existing |
| IND-03 | `detectAffectedScope` returns `[inductionHubId, destHubId]` for `PackageInducted` | unit | `vitest run packages/optimizer/test/scope.unit.test.ts` | ✅ extend existing |
| VIZ-13 | `TickPayload.inductionEvents` present on ticks containing inductions | unit | `vitest run packages/api/test/` | ❌ Wave 0 |

### Scale Bounds (Gate-Hygiene)

- Continuation-equivalence for `inductionEnabled: true`: **ONE case only** — `seed=42, horizon=100, chunk=7`. Run time < 1 second.
- `induction-determinism.unit.test.ts`: use `durationTicks: 500` max. All existing determinism golden tests use ≤ 10000 ticks; new induction tests should use ≤ 1000 ticks.
- Do NOT extend the `continuation-adversarial.unit.test.ts` SEEDS × HORIZONS matrix — add `inductionEnabled: true` to `ALL_ON` constant if desired (1-line change, same test budget).

### Sampling Rate

- **Per task commit:** `pnpm build && pnpm typecheck` (catches union/contract failures immediately)
- **Per task commit:** `pnpm test` (vitest unit)
- **Per wave merge:** `pnpm test:all`
- **Phase gate:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` all green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/domain/src/events/schemas.ts` + `domain-event.ts` + `contract.assert.ts` + `index.ts` + barrel — IND-01 domain event (5 files, one commit)
- [ ] `packages/simulation/src/engine.ts` + `continuation.ts` — INDUCTION_RNG_SALT, SimTask, dispatch, flag gate, captureContinuation
- [ ] `packages/simulation/test/induction-determinism.unit.test.ts` — DET-01 flag-off golden + IND-02 events-present + IND-03 deadline sanity
- [ ] `packages/projections/src/reducers/hub-inventory.ts` + all other reducers — PackageInducted cases (8+ files)
- [ ] `packages/optimizer/src/rolling/scope.ts` + `types.ts` — hubsOf case + TwinBlock.deadlineMin?
- [ ] `packages/api/src/ws/envelope.ts` — InductionEvent + TickPayload.inductionEvents?
- [ ] `packages/web/src/map/inductionColoring.ts` (NEW) + `layers.ts` update — VIZ-13

*(Existing `fuel-determinism.unit.test.ts`, `continuation-equivalence.unit.test.ts`, hub-inventory tests, scope tests require extension — NOT replacement)*

---

## Security Domain

Phase 20 makes no changes to authentication, session management, input validation at API boundaries, or cryptography. The `externalOriginRef` and all induction IDs are deterministically generated by the simulation engine (not user-supplied). No ASVS categories are implicated. The `slaDeadlineIso` field is a sim-clock-derived ISO string — not user-facing input.

---

## Open Questions (RESOLVED)

> All four questions below carry inline recommendations that the Phase 20 plans implement:
> Q1 (package-location update) → Plan 03 sets location to `inductionHubId` (active case);
> Q2 (`externalOriginRef` format) → Plan 02 uses a separate `inductionCounter` with `EXT-NNNNN`;
> Q3 (VIZ-13 animation) → Plan 05 uses the timed-feature add/remove approach;
> Q4 (`INDUCTION_INTERVAL_TICKS`) → Plan 02 starts at 30 ticks as a tunable `SimulateOptions` value.

1. **`package-location.ts` — should `PackageInducted` update last-known-location?**
   - What we know: `PackageArrivedAtHub` updates last-known location to the arrival hub. `PackageInducted` places freight at the `inductionHubId`.
   - What's unclear: Whether the location read model should show inducted packages at their induction hub (useful for debugging/UI) or whether only `PackageArrivedAtHub` and `PackageScanned` should update location.
   - Recommendation: Update location to `inductionHubId` — it mirrors the `PackageArrivedAtHub` path and makes the operator UI show inducted freight immediately. This is Claude's discretion (CONTEXT.md).

2. **`externalOriginRef` format and uniqueness**
   - What we know: CONTEXT.md suggests `EXT-P000NN` format. The engine has a `packageCounter` for `PackageCreated` ids (`P${String(counter).padStart(5, "0")}`).
   - Recommendation: Use a SEPARATE `inductionCounter` (reset at 0 on fresh run, restored in `SerializedWorldState`) with `EXT-${String(inductionCounter).padStart(5, "0")}` format. Add `inductionCounter: number` to `SerializedWorldState` (continuation.ts:76-93).

3. **VIZ-13 animation approach — timed feature vs postrender pulse**
   - What we know: `createTrailerStopLayer()` uses a plain `VectorSource` with features added/removed. `animate.ts` uses `postrender` for trailer tweens.
   - Recommendation: Use the timed-feature approach (add feature, `setTimeout(removeFeature, 2000ms)`). Simpler and consistent with the stop-layer pattern. A `postrender` pulse is beautiful but adds complexity disproportionate to an MVP demo. This is Claude's discretion.

4. **`INDUCTION_INTERVAL_TICKS` tuning**
   - What we know: 1 tick = 1 minute. The transit between center and spokes is ~150-400 minutes.
   - Recommendation: Start with `INDUCTION_INTERVAL_TICKS = 30` (one induction every 30 sim-minutes per batch) as a tunable constant. This gives ~2 inductions per hour per spoke, visible without overwhelming. Make it a `SimulateOptions` config value (Claude's discretion).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `catchup.ts` reducers (`auditTimelineReducer`, `geoTrackReducer`) also have exhaustive switches needing `PackageInducted` cases | VQ#4 | If they don't use assertNeverEvent, fewer files to touch — no regression risk, just unnecessary caution |
| A2 | `SHORT_TIMING` constant exists in `continuation-adversarial.unit.test.ts` and can be reused for the induction continuation test | VQ#7 | If it doesn't exist, define it locally in the new test — minor inconvenience only |

All other claims in this research were VERIFIED against source files in this session.

---

## Sources

### Primary (HIGH confidence — direct source reads this session)

- `packages/domain/src/events/schemas.ts` — `eventSchema` factory (lines 34-43), all existing schemas, `domainEventSchema` discriminated union (lines 393-419)
- `packages/domain/src/events/domain-event.ts` — `DomainEvent` union (lines 140-165), `assertNever` (lines 176-180)
- `packages/domain/src/events/contract.assert.ts` — exhaustive switch (lines 25-53), type-equality proof (lines 61-69)
- `packages/domain/src/events/index.ts` — re-export pattern (lines 1-56)
- `packages/domain/src/planning/index.ts` — `SlaClass`, `SLA_CLASS_WEIGHT`, `DeadlineBucket`, `PlanningPackage` (lines 32-102)
- `packages/domain/src/timing-geo.ts` — `expectedTransitMinutes`, `expectedDwellMinutes`, `haversineKm`, `transitParamsForLeg` (complete file)
- `packages/simulation/src/engine.ts` — salt constants (lines 71-103), substream construction pattern (lines 430-500), `createPackageBatch` self-rescheduling (lines 904-925), `dispatch()` (lines 1488-1517), `scheduleNext()` (lines 1484-1486), bootstrap (lines 1520-1533), drain loop (lines 1543-1556), `captureContinuation()` (lines 1558-1603)
- `packages/simulation/src/continuation.ts` — `SimTask` union (lines 27-51), `SerializedScheduled` (lines 53-58), `SerializedWorldState` (lines 76-93), `SerializedRngStates` (lines 95-104), `SimContinuation` (lines 109-136)
- `packages/simulation/src/rng.ts` — `getState()`, `makeRngFromState()` (lines 29-92)
- `packages/simulation/test/fuel-determinism.unit.test.ts` — salt-collision assertion (lines 43-56)
- `packages/simulation/test/continuation-equivalence.unit.test.ts` — `chunkedStream`, SEEDS, HORIZONS, `chunksForHorizon` (lines 1-100)
- `packages/simulation/test/continuation-adversarial.unit.test.ts` — `ALL_ON` feature flags, scale-bounding rationale (lines 55-73, 140-155)
- `packages/projections/src/reducers/hub-inventory.ts` — `hubInventoryReducer` switch (lines 158-217), `placePackage` / `withPackage` / `EMPTY_HUB` helpers (lines 79-131)
- `packages/projections/src/reducers/package-location.ts` — `packageLocationReducer` switch (lines 60-107)
- `packages/projections/src/reducers/reducer.ts` — `assertNeverEvent` (lines 37-39)
- `packages/projections/src/reducers/index.ts` — full reducer barrel (complete file)
- `packages/optimizer/src/rolling/scope.ts` — `hubsOf()` exhaustive switch (lines 27-76), `detectAffectedScope` (lines 106-123)
- `packages/optimizer/src/rolling/types.ts` — `TwinBlock` interface (lines 50-56), `TwinSnapshot`, `EpochInput` (lines 135-213)
- `packages/api/src/ws/envelope.ts` — `WsEnvelope` union (lines 223-225), `TickPayload` (lines 182-205), `SnapshotPayload` (lines 160-179), `diffTick` (lines 290+), `InductionEvent` shape modeled on `ExceptionItem` (lines 109-121)
- `packages/web/src/map/layers.ts` — `createTrailerStopLayer()` (lines 225-229), `applyTrailerStops()` (lines 244-271), `createHubLayer()` (lines 38-57)
- `packages/web/src/map/stopColoring.ts` — zero-alloc StyleFunction pattern (lines 53-92)
- `packages/web/src/map/coloring.ts` — pre-allocated style cache pattern (lines 1-60)

### Secondary (MEDIUM confidence)

- `.planning/phases/19-continuous-operation-foundation/19-RESEARCH.md` — Phase 19 research (VQ#1-VQ#12, all VERIFIED against source)
- `.planning/phases/19-continuous-operation-foundation/19-PATTERNS.md` — verified pattern extracts
- `.planning/phases/19-continuous-operation-foundation/19-07-SUMMARY.md` — sort-wave (CONT-05) opt-in gating pattern
- CONTEXT.md, REQUIREMENTS.md — design decisions + requirement descriptions

---

## Metadata

**Confidence breakdown:**
- Domain event add protocol: HIGH — read all 5 files, exact pattern confirmed
- Simulation engine opt-in gating: HIGH — confirmed against `hosEnabled`/`fuelOn` patterns
- Continuation capture: HIGH — `captureContinuation()` read line-by-line; `fuel: rng?.getState()` pattern confirmed
- Reducer exhaustiveness requirements: HIGH — read all reducer files, confirmed `assertNeverEvent` in all defaults
- `scope.ts` exhaustiveness: HIGH — confirmed exact same `const _never: never = event` pattern
- `expectedTransitMinutes` signature + availability: HIGH — read timing-geo.ts
- ws envelope extension: HIGH — read envelope.ts fully; `ExceptionItem`/`exceptionsNew` pattern confirmed
- OL map layer pattern: HIGH — read layers.ts + stopColoring.ts + coloring.ts

**Key corrections to CONTEXT.md:**
1. CONTEXT.md says "induction RNG substream state MUST be carried in `SimContinuation`" — CONFIRMED CORRECT and already implemented as the `fuel: number | undefined` pattern shows.
2. CONTEXT.md says "self-rescheduling `EventQueue` task (like `createPackageBatch` at engine.ts:904)" — CONFIRMED CORRECT but the helper is now `scheduleNext()` (engine.ts:1484) not `schedule()` directly, a Plan 19-08 refinement.
3. The `dispatch()` function at engine.ts:1488 is the SINGLE point to add new task cases — CONTEXT.md is correct.
4. The `runToHorizon` function (NOT `simulate()`) is the entry point for chunked runs — CONTEXT.md implies `simulate()` but the continuation API uses `runToHorizon`.

**Research date:** 2026-06-24
**Valid until:** 2026-07-24 (stable codebase; 30-day window)
