# Phase 22: Outbound Delivery - Pattern Map

**Mapped:** 2026-06-25
**Files analyzed:** 18 new/modified files
**Analogs found:** 18 / 18

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/domain/src/events/schemas.ts` | model | transform | self (add `packageDeliveredSchema` after `packageInductedSchema`) | exact |
| `packages/domain/src/events/domain-event.ts` | model | transform | self (add `PackageDelivered` type + union member after `PlanSuperseded`) | exact |
| `packages/domain/src/events/contract.assert.ts` | model | transform | self (add `"PackageDelivered"` case; `"PackageInducted"` is adjacent template) | exact |
| `packages/domain/src/events/index.ts` | config | transform | self (add exports after `PackageInducted`/`packageInductedSchema`) | exact |
| `packages/domain/src/ingestion/validate.ts` | utility | transform | self (no change — `validateEvent` uses `domainEventSchema` union; adding schema member extends it automatically) | exact |
| `packages/domain/test/package-delivered.unit.test.ts` | test | request-response | `packages/domain/test/package-inducted.unit.test.ts` | exact |
| `packages/simulation/src/engine.ts` | service | event-driven | self (`INDUCTION_RNG_SALT`+`inductPackage`+`arriveTrailer`+`captureContinuation` are the templates) | exact |
| `packages/simulation/src/continuation.ts` | model | event-driven | self (`SimTask`+`SerializedRngStates`+`SerializedWorldState` with induction additions as template) | exact |
| `packages/simulation/test/outbound-determinism.unit.test.ts` | test | event-driven | `packages/simulation/test/induction-determinism.unit.test.ts` | exact |
| `packages/simulation/test/fuel-determinism.unit.test.ts` | test | event-driven | self (extend salts array to include `OUTBOUND_RNG_SALT`) | exact |
| `packages/simulation/test/continuation-equivalence.unit.test.ts` | test | event-driven | self (add `"outbound"` FEATURE_CASE following `"consolidation"` pattern) | exact |
| `packages/projections/src/reducers/package-location.ts` | service | CRUD | self (`PackageInducted` case and no-op list are the templates for a new case) | exact |
| `packages/projections/src/reducers/hub-inventory.ts` | service | CRUD | self (`placePackage(state, packageId, null)` pattern for DELETE purge) | exact |
| `packages/projections/src/reducers/zone-estimate.ts` | service | CRUD | self (no-op list pattern; `PackageInducted` case at line 200 is the template) | exact |
| `packages/projections/src/reducers/delivery-kpi.ts` | service | CRUD | `packages/projections/src/reducers/hub-inventory.ts` (event-derived counter; no prior pure-counter reducer exists) | role-match |
| `packages/api/src/ws/envelope.ts` | model | request-response | self (`InductionEvent` + `TickPayload.inductionEvents` are the template; `SnapshotPayload` must NOT be modified) | exact |
| `packages/api/src/ws/snapshots.ts` | service | request-response | self (`Broadcast` type signature; add `deliveryEvents` parameter) | exact |
| `packages/api/test/ws-delivery.unit.test.ts` | test | request-response | `packages/api/test/ws-induction.unit.test.ts` | exact |
| `packages/web/src/map/layers.ts` | component | event-driven | self (`createInductionLayer`/`flashInduction` lines 248-278 are the exact template) | exact |
| `packages/web/src/map/deliveryColoring.ts` | utility | transform | `packages/web/src/map/inductionColoring.ts` | exact |
| `packages/web/src/panels/DeliveryKpi.tsx` | component | request-response | `packages/web/src/panels/HubBalance.tsx` | exact |

---

## Pattern Assignments

### `packages/domain/src/events/schemas.ts` (model, transform)

**Analog:** self — `packageInductedSchema` at line 430 is the exact template.

**Imports pattern** (lines 1-9):
```typescript
import { z } from "zod";
import {
  // ...entity/planning schemas...
} from "../entities/index.js";
import { slaClassSchema } from "../planning/index.js";
```

**eventSchema helper** (lines 35-44):
```typescript
function eventSchema<TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  payload: z.ZodObject<TShape>,
) {
  return z.object({
    type: z.literal(type),
    schemaVersion,
    payload: payload.strict(),
  });
}
```

**Core pattern — `packageInductedSchema` template** (lines 430-441):
```typescript
export const packageInductedSchema = eventSchema(
  "PackageInducted",
  z.object({
    packageId: id,
    inductionHubId: id,
    destHubId: id,
    slaClass: slaClassSchema,
    slaDeadlineIso: z.string().min(1),
    externalOriginRef: id,
    occurredAt,
  }),
);
```

**Phase 22 addition** — insert after `packageInductedSchema`, before `domainEventSchema`:
```typescript
export const packageDeliveredSchema = eventSchema(
  "PackageDelivered",
  z.object({
    packageId: id,
    hubId: id,
    deliveredAt: z.string().min(1),
    onTime: z.boolean(),
    occurredAt,
  }),
);
```

**`domainEventSchema` union** (lines 448-478) — add `packageDeliveredSchema` as the final entry:
```typescript
export const domainEventSchema = z.discriminatedUnion("type", [
  // ...all existing schemas...
  packageInductedSchema,
  planSupersededSchema,
  packageDeliveredSchema,  // Phase 22 — LAST entry
]);
```

---

### `packages/domain/src/events/domain-event.ts` (model, transform)

**Analog:** self — `PackageInducted` at line 145 and `PlanSuperseded` at line 157 are the adjacent templates.

**Import addition** (lines 1-28) — add `packageDeliveredSchema` to the import block:
```typescript
import type {
  // ...existing imports...
  packageDeliveredSchema,   // Phase 22 addition
} from "./schemas.js";
```

**Type definition pattern** (line 145, `PackageInducted` template):
```typescript
export type PackageInducted = z.infer<typeof packageInductedSchema>;
// Phase 22 — add directly after PackageInducted block:
export type PackageDelivered = z.infer<typeof packageDeliveredSchema>;
```

**Union extension** (lines 165-194) — `DomainEvent` union tail:
```typescript
export type DomainEvent =
  // ...existing members...
  // v2.0 external induction (IND-01).
  | PackageInducted
  // Phase-21 bidirectional freight / consolidation (FLOW-04 / D-21-1).
  | PlanSuperseded
  // Phase-22 terminal delivery event (OUT-01).
  | PackageDelivered;
```

---

### `packages/domain/src/events/contract.assert.ts` (model, transform)

**Analog:** self — the exhaustive switch at lines 25-55 must gain a new case.

**Core pattern** (lines 25-55):
```typescript
function assertExhaustive(event: DomainEvent): void {
  switch (event.type) {
    case "HubRegistered":
    // ...all 22 existing cases...
    case "PackageInducted":
    case "PlanSuperseded":
      return;
    default:
      assertNever(event);
  }
}
```

**Phase 22 addition** — add `case "PackageDelivered":` before the existing `return` (alongside `PackageInducted` and `PlanSuperseded`):
```typescript
    case "PackageInducted":
    case "PlanSuperseded":
    case "PackageDelivered":   // Phase 22
      return;
```

**Critical:** The type-equality proof at line 70 (`const _zodMatchesHandWrittenUnion: Exact<Inferred, DomainEvent> = true`) automatically covers the new type — no separate change needed there.

---

### `packages/domain/src/events/index.ts` (config, transform)

**Analog:** self — `PackageInducted` at line 28 (type export) and `packageInductedSchema` at line 58 (schema export) are the templates.

**Type export addition** (lines 1-30):
```typescript
export type {
  // ...existing type exports...
  PackageInducted,
  PlanSuperseded,
  PackageDelivered,   // Phase 22 — add after PlanSuperseded
} from "./domain-event.js";
```

**Schema export addition** (lines 32-60):
```typescript
export {
  // ...existing schema exports...
  packageInductedSchema,
  planSupersededSchema,
  packageDeliveredSchema,   // Phase 22 — add after planSupersededSchema
} from "./schemas.js";
```

---

### `packages/domain/test/package-delivered.unit.test.ts` (test, request-response)

**Analog:** `packages/domain/test/package-inducted.unit.test.ts` (lines 1-58) — verbatim copy-and-adapt.

**Imports pattern** (lines 1-7):
```typescript
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  packageInductedSchema,   // → packageDeliveredSchema
  validateEvent,
  type PackageInducted,    // → type PackageDelivered
} from "../src/index.js";
```

**Builder pattern** (lines 17-31):
```typescript
function buildWellFormedPackageInducted(): PackageInducted {
  return {
    type: "PackageInducted",
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: {
      packageId: "EXT-P00001",
      inductionHubId: "hub-spoke-a",
      destHubId: "hub-spoke-b",
      slaClass: "express",
      slaDeadlineIso: "2026-06-24T12:34:00.000Z",
      externalOriginRef: "EXT-00001",
      occurredAt: "2026-06-24T08:00:00.000Z",
    },
  };
}
```

**Phase 22 builder** — adapt to `PackageDelivered` payload shape:
```typescript
function buildWellFormedPackageDelivered(): PackageDelivered {
  return {
    type: "PackageDelivered",
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: {
      packageId: "EXT-P00001",
      hubId: "hub-spoke-b",
      deliveredAt: "2026-06-24T12:34:00.000Z",
      onTime: true,
      occurredAt: "2026-06-24T12:34:00.000Z",
    },
  };
}
```

**Test structure** (lines 33-57) — three tests, same structure:
1. `round-trips a well-formed event through validateEvent()`
2. `packageDeliveredSchema accepts the well-formed event` (via `.safeParse()`)
3. `rejects an extra/unknown payload field (.strict() boundary)` (via `expect(() => validateEvent(bad)).toThrow()`)

---

### `packages/simulation/src/engine.ts` — `OUTBOUND_RNG_SALT` (service, event-driven)

**Analog:** `INDUCTION_RNG_SALT` at line 116.

**Salt constants pattern** (lines 85-116):
```typescript
export const RFID_RNG_SALT       = 0x5f_1d_a7_c3;  // substream 1
export const OVER_CARRY_RNG_SALT = 0x3c_a7_1d_5f;  // substream 2
export const TIMING_RNG_SALT     = 0x00_00_77_17;  // substream 3
export const HOS_RNG_SALT        = 0x10_51_09_01;  // substream 4
export const FUEL_RNG_SALT       = 0x2b_3d_91_e7;  // substream 5 (when fuel.enabled)
export const INDUCTION_RNG_SALT  = 0x8f_2c_4a_e1;  // substream 6 (when inductionEnabled)
```

**Phase 22 addition** — add immediately after `INDUCTION_RNG_SALT`:
```typescript
export const OUTBOUND_RNG_SALT   = 0xc4_f8_32_b6;  // substream 7 (when outboundDeliveryEnabled)
```

**RNG construction pattern** (lines 585-595 — `inductionRng` construction as template):
```typescript
const inductionRng: Rng | undefined = inductionOn
  ? restoredRng && restoredRng.induction !== undefined
    ? makeRngFromState(restoredRng.induction)
    : makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0)
  : undefined;
```

**Phase 22 outboundRng construction** — add immediately after `inductionRng`:
```typescript
const outboundRng: Rng | undefined = outboundOn
  ? restoredRng && restoredRng.outbound !== undefined
    ? makeRngFromState(restoredRng.outbound)
    : makeRng((seed ^ OUTBOUND_RNG_SALT) >>> 0)
  : undefined;
```

**`outboundDeliveryEnabled` flag guard** (analog: `inductionOn` at line 511):
```typescript
const inductionOn = opts.inductionEnabled === true;
// Phase 22 — add:
const outboundOn = opts.outboundDeliveryEnabled === true;
```

---

### `packages/simulation/src/engine.ts` — `SimulateOptions.outboundDeliveryEnabled` (service, event-driven)

**Analog:** `SimulateOptions.inductionEnabled` (lines 269-281).

**Option field pattern** (lines 269-281):
```typescript
/**
 * IND-02: OPT-IN external package induction at spoke hubs. **DEFAULT FALSE —
 * the determinism keystone.** When absent or `false`, the engine emits NO
 * `PackageInducted` events and makes ZERO `inductionRng` draws...
 */
readonly inductionEnabled?: boolean;
```

**Phase 22 addition** — add after `consolidationEnabled` field:
```typescript
/**
 * OUT-01: OPT-IN terminal delivery at destination hubs. **DEFAULT FALSE —
 * the determinism keystone.** When absent or `false`, the engine emits NO
 * `PackageDelivered` events and makes ZERO `outboundRng` draws (the substream
 * is never even constructed), so the existing seed-1234 + seed-42 goldens are
 * BYTE-IDENTICAL (DET-01). When `true`, a seeded one-shot `deliverPackage`
 * EventQueue task fires after a seeded dwell (>= 1 tick) from destination arrival;
 * an `onTime` SLA flag is computed at emit. Fully resumable — the outbound RNG
 * state, pending-delivery task, and `deliveredCounter` are captured in
 * `SimContinuation`. The flag gates ALL outbound behavior; strict `=== true`
 * check (never `??` or `||`).
 */
readonly outboundDeliveryEnabled?: boolean;
```

---

### `packages/simulation/src/engine.ts` — `deliverPackage` task + `arriveTrailer` hook (service, event-driven)

**Analog:** `inductPackage` function (lines 1103-1176) and `arriveTrailer` emit site (lines 1495-1560).

**`inductPackage` core pattern** (lines 1103-1176):
```typescript
const inductPackage = (tick: number): void => {
  if (!inductionOn || inductionRng === undefined) return; // never runs when off

  inductionCounter += 1;
  // ...draw from inductionRng ONLY...
  const inducted: PackageInducted = {
    type: "PackageInducted",
    schemaVersion: 1,
    payload: { packageId, inductionHubId: inductionHub.hubId, destHubId: destHub.hubId,
               slaClass, slaDeadlineIso, externalOriginRef, occurredAt: occurredAtIso },
  };
  emit(`package-${packageId}`, inducted);

  // Self-reschedule the NEXT induction at an ABSOLUTE tick.
  const nextTick = tick + INDUCTION_INTERVAL_TICKS;
  scheduleNext(nextTick, { kind: "inductPackage", tick: nextTick });
};
```

**Phase 22 `deliverPackage`** — ONE-SHOT (no self-rescheduling):
```typescript
const deliverPackage = (
  packageId: string,
  hubId: string,
  slaDeadlineIso: string | undefined,
  fireTick: number,
): void => {
  if (!outboundOn || outboundRng === undefined) return; // never runs when off

  deliveredCounter += 1;
  const deliveredAt = epochMinutesToIso(isoToEpochMinutes(clock.nowIso())); // whole-minute canonical
  const onTime = slaDeadlineIso !== undefined ? deliveredAt <= slaDeadlineIso : true;
  const delivered: PackageDelivered = {
    type: "PackageDelivered",
    schemaVersion: 1,
    payload: { packageId, hubId, deliveredAt, onTime, occurredAt: deliveredAt },
  };
  emit(`package-${packageId}`, delivered);
  slaDeadlineByPackage.delete(packageId); // clean up world state
  // NOT self-rescheduling — one-shot. No scheduleNext() here.
};
```

**`arriveTrailer` hook site** (lines 1554-1559 — after the `PackageArrivedAtHub` emit):
```typescript
      const atHub: PackageArrivedAtHub = {
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId, hubId: spoke.hubId },
      };
      emit(`package-${packageId}`, atHub);
      // Phase 22 — add immediately after the atHub emit:
      if (outboundOn) {
        const dwell = 1 + outboundRng!.int(OUTBOUND_DWELL_TICKS_MAX); // dwell >= 1
        const fireTick = arriveTick + dwell;
        scheduleNext(fireTick, {
          kind: "deliverPackage",
          packageId,
          hubId: spoke.hubId,
          slaDeadlineIso: slaDeadlineByPackage.get(packageId),
          fireTick,
        });
      }
```

**`dispatch` switch addition** (lines 1828-1863 — add before the closing brace):
```typescript
function dispatch(task: SimTask): void {
  switch (task.kind) {
    case "createPackageBatch":  /* ... */ return;
    case "inductPackage":       /* ... */ return;
    case "departTrailer":       /* ... */ return;
    case "arriveTrailer":       /* ... */ return;
    case "midLegStops":         /* ... */ return;
    case "arriveOverCarriedAtCenter": /* ... */ return;
    case "arriveConsolidationAtCenter": /* ... */ return;
    // Phase 22 addition:
    case "deliverPackage":
      deliverPackage(task.packageId, task.hubId, task.slaDeadlineIso, task.fireTick);
      return;
  }
}
```

**`slaDeadlineByPackage` world-state map** — add alongside `consolidationDestByPackage`:
```typescript
// Populate at PackageInducted:
slaDeadlineByPackage.set(packageId, slaDeadlineIso);
// (inside inductPackage, after emit)

// Captured in continuation (like odometerByTrailer):
slaDeadlineByPackage: [...slaDeadlineByPackage.entries()].map(([k, v]) => [k, v] as const),
```

---

### `packages/simulation/src/continuation.ts` (model, event-driven)

**Analog:** self — `SimTask`, `SerializedRngStates`, `SerializedWorldState` with Phase-20 induction additions as templates.

**`SimTask` union pattern** (lines 27-65):
```typescript
export type SimTask =
  | { readonly kind: "createPackageBatch"; readonly tick: number }
  | { readonly kind: "inductPackage"; readonly tick: number }
  | { readonly kind: "departTrailer"; /* ... */ }
  | { readonly kind: "arriveTrailer"; /* ... */ }
  | { readonly kind: "midLegStops"; /* ... */ }
  | { readonly kind: "arriveOverCarriedAtCenter"; /* ... */ }
  | { readonly kind: "arriveConsolidationAtCenter"; /* ... */ };
```

**Phase 22 `SimTask` addition** — add as the LAST union member:
```typescript
  // Phase-22 OUT-01: one-shot delivery task. Carries ALL data needed to emit
  // PackageDelivered — packageId, hubId, locked slaDeadlineIso (undefined for
  // center-origin packages, which get onTime: true by convention), and fireTick.
  // DATA (never a closure) so a chunk boundary mid-dwell is resumed byte-identically.
  | {
      readonly kind: "deliverPackage";
      readonly packageId: string;
      readonly hubId: string;
      readonly slaDeadlineIso: string | undefined;
      readonly fireTick: number;
    };
```

**`SerializedRngStates` pattern** (lines 125-136):
```typescript
export interface SerializedRngStates {
  readonly base: number;
  readonly rfid: number;
  readonly overCarry: number;
  readonly timing: number;
  readonly hos: number;
  readonly fuel: number | undefined;      // present only when fuel enabled
  readonly induction: number | undefined; // present only when inductionEnabled. IND-02.
}
```

**Phase 22 addition** — add `outbound` field at the end:
```typescript
  readonly outbound: number | undefined;  // present only when outboundDeliveryEnabled. OUT-01.
```

**`SerializedWorldState` pattern** (lines 90-123):
```typescript
export interface SerializedWorldState {
  readonly pendingBySpoke: readonly (readonly [string, readonly string[]])[];
  readonly pendingAtSpoke: readonly (readonly [string, readonly string[]])[];
  readonly consolidationDestByPackage: readonly (readonly [string, string])[];
  readonly odometerByTrailer: readonly (readonly [string, number])[];
  readonly driverByTrailer: readonly (readonly [string, string])[];
  readonly clockByDriver: readonly (readonly [string, SerializedHosClock])[];
  readonly availableAtMinByDriver: readonly (readonly [string, number])[];
  readonly sparePool: readonly string[];
  readonly packageCounter: number;
  readonly tripCounter: number;
  readonly inductionCounter: number;
}
```

**Phase 22 additions** — add after `inductionCounter`:
```typescript
  /** Monotonic delivered-package id counter (v2.2 OUT-01). 0 on a fresh run. */
  readonly deliveredCounter: number;
  /**
   * packageId → locked slaDeadlineIso (whole-minute ISO) for inducted packages.
   * Only populated when outboundDeliveryEnabled; empty on the off path (byte-identical
   * to pre-Phase-22). Cleared on PackageDelivered (one entry per in-flight delivery).
   */
  readonly slaDeadlineByPackage: readonly (readonly [string, string])[];
```

---

### `packages/simulation/src/engine.ts` — `captureContinuation()` (service, event-driven)

**Analog:** `captureContinuation` at lines 1919-1973 — induction capture at lines 1950 and 1966.

**Induction capture pattern** (lines 1919-1973):
```typescript
function captureContinuation(): SimContinuation {
  const world: SerializedWorldState = {
    pendingBySpoke: [...pendingBySpoke.entries()].map(([k, v]) => [k, [...v]] as const),
    pendingAtSpoke: [...pendingAtSpoke.entries()].map(([k, v]) => [k, [...v]] as const),
    consolidationDestByPackage: [...consolidationDestByPackage.entries()].map(([k, v]) => [k, v] as const),
    odometerByTrailer: [...odometerByTrailer.entries()].map(([k, v]) => [k, v] as const),
    driverByTrailer: [...driverByTrailer.entries()].map(([k, v]) => [k, v] as const),
    clockByDriver: [...clockByDriver.entries()].map(([k, v]) => [k, serializeHosClock(v)] as const),
    availableAtMinByDriver: [...availableAtMinByDriver.entries()].map(([k, v]) => [k, v] as const),
    sparePool: [...sparePool],
    packageCounter,
    tripCounter,
    inductionCounter,
    // Phase 22 additions:
    deliveredCounter,
    slaDeadlineByPackage: [...slaDeadlineByPackage.entries()].map(([k, v]) => [k, v] as const),
  };
  return {
    version: 1,
    seed,
    nextTick: durationTicks + 1,
    rng: {
      base: rng.getState(),
      rfid: rfidRng.getState(),
      overCarry: overCarryRng.getState(),
      timing: timingRng.getState(),
      hos: hosRng.getState(),
      fuel: fuelRng?.getState(),
      induction: inductionRng?.getState(),
      outbound: outboundRng?.getState(),  // Phase 22
    },
    queue: queue.snapshot(),
    nextSeq: queue.peekNextSeq(),
    world,
    nextSequenceId,
  };
}
```

**RNG API** (from `packages/simulation/src/rng.ts`):
```typescript
export interface Rng {
  next: () => number;
  int: (maxExclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  getState: () => number;   // pure read — does NOT advance the generator
}
export function makeRng(seed: number): Rng { /* splitmix32 + mulberry32 */ }
export function makeRngFromState(rawState: number): Rng { /* resumes from raw uint32 state */ }
```

---

### `packages/simulation/test/outbound-determinism.unit.test.ts` (test, event-driven)

**Analog:** `packages/simulation/test/induction-determinism.unit.test.ts` (lines 1-100).

**Test file structure pattern**:
```typescript
import { describe, expect, it } from "vitest";
import { validateEvent, type PackageInducted, type TimingConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";

const SEED = 42;
const TICKS = 500;   // <= 800 per gate-hygiene OOM rule

const SHORT_TIMING: TimingConfig = {
  transit: { median: 8, sigma: 0.05, min: 1, max: 60 },
  dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
  dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 },
};

const types = (s: ReturnType<typeof simulate>): string[] => s.map((e) => e.event.type);
```

**DET-01 off-path test pattern** (induction-determinism.unit.test.ts lines 36-44):
```typescript
describe("IND-02: induction determinism keystone", () => {
  it("inductionEnabled ABSENT ⇒ ZERO PackageInducted events (DET-01)", () => {
    const s = simulate({ seed: SEED, durationTicks: TICKS });
    expect(types(s)).not.toContain("PackageInducted");
  });

  it("inductionEnabled: false ⇒ byte-identical to absent (DET-01)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS });
    const b = simulate({ seed: SEED, durationTicks: TICKS, inductionEnabled: false });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
```

**Phase 22 must mirror** with `outboundDeliveryEnabled` variants plus lifecycle-ordering and terminal-completeness tests. Use `inductionEnabled: true` to generate inducted packages (they have `slaDeadlineIso`).

---

### `packages/simulation/test/fuel-determinism.unit.test.ts` — extend salt test (test, event-driven)

**Analog:** self — the existing pairwise-distinct salt assertion at lines 60-75.

**Existing INDUCTION_RNG_SALT test pattern** (lines 60-75):
```typescript
it("INDUCTION_RNG_SALT is pairwise-distinct from all six existing salts (no collision)", () => {
  const salts = [
    RFID_RNG_SALT,
    OVER_CARRY_RNG_SALT,
    TIMING_RNG_SALT,
    HOS_RNG_SALT,
    FUEL_RNG_SALT,
    INDUCTION_RNG_SALT,
  ].map((s) => s >>> 0);
  expect(new Set(salts).size).toBe(salts.length);
  expect(INDUCTION_RNG_SALT >>> 0).not.toBe(RFID_RNG_SALT >>> 0);
  expect(INDUCTION_RNG_SALT >>> 0).not.toBe(OVER_CARRY_RNG_SALT >>> 0);
  expect(INDUCTION_RNG_SALT >>> 0).not.toBe(TIMING_RNG_SALT >>> 0);
  expect(INDUCTION_RNG_SALT >>> 0).not.toBe(HOS_RNG_SALT >>> 0);
  expect(INDUCTION_RNG_SALT >>> 0).not.toBe(FUEL_RNG_SALT >>> 0);
});
```

**Phase 22 addition** — append a new `it()` following this exact pattern:
```typescript
it("OUTBOUND_RNG_SALT is pairwise-distinct from all seven existing salts (no collision)", () => {
  const salts = [
    RFID_RNG_SALT,
    OVER_CARRY_RNG_SALT,
    TIMING_RNG_SALT,
    HOS_RNG_SALT,
    FUEL_RNG_SALT,
    INDUCTION_RNG_SALT,
    OUTBOUND_RNG_SALT,
  ].map((s) => s >>> 0);
  expect(new Set(salts).size).toBe(salts.length);
  // ...one explicit .not.toBe() per prior salt
});
```

---

### `packages/simulation/test/continuation-equivalence.unit.test.ts` — extend FEATURE_CASES (test, event-driven)

**Analog:** self — the `"consolidation"` FEATURE_CASE at lines 176-179 is the direct template for a new `"outbound"` case.

**FEATURE_CASES pattern** (lines 124-179):
```typescript
const FEATURE_CASES: { name: string; opts: Omit<FeatureOpts, "seed" | "durationTicks"> }[] = [
  { name: "rfid", opts: { timing: SHORT_TIMING, rfid: {} } },
  { name: "over-carry", opts: { timing: SHORT_TIMING, overCarry: 0.5 } },
  { name: "hos", opts: { timing: SHORT_TIMING, hosEnabled: true } },
  { name: "fuel+hos", opts: { timing: SHORT_TIMING, hosEnabled: true, fuel: { enabled: true, /* ... */ } } },
  { name: "all-on", opts: { timing: SHORT_TIMING, rfid: {}, overCarry: 0.4, hosEnabled: true,
                             fuel: { /* ... */ }, inductionEnabled: true, consolidationEnabled: true } },
  { name: "consolidation", opts: { timing: SHORT_TIMING, inductionEnabled: true, consolidationEnabled: true } },
];
```

**Phase 22 addition** — add `"outbound"` and update `"all-on"`:
```typescript
  {
    name: "outbound",
    opts: { timing: SHORT_TIMING, inductionEnabled: true, outboundDeliveryEnabled: true },
    // chunk-7 must land a boundary BETWEEN arriveTrailer (schedules deliverPackage)
    // and the deliverPackage fire tick, proving slaDeadlineByPackage + deliveredCounter
    // + the pending task are captured/restored byte-identically.
  },
  // update "all-on" to include outboundDeliveryEnabled: true
```

**`FeatureOpts` widening** (lines 46-48) — extend to include `outboundDeliveryEnabled`:
```typescript
type FeatureOpts = Parameters<typeof simulate>[0] & {
  readonly consolidationEnabled?: boolean;
  readonly outboundDeliveryEnabled?: boolean;  // Phase 22
};
```

---

### `packages/projections/src/reducers/package-location.ts` (service, CRUD)

**Analog:** self — `PackageInducted` case at lines 76-88 and the no-op list at lines 96-117 are the templates.

**DELETE purge pattern** — use the same copy-and-mutate idiom as the upsert path (lines 67-75):
```typescript
case "PackageScanned":
case "PackageArrivedAtHub": {
  const next = new Map(state);
  next.set(event.payload.packageId, { /* ... */ });
  return next;
}
```

**Phase 22 addition** — insert before the long no-op fall-through:
```typescript
case "PackageDelivered": {
  // OUT-04: hard DELETE — remove the row. Map.delete() returns false on a missing
  // key (never throws), so this is idempotent and crash-safe on re-apply (D-22-1).
  const next = new Map(state);
  next.delete(event.payload.packageId);
  return next;
}
```

**`default: assertNeverEvent` guard** (line 119) — requires the new case to compile.

---

### `packages/projections/src/reducers/hub-inventory.ts` (service, CRUD)

**Analog:** self — `placePackage(state, packageId, null)` at lines 193-196 is the exact DELETE purge idiom.

**`placePackage` null-target pattern** (lines 106-131):
```typescript
function placePackage(
  state: HubInventoryState,
  packageId: string,
  target: Placement | null,
): HubInventoryState {
  const hubs = new Map(state.hubs);
  const placement = new Map(state.placement);

  // Remove from prior location, if any.
  const prior = placement.get(packageId);
  if (prior !== undefined) {   // <-- SAFE: no-op on missing package (D-22-1 guard)
    const priorHub = hubs.get(prior.hubId);
    if (priorHub !== undefined) {
      hubs.set(prior.hubId, withoutPackage(priorHub, packageId));
    }
    placement.delete(packageId);
  }

  // Add to the new location, if any.
  if (target !== null) { /* ... */ }

  return { hubs, placement };
}
```

**Existing `TrailerDeparted` null-target pattern** (lines 192-196 — the DELETE idiom):
```typescript
case "TrailerDeparted":
  return event.payload.packageIds.reduce(
    (acc, packageId) => placePackage(acc, packageId, null),
    state,
  );
```

**Phase 22 addition** — add before the long no-op fall-through (line 223):
```typescript
case "PackageDelivered":
  // OUT-04 / D-22-1: hard DELETE via null target. placePackage(..., null) is a
  // guaranteed no-op when the package is absent (prior === undefined guard at
  // line 115), so this is idempotent and crash-safe on re-apply.
  return placePackage(state, event.payload.packageId, null);
```

---

### `packages/projections/src/reducers/zone-estimate.ts` (service, CRUD)

**Analog:** self — `PackageInducted` no-op case at line 200 and `PlanSuperseded` no-op at line 201 are the template.

**No-op list tail** (lines 179-204):
```typescript
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
      return state;
    default:
      return assertNeverEvent(event);
```

**Phase 22 addition** — add alongside `PackageInducted` and `PlanSuperseded`:
```typescript
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded":  // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-04: zone estimates are RFID-only; Phase-21
                             // is_active filter already excludes delivered packages from
                             // detection scope. No-op here (no RFID data in payload).
      return state;
```

**Note:** CONTEXT.md D-22-1 says "DELETE from zoneEstimate". The RESEARCH.md recommends no-op as the safe/KISS approach since Phase-21 already excludes delivered packages from detection. Planner must resolve: if a full purge is required, add a `purgeZoneEstimate(state, packageId)` helper that iterates keys matching `packageId|` prefix (O(n), acceptable at demo scale). The no-op is the safer default per RESEARCH.md Pitfall analysis.

---

### `packages/projections/src/reducers/delivery-kpi.ts` (service, CRUD)

**Analog:** `packages/projections/src/reducers/hub-inventory.ts` — event-derived pure reducer pattern. No prior pure-counter reducer exists; hub-inventory's pure-function shape is the closest role match.

**Pure reducer shape pattern** (hub-inventory.ts lines 157-246):
```typescript
export function hubInventoryReducer(
  state: HubInventoryState,
  { event }: OccurredEvent,
): HubInventoryState {
  switch (event.type) {
    case "PackageArrivedAtHub":
      return /* mutated state */;
    // ...
    default:
      return assertNeverEvent(event);
  }
}
```

**Phase 22 new file** — delivery-kpi reducer:
```typescript
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/** D-22-3: event-derived KPI counters. MUST NOT be COUNT(*) over purged tables. */
export interface DeliveryKpiState {
  readonly deliveredCount: number;
  readonly onTimeCount: number;
}

export const emptyDeliveryKpiState: DeliveryKpiState = {
  deliveredCount: 0,
  onTimeCount: 0,
};

export function deliveryKpiReducer(
  state: DeliveryKpiState,
  { event }: OccurredEvent,
): DeliveryKpiState {
  switch (event.type) {
    case "PackageDelivered":
      return {
        deliveredCount: state.deliveredCount + 1,
        onTimeCount: state.onTimeCount + (event.payload.onTime ? 1 : 0),
      };
    // All other events are no-ops for the KPI counter.
    case "HubRegistered":
    case "RouteRegistered":
    // ...all remaining DomainEvent types...
    case "PlanSuperseded":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
```

---

### `packages/api/src/ws/envelope.ts` (model, request-response)

**Analog:** self — `InductionEvent` (lines 135-142) and `TickPayload.inductionEvents` (line 231) are the exact templates.

**`InductionEvent` template** (lines 135-142):
```typescript
export interface InductionEvent {
  readonly packageId: string;
  readonly inductionHubId: string;
  readonly destHubId: string;
  readonly slaClass: string;
  readonly slaDeadlineIso: string;
  readonly occurredAt: string;
}
```

**Phase 22 `DeliveryEvent`** — add adjacent to `InductionEvent`:
```typescript
/**
 * VIZ-14 — a package delivered at its destination hub this tick. TRANSIENT:
 * present only on a `TickPayload` (never `SnapshotPayload`), so a reconnect/resync
 * does NOT re-animate all historical deliveries (Pitfall 7 — same rule as induction).
 */
export interface DeliveryEvent {
  readonly packageId: string;
  readonly hubId: string;        // destination hub
  readonly deliveredAt: string;  // whole-minute ISO (epochMinutesToIso canonical)
  readonly onTime: boolean;
}
```

**`TickPayload.inductionEvents` template** (line 227-231):
```typescript
  /**
   * VIZ-13 — packages inducted at spoke hubs this tick (TRANSIENT). Drives the
   * pulsing induction-marker animation. Present ONLY here, never on
   * `SnapshotPayload` (a reconnect must not re-flash historical inductions).
   */
  readonly inductionEvents?: readonly InductionEvent[];
```

**Phase 22 addition** — add after `inductionEvents` in `TickPayload`:
```typescript
  /**
   * VIZ-14 — packages delivered at destination hubs this tick (TRANSIENT). Drives
   * the destination-hub flash animation. Present ONLY here, never on
   * `SnapshotPayload` (a reconnect must not re-flash historical deliveries — same
   * Pitfall-7 rule as inductionEvents).
   */
  readonly deliveryEvents?: readonly DeliveryEvent[];
```

**Critical:** `SnapshotPayload` (lines 181-200) MUST NOT gain `deliveryEvents`. This is the Pitfall-7 guard.

---

### `packages/api/src/ws/snapshots.ts` — `Broadcast` type extension (service, request-response)

**Analog:** self — `Broadcast` type at lines 83-86 with `inductionEvents` parameter.

**Current `Broadcast` type** (lines 83-86):
```typescript
export type Broadcast = (
  simMs: number,
  inductionEvents?: readonly InductionEvent[],
) => Promise<WsEnvelope>;
```

**Phase 22 extension** — add `deliveryEvents` as an optional third parameter:
```typescript
export type Broadcast = (
  simMs: number,
  inductionEvents?: readonly InductionEvent[],
  deliveryEvents?: readonly DeliveryEvent[],
) => Promise<WsEnvelope>;
```

**Wire into `diffTick`** — the `diffTick` function builds `TickPayload`; add `deliveryEvents` following the same optional-field pattern as `inductionEvents`.

---

### `packages/api/test/ws-delivery.unit.test.ts` (test, request-response)

**Analog:** `packages/api/test/ws-induction.unit.test.ts` (lines 1-143) — verbatim copy-and-adapt.

**Test infrastructure pattern** (lines 1-83):
```typescript
import { describe, expect, it } from "vitest";
import { attachSnapshotSocket } from "../src/ws/snapshots.js";
import type { ApiDb } from "../src/routes/queries.js";
import type { SnapshotPayload, WsEnvelope, InductionEvent } from "../src/ws/envelope.js";
import type { SpeedController } from "../src/sim/speed-controller.js";

type WsHandler = (socket: FakeSocket) => void;
interface FakeSocket { readyState: number; bufferedAmount: number; sent: string[]; send(data: string): void; on(event: string, cb: (...args: unknown[]) => void): void; }
function makeFakeSocket(): FakeSocket { /* ... */ }
function makeFakeApp(): { app: unknown; getHandler: () => WsHandler } { /* ... */ }
const EMPTY_SNAPSHOT: SnapshotPayload = { trailers: [], trailerStops: [], hubs: [], routes: [], exceptionsOpen: [] };
const FAKE_SPEED: SpeedController = { /* ... */ };
```

**Key test pattern — Pitfall-7 guard** (lines 123-142):
```typescript
it("never places inductionEvents on the initial snapshot payload (Pitfall 7)", async () => {
  /* ... */
  const snapshotEnv = JSON.parse(socket.sent[0]!) as WsEnvelope;
  expect(snapshotEnv.type).toBe("snapshot");
  expect(
    (snapshotEnv.payload as Record<string, unknown>)["inductionEvents"],
  ).toBeUndefined();
});
```

**Phase 22 version** — adapt: `InductionEvent → DeliveryEvent`, `inductionEvents → deliveryEvents`, test fixture `DELIVERY` instead of `INDUCTION`. Three tests: tick has `deliveryEvents`, tick without omits it, snapshot never has it.

---

### `packages/web/src/map/layers.ts` — `createDeliveryLayer` + `flashDelivery` (component, event-driven)

**Analog:** self — `createInductionLayer` (lines 248-252) and `flashInduction` (lines 260-278) are the verbatim templates.

**`createInductionLayer` template** (lines 248-252):
```typescript
export function createInductionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: inductionStyle });
  return { layer, source };
}
```

**`flashInduction` template** (lines 260-278):
```typescript
export function flashInduction(
  source: VectorSource,
  inductionHubId: string,
  lon: number,
  lat: number,
  durationMs = 2000,
): void {
  const featureId = `induction:${inductionHubId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    inductionHubId,
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}
```

**Phase 22 additions** — mirror exactly, substituting delivery semantics:
```typescript
export function createDeliveryLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: deliveryStyle });
  return { layer, source };
}

export function flashDelivery(
  source: VectorSource,
  deliveryHubId: string,
  lon: number,
  lat: number,
  durationMs = 2000,
): void {
  const featureId = `delivery:${deliveryHubId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    deliveryHubId,   // property name changed from inductionHubId
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}
```

**Import addition** — add `deliveryStyle` import from `./deliveryColoring.js`.

---

### `packages/web/src/map/deliveryColoring.ts` (utility, transform)

**Analog:** `packages/web/src/map/inductionColoring.ts` (lines 1-42) — verbatim copy-and-adapt.

**Induction coloring pattern** (lines 1-42):
```typescript
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";

const INDUCTION_RADIUS = 14;
const EMOJI_FONT = '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Purple — distinct from hub (green/red) and stop (amber/blue) markers. */
export const INDUCTION_COLOR = "#7c3aed";
const INDUCTION_GLYPH = "+";

const INDUCTION_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: INDUCTION_RADIUS,
    fill: new Fill({ color: INDUCTION_COLOR }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: INDUCTION_GLYPH, font: EMOJI_FONT }),
});

export function inductionStyle(): Style {
  return INDUCTION_STYLE_DEFAULT;
}
```

**Phase 22 version** — adapt color/glyph (Claude's discretion per CONTEXT.md). VIZ-14 color must be DISTINCT from induction purple `#7c3aed` and consolidation cyan. Suggested: green `#16a34a` (delivery = success signal):
```typescript
/** Green — distinct from induction purple (#7c3aed), consolidation cyan, hub (red/green), stop (amber/blue). */
export const DELIVERY_COLOR = "#16a34a";  // or orange-red #f97316 — planner's discretion
const DELIVERY_GLYPH = "✓";

export function deliveryStyle(): Style {
  return DELIVERY_STYLE_DEFAULT;
}
```

---

### `packages/web/src/panels/DeliveryKpi.tsx` (component, request-response)

**Analog:** `packages/web/src/panels/HubBalance.tsx` (lines 1-147) — same shape: pure helpers + React component + `fetch` call.

**HubBalance pure helper pattern** (lines 28-57):
```typescript
export function formatBalance(inbound: number, outbound: number): string {
  return `${inbound} in / ${outbound} out`;
}
export function crossDockRatio(inbound: number, outbound: number): number {
  const total = inbound + outbound;
  if (total === 0) return 0;
  return outbound / total;
}
export function heatClass(inbound: number, outbound: number): "idle" | "cool" | "warm" | "hot" {
  const total = inbound + outbound;
  // ...
}
```

**HubBalance component pattern** (lines 63-147):
```typescript
export function HubBalance({ hubId }: HubBalanceProps): React.JSX.Element {
  const [balance, setBalance] = useState<HubInventoryBalanceDto>(ZERO_BALANCE);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    const ac = new AbortController();
    setLoadState("loading");
    fetchHubDetail(hubId, ac.signal)
      .then((detail) => {
        setBalance(detail.inventoryBalance);
        setLoadState("loaded");
      })
      .catch(() => {
        setLoadState("error");
      });
    return () => { ac.abort(); };
  }, [hubId]);
  // ...loading/error/loaded JSX with data-testid attributes
}
```

**Phase 22 `DeliveryKpi.tsx`** — same shape, adapt to `GET /api/delivery-kpi`:
```typescript
// Pure helpers (unit-testable, no DOM):
export function formatDeliveryKpi(delivered: number, onTime: number): string {
  return `${delivered} delivered`;
}
export function onTimePercent(delivered: number, onTime: number): number {
  if (delivered === 0) return 0;
  return Math.round((onTime / delivered) * 100);
}

// Component:
export function DeliveryKpi(): React.JSX.Element {
  // useState + useEffect + fetch GET /api/delivery-kpi
  // renders deliveredCount + on-time% with data-testid attributes
}
```

---

## Shared Patterns

### Determinism Guard (`=== true` strict opt-in)
**Source:** `packages/simulation/src/engine.ts` line 511
**Apply to:** `outboundDeliveryEnabled` evaluation in engine.ts
```typescript
// CORRECT: strict === true (identical to inductionOn)
const outboundOn = opts.outboundDeliveryEnabled === true;
// WRONG: never use ?? or || (would make absent truthy accidentally)
```

### Closed Union Exhaustiveness (`assertNeverEvent`)
**Source:** `packages/projections/src/reducers/reducer.js` (`assertNeverEvent`)
**Apply to:** All three projection reducers + new `delivery-kpi.ts` reducer
```typescript
default:
  return assertNeverEvent(event);
```
Every reducer's `default` branch calls `assertNeverEvent`. Adding `PackageDelivered` to the union without adding a case causes a compile error in each reducer — this is the build gate.

### Whole-Minute ISO Canonicalization
**Source:** `packages/domain/src/hos.ts` lines 141-152
**Apply to:** `deliveredAt` computation in `deliverPackage` in engine.ts
```typescript
export function isoToEpochMinutes(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`isoToEpochMinutes: unparseable ISO stamp "${iso}"`);
  }
  return Math.trunc(ms / MS_PER_MINUTE);
}

export function epochMinutesToIso(minutes: number): string {
  return new Date(minutes * MS_PER_MINUTE).toISOString();
}

// Usage for deliveredAt (canonical form — no sub-minute residue):
const deliveredAt = epochMinutesToIso(isoToEpochMinutes(clock.nowIso()));
// Produces "YYYY-MM-DDTHH:MM:00.000Z" — matches slaDeadlineIso format
```
Both functions are already imported in `engine.ts` (verified at lines 32-38).

### RNG Substream Construction (lazy, opt-in)
**Source:** `packages/simulation/src/engine.ts` lines 585-595
**Apply to:** `outboundRng` construction in engine.ts
```typescript
const inductionRng: Rng | undefined = inductionOn
  ? restoredRng && restoredRng.induction !== undefined
    ? makeRngFromState(restoredRng.induction)
    : makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0)
  : undefined;
```
Pattern: only construct when the feature flag is on; restore from continuation state on resume.

### WS Tick-Only Transient Field (Pitfall-7 guard)
**Source:** `packages/api/src/ws/envelope.ts` lines 227-231 and `packages/api/test/ws-induction.unit.test.ts` lines 123-142
**Apply to:** `deliveryEvents` field — `TickPayload` ONLY, never `SnapshotPayload`
The test must assert `(snapshotEnv.payload as Record<string, unknown>)["deliveryEvents"]` is `undefined`.

### Zero-Allocation OpenLayers StyleFunction
**Source:** `packages/web/src/map/inductionColoring.ts` lines 24-41
**Apply to:** `packages/web/src/map/deliveryColoring.ts`
```typescript
// Pre-allocate ONE Style at module load; return the cached reference — ZERO per-frame allocation.
const DELIVERY_STYLE_DEFAULT = new Style({ /* ... */ });
export function deliveryStyle(): Style {
  return DELIVERY_STYLE_DEFAULT;
}
```

### Continuation Capture Pattern (world state maps as tuple arrays)
**Source:** `packages/simulation/src/engine.ts` lines 1919-1973
**Apply to:** `slaDeadlineByPackage` and `deliveredCounter` in `captureContinuation()`
```typescript
// Map serialization: spread .entries() to stable [key, value] tuple arrays.
consolidationDestByPackage: [...consolidationDestByPackage.entries()].map(([k, v]) => [k, v] as const),
// Same pattern for slaDeadlineByPackage.
```

---

## No Analog Found

No files in Phase 22 lack a close analog. All patterns are fully templated by Phase-20 (induction) or Phase-21 (consolidation) additions.

---

## Metadata

**Analog search scope:** `packages/domain/src/events/`, `packages/simulation/src/`, `packages/simulation/test/`, `packages/projections/src/reducers/`, `packages/api/src/ws/`, `packages/api/test/`, `packages/web/src/map/`, `packages/web/src/panels/`
**Files scanned:** 22 (all verified by direct Read)
**Pattern extraction date:** 2026-06-25

---

## PATTERN MAPPING COMPLETE

**Phase:** 22 - Outbound Delivery
**Files classified:** 21
**Analogs found:** 21 / 21

### Coverage
- Files with exact analog: 20
- Files with role-match analog: 1 (`delivery-kpi.ts` — no prior pure counter reducer; `hub-inventory.ts` is the role match)
- Files with no analog: 0

### Key Patterns Identified
- All domain event additions follow the 5-file union ceremony: `schemas.ts` → `domain-event.ts` → `contract.assert.ts` → `index.ts` + new test; `PackageInducted` is the exact template for all 4 existing file edits
- `deliverPackage` is a ONE-SHOT EventQueue DATA task (not self-rescheduling); `inductPackage` is the template but without the `scheduleNext()` at the end; scheduled inside `arriveTrailer()` after the `PackageArrivedAtHub` emit
- All three projection reducers use `assertNeverEvent` in `default:` — adding `PackageDelivered` without a case is a build-time error; `placePackage(state, packageId, null)` is the hub-inventory DELETE idiom; `new Map(state); next.delete(id)` is the package-location DELETE idiom
- `deliveryEvents` is tick-only (never snapshot) — the Pitfall-7 pattern from `ws-induction.unit.test.ts` must be mirrored verbatim in `ws-delivery.unit.test.ts`
- `outboundDeliveryEnabled: false` (absent or explicit) must produce ZERO new RNG draws and ZERO new events — strict `=== true` guard (not `??` or `||`); this is the non-negotiable golden-hash acceptance gate

### File Created
`/Volumes/Unitek-B/Projects/jobs/intelliswift/.planning/phases/22-outbound-delivery/22-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files.
