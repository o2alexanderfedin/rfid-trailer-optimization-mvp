# Phase 20: External Induction - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 20 new/modified files
**Analogs found:** 20 / 20

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/domain/src/events/schemas.ts` | model | event-driven | itself (`truckRefueledSchema`) | exact |
| `packages/domain/src/events/domain-event.ts` | model | event-driven | itself (`TruckRefueled` union member) | exact |
| `packages/domain/src/events/contract.assert.ts` | utility | event-driven | itself (`case "TruckRefueled"`) | exact |
| `packages/domain/src/events/index.ts` | config | event-driven | itself (`truckRefueledSchema` re-export) | exact |
| `packages/domain/src/index.ts` | config | event-driven | itself (`truckRefueledSchema` barrel) | exact |
| `packages/simulation/src/engine.ts` | service | event-driven | itself (`FUEL_RNG_SALT`, `fuelRng`, `dispatch`) | exact |
| `packages/simulation/src/continuation.ts` | model | event-driven | itself (`fuel: number | undefined` field) | exact |
| `packages/simulation/test/induction-determinism.unit.test.ts` | test | event-driven | `fuel-determinism.unit.test.ts` | exact |
| `packages/simulation/test/continuation-equivalence.unit.test.ts` | test | event-driven | itself (FEATURE_CASES array) | exact |
| `packages/simulation/test/continuation-adversarial.unit.test.ts` | test | event-driven | itself (`ALL_ON` constant) | exact |
| `packages/projections/src/reducers/hub-inventory.ts` | service | CRUD | itself (`PackageArrivedAtHub` → `inbound` case) | exact |
| `packages/projections/src/reducers/package-location.ts` | service | CRUD | itself (no-op `TruckRefueled` case) | exact |
| `packages/projections/src/reducers/trailer-state.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/driver-status.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/driver-assignment.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/tag-registry.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/zone-estimate.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/exceptions.ts` | service | CRUD | itself (no-op case block) | exact |
| `packages/projections/src/reducers/audit-timeline.ts` | service | CRUD | itself (`assertNeverAudit` local exhaustive switch) | exact |
| `packages/projections/src/reducers/geo-track.ts` | service | CRUD | itself (`assertNeverGeo` local exhaustive switch) | exact |
| `packages/optimizer/src/rolling/scope.ts` | service | event-driven | itself (`hubsOf` exhaustive switch) | exact |
| `packages/optimizer/src/rolling/types.ts` | model | CRUD | itself (`TwinDriver.remainingDriveMinutes?` additive field) | exact |
| `packages/api/src/ws/envelope.ts` | model | request-response | itself (`ExceptionItem` + `exceptionsNew` additive array) | exact |
| `packages/web/src/map/inductionColoring.ts` (NEW) | utility | event-driven | `packages/web/src/map/stopColoring.ts` | exact |
| `packages/web/src/map/layers.ts` | component | event-driven | itself (`createTrailerStopLayer`) | exact |

---

## Pattern Assignments

### 1. `packages/domain/src/events/schemas.ts` (model, event-driven)

**Analog:** `packages/domain/src/events/schemas.ts` — `truckRefueledSchema` (lines 376-386) and `occurredAt` constant (lines 199-201)

**NOTE ON LINE ACCURACY:** All line numbers below are verified against the live file as read in this session.

**Imports pattern — what `packageInductedSchema` needs** (lines 1-8 + line 24 + 201):
```typescript
// Already imported: z from "zod", id (line 24), occurredAt (line 201)
// Need to add: slaClassSchema import from "../planning/index.js"
// (slaClassSchema is NOT currently imported in schemas.ts — it lives in @mm/domain planning barrel)
import { slaClassSchema } from "../planning/index.js";
```

**`eventSchema` factory pattern** (lines 34-43 — the ONLY wrapper to call):
```typescript
function eventSchema<TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  payload: z.ZodObject<TShape>,
) {
  return z.object({
    type: z.literal(type),
    schemaVersion,
    payload: payload.strict(),  // .strict() is applied INSIDE here — do NOT add it again
  });
}
```

**Closest existing payload analog** — `truckRefueledSchema` (lines 376-386):
```typescript
export const truckRefueledSchema = eventSchema(
  "TruckRefueled",
  z.object({
    trailerId: id,
    tripId: id,
    gallons: z.number().nonnegative().finite(),
    odometerMiles: z.number().nonnegative().finite(),
    durationMin: z.number().int().nonnegative(),
    occurredAt,
  }),
);
```

**New schema to add** — `packageInductedSchema` (after `truckRefueledSchema`, line 387+):
```typescript
// v2.0 IND-01: external induction — freight entering the network at a spoke hub.
// `occurredAt` is the VIRTUAL clock ISO string, never Date.now().
// `slaDeadlineIso` is locked at induction time (occurredAt + travel estimate + SLA buffer).
export const packageInductedSchema = eventSchema(
  "PackageInducted",
  z.object({
    packageId:          id,
    inductionHubId:     id,
    destHubId:          id,
    slaClass:           slaClassSchema,
    slaDeadlineIso:     z.string().min(1),    // ISO-8601 deadline, locked at induction
    externalOriginRef:  id,                   // e.g. "EXT-00001" (deterministic counter)
    occurredAt,
  }),
);
```

**`domainEventSchema` discriminated union extension** (lines 393-419 — add after `truckRefueledSchema`):
```typescript
export const domainEventSchema = z.discriminatedUnion("type", [
  // ... all existing schemas ...
  truckRestedSchema,
  truckRefueledSchema,
  // v2.0 external induction (IND-01).
  packageInductedSchema,
]);
```

---

### 2. `packages/domain/src/events/domain-event.ts` (model, event-driven)

**Analog:** `packages/domain/src/events/domain-event.ts` — `TruckRefueled` pattern (lines 20-26 import, line 132 type, line 164-165 union member)

**Import block extension** (lines 1-26 — add to the import list from `"./schemas.js"`):
```typescript
import type {
  // ... all existing imports ...
  truckRefueledSchema,
  packageInductedSchema,  // ADD
} from "./schemas.js";
```

**New inferred type** (add after `TruckRefueled` at line 132):
```typescript
/**
 * Freight entered the network from outside at a spoke hub (IND-01 / v2.0).
 * `slaDeadlineIso` is locked at induction; `externalOriginRef` is a deterministic
 * counter id. The optimizer reads inducted packages via the `hub_inventory`
 * projection's `inbound` bucket (Decision 3).
 */
export type PackageInducted = z.infer<typeof packageInductedSchema>;
```

**`DomainEvent` union extension** (lines 140-165 — add after `TruckRefueled`):
```typescript
export type DomainEvent =
  | HubRegistered
  | RouteRegistered
  // ... all existing members ...
  | TruckRested
  | TruckRefueled
  // v2.0 external induction (IND-01).
  | PackageInducted;
```

---

### 3. `packages/domain/src/events/contract.assert.ts` (utility, event-driven)

**Analog:** `packages/domain/src/events/contract.assert.ts` — `assertExhaustive` switch (lines 25-53) + type-equality proof (lines 61-68)

**Exhaustive switch extension** (add case before `default` at line 50):
```typescript
function assertExhaustive(event: DomainEvent): void {
  switch (event.type) {
    case "HubRegistered":
    case "RouteRegistered":
    // ... all existing cases ...
    case "TruckRested":
    case "TruckRefueled":
    case "PackageInducted":  // ADD — v2.0 IND-01
      return;
    default:
      assertNever(event);
  }
}
```

**Type-equality proof** (line 68 — no change needed):
```typescript
// This line automatically covers PackageInducted because domainEventSchema
// (schemas.ts) now includes packageInductedSchema. No manual update needed.
const _zodMatchesHandWrittenUnion: Exact<Inferred, DomainEvent> = true;
```

**CRITICAL:** If `domainEventSchema` and `DomainEvent` are not updated atomically, this line produces:
`Type 'false' is not assignable to type 'true'`

---

### 4. `packages/domain/src/events/index.ts` (config, event-driven)

**Analog:** `packages/domain/src/events/index.ts` — `TruckRefueled` re-export pattern (lines 27-56)

**Type re-export extension** (add to the `export type {...}` block, line 27):
```typescript
export type {
  // ... all existing type exports ...
  TruckRefueled,
  PackageInducted,  // ADD
} from "./domain-event.js";
```

**Schema re-export extension** (add to the `export {...}` block, line 54):
```typescript
export {
  // ... all existing schema exports ...
  truckRefueledSchema,
  packageInductedSchema,  // ADD
} from "./schemas.js";
```

---

### 5. `packages/domain/src/index.ts` (config, event-driven)

**Analog:** `packages/domain/src/index.ts` — `TruckRefueled` barrel pattern (lines 79-107)

**Type barrel extension** (add to event type re-exports at line 79):
```typescript
export type {
  // ... all existing ...
  TruckRefueled,
  PackageInducted,  // ADD
} from "./events/index.js";
```

**Schema barrel extension** (add to event schema re-exports at line 107):
```typescript
export {
  // ... all existing ...
  truckRefueledSchema,
  packageInductedSchema,  // ADD
} from "./events/index.js";
```

---

### 6. `packages/simulation/src/engine.ts` — salt constant (service, event-driven)

**Analog:** `packages/simulation/src/engine.ts` — `FUEL_RNG_SALT` block (lines 93-103)

**Salt constant to add** (after `FUEL_RNG_SALT` at line 103):
```typescript
/**
 * v2.0 IND-02: the SEVENTH substream salt for external induction draws. A NEW,
 * DISTINCT constant (the salt-collision test asserts it differs from all six above)
 * so inducted packages never perturb any prior stream. The `inductionRng` is
 * constructed ONLY when `inductionEnabled`, so a flag-off run draws ZERO induction
 * values and stays byte-identical to the golden.
 */
export const INDUCTION_RNG_SALT = 0x8f_2c_4a_e1;
// Verify pairwise-distinct from: 0x5f1da7c3, 0x3ca71d5f, 0x00007717, 0x10510901, 0x2b3d91e7
```

**`SimulateOptions` extension** — follows `hosEnabled?: boolean` pattern (line ~183):
```typescript
/**
 * IND-02: OPT-IN external package induction at spoke hubs. DEFAULT FALSE — the
 * determinism keystone. When absent or false, the engine emits NO PackageInducted
 * events and makes ZERO inductionRng draws; existing seed-1234 + seed-42 goldens
 * are byte-identical. When true, a seeded substream (INDUCTION_RNG_SALT) drives a
 * self-rescheduling EventQueue task.
 */
readonly inductionEnabled?: boolean;
```

**Flag gate pattern** — mirrors `fuelOn` at lines 435-436:
```typescript
// v2.0 IND-02: induction is OPT-IN and DEFAULT OFF. Absent/false => the engine
// emits NO PackageInducted and NEVER draws inductionRng, so all existing goldens
// are byte-identical (the determinism keystone).
const inductionOn = opts.inductionEnabled === true;
```

**RNG substream construction** — mirrors `fuelRng` at lines 496-500:
```typescript
// v2.0: SEVENTH substream. Created ONLY when inductionOn (off path never constructs it).
const inductionRng: Rng | undefined = inductionOn
  ? (restoredRng && restoredRng.induction !== undefined
      ? makeRngFromState(restoredRng.induction)
      : makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0))
  : undefined;
```

**`inductPackage` self-rescheduling function** — mirrors `createPackageBatch` at lines 904-925:
```typescript
const inductPackage = (tick: number): void => {
  if (!inductionOn || inductionRng === undefined) return; // never runs when off

  inductionCounter += 1;
  const externalOriginRef = `EXT-${String(inductionCounter).padStart(5, "0")}`;
  const packageId = `EXT-P${String(inductionCounter).padStart(5, "0")}`;

  // Draw from inductionRng only — byte-isolated from other streams.
  const inductionHub = inductionRng.pick(spokes);
  const destCandidates = spokes.filter(s => s.hubId !== inductionHub.hubId);
  const destHub = inductionRng.pick(destCandidates);
  const slaClass: SlaClass = SLA_CLASSES[inductionRng.int(SLA_CLASSES.length)]!;

  // Deadline: occurredAt + expectedTransit(inductionHub→center→destHub) + SLA buffer
  // All uses virtual clock clock.nowIso() — never Date.now().
  const transitMin =
    expectedTransitMinutes(inductionHub, center, timingConfig) +
    expectedDwellMinutes("center", timingConfig) +
    expectedTransitMinutes(center, destHub, timingConfig);
  const SLA_BUFFER_MIN: Record<SlaClass, number> = {
    express: 60, priority: 120, standard: 240, economy: 480,
  };
  const deadlineMin =
    isoToEpochMinutes(clock.nowIso()) + transitMin + SLA_BUFFER_MIN[slaClass];
  const slaDeadlineIso = epochMinutesToIso(deadlineMin);

  const inducted: PackageInducted = {
    type: "PackageInducted",
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: {
      packageId,
      inductionHubId: inductionHub.hubId,
      destHubId: destHub.hubId,
      slaClass,
      slaDeadlineIso,
      externalOriginRef,
      occurredAt: clock.nowIso(),
    },
  };
  emit(`package-${packageId}`, inducted);

  // Self-reschedule — next induction at an absolute tick (same discipline as
  // createPackageBatch). The drain loop's horizon ceiling bounds execution.
  const nextTick = tick + INDUCTION_INTERVAL_TICKS;
  scheduleNext(nextTick, { kind: "inductPackage", tick: nextTick });
};
```

**`dispatch()` extension** — add case (lines 1488-1517 pattern):
```typescript
// In dispatch() switch — add after "arriveOverCarriedAtCenter":
case "inductPackage":
  inductPackage(task.tick);
  return;
```

**Bootstrap extension** — mirrors `schedule(0, { kind: "createPackageBatch", tick: 0 })` at line 1525:
```typescript
if (!resuming) {
  // ... existing bootstrap ...
  if (inductionOn) {
    schedule(INDUCTION_START_TICK, { kind: "inductPackage", tick: INDUCTION_START_TICK });
  }
}
```

**`captureContinuation()` extension** — add `induction` field mirroring `fuel` at line 1596:
```typescript
rng: {
  base:      rng.getState(),
  rfid:      rfidRng.getState(),
  overCarry: overCarryRng.getState(),
  timing:    timingRng.getState(),
  hos:       hosRng.getState(),
  fuel:      fuelRng?.getState(),
  induction: inductionRng?.getState(), // v2.0 IND-02 — undefined when off
},
```

**`SerializedWorldState` extension** — add `inductionCounter` after `tripCounter` (line 91):
```typescript
// In SerializedWorldState (continuation.ts):
/** Monotonic external-induction id counter (v2.0 IND-02). */
readonly inductionCounter: number;
```

---

### 7. `packages/simulation/src/continuation.ts` (model, event-driven)

**Analog:** `packages/simulation/src/continuation.ts` — `SimTask` union (lines 27-51), `SerializedRngStates` (lines 95-104)

**`SimTask` union extension** (add after line 28 `createPackageBatch`):
```typescript
// Before (existing, line 28):
export type SimTask =
  | { readonly kind: "createPackageBatch"; readonly tick: number }
  // ... other variants ...

// ADD (v2.0 IND-02):
  | { readonly kind: "inductPackage"; readonly tick: number }
```

The `inductPackage` variant carries only `tick` — identical shape to `createPackageBatch` (same tick-based self-rescheduling pattern). The `fireTick` in `SerializedScheduled` (line 54) captures the absolute queue position automatically.

**`SerializedRngStates` extension** — mirrors `fuel` field (lines 102-103):
```typescript
export interface SerializedRngStates {
  readonly base: number;
  readonly rfid: number;
  readonly overCarry: number;
  readonly timing: number;
  readonly hos: number;
  /** Present only when fuel is enabled (the off path never constructs it). */
  readonly fuel: number | undefined;
  /** Present only when inductionEnabled (the off path never constructs it). IND-02. */
  readonly induction: number | undefined;  // ADD
}
```

**`SerializedWorldState` extension** — add after `tripCounter` (line 92):
```typescript
export interface SerializedWorldState {
  // ... existing fields ...
  readonly packageCounter: number;
  readonly tripCounter: number;
  /** Monotonic external-induction id counter (v2.0 IND-02). 0 on fresh run. */
  readonly inductionCounter: number;  // ADD
}
```

---

### 8. `packages/simulation/test/induction-determinism.unit.test.ts` (NEW test)

**Analog:** `packages/simulation/test/fuel-determinism.unit.test.ts` — salt-collision test (lines 42-57), flag-off golden test (lines 62-68)

**Salt-collision test extension** (extend existing salt array in `fuel-determinism.unit.test.ts`, lines 43-51):
```typescript
// Extend the salt array to include INDUCTION_RNG_SALT:
import {
  RFID_RNG_SALT, OVER_CARRY_RNG_SALT, TIMING_RNG_SALT,
  HOS_RNG_SALT, FUEL_RNG_SALT, INDUCTION_RNG_SALT, // ADD
  simulate,
} from "../src/engine.js";

it("INDUCTION_RNG_SALT is pairwise-distinct from all six existing salts (no collision)", () => {
  const salts = [
    RFID_RNG_SALT, OVER_CARRY_RNG_SALT, TIMING_RNG_SALT,
    HOS_RNG_SALT, FUEL_RNG_SALT,
    INDUCTION_RNG_SALT,  // NEW — must differ from all five above
  ].map((s) => s >>> 0);
  expect(new Set(salts).size).toBe(salts.length);
});
```

**Flag-off golden tests** — mirror `fuel-determinism.unit.test.ts` lines 62-68:
```typescript
const SEED = 42;
const TICKS = 500; // scale-bound: ≤ 1000 ticks for new induction tests

it("inductionEnabled absent → ZERO PackageInducted events (DET-01)", () => {
  const s = simulate({ seed: SEED, durationTicks: TICKS });
  expect(s.map(e => e.event.type)).not.toContain("PackageInducted");
});

it("inductionEnabled: false → byte-identical to absent flag (DET-01)", () => {
  const a = simulate({ seed: SEED, durationTicks: TICKS });
  const b = simulate({ seed: SEED, durationTicks: TICKS, inductionEnabled: false });
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});

it("inductionEnabled: true → PackageInducted events present (IND-02)", () => {
  const s = simulate({
    seed: SEED,
    durationTicks: TICKS,
    inductionEnabled: true,
    timing: { transit: { median: 8, sigma: 0.05, min: 1, max: 60 },
               dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
               dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 } },
  });
  expect(s.some(e => e.event.type === "PackageInducted")).toBe(true);
});

it("slaDeadlineIso is deterministic and > occurredAt (IND-03)", () => {
  const s = simulate({ seed: SEED, durationTicks: TICKS, inductionEnabled: true });
  const inducted = s.filter(e => e.event.type === "PackageInducted");
  for (const e of inducted) {
    const ev = e.event as PackageInducted;
    expect(ev.payload.slaDeadlineIso > ev.payload.occurredAt).toBe(true);
  }
});
```

---

### 9. `packages/simulation/test/continuation-equivalence.unit.test.ts` (modified)

**Analog:** `packages/simulation/test/continuation-equivalence.unit.test.ts` — `FEATURE_CASES` array + `SHORT_TIMING` constant (lines 110-148)

**Add to `FEATURE_CASES` array** (after the `"all-on"` entry, line 148):
```typescript
{
  name: "induction",
  opts: {
    timing: SHORT_TIMING,  // SHORT_TIMING already defined at line 110-114
    inductionEnabled: true,
  },
},
```

**SCALE BOUND:** The existing loop at line 157 handles chunks automatically. The `"induction"` feature case uses chunk-7 (same as non-`"all-on"` features), horizon=800. This is exactly ONE added test case — no new matrix.

**Alternatively** (if the ALL_ON approach is preferred per RESEARCH.md Pitfall 6): extend the `"all-on"` opts to include `inductionEnabled: true` (1-line change) instead of a separate case.

---

### 10. Reducers — `packages/projections/src/reducers/hub-inventory.ts` (service, CRUD)

**Analog:** `packages/projections/src/reducers/hub-inventory.ts` — `PackageArrivedAtHub` real-action case (lines 163-167)

**Pattern to copy** (lines 163-167 — the ACTIVE case):
```typescript
case "PackageArrivedAtHub":
  return placePackage(state, event.payload.packageId, {
    hubId: event.payload.hubId,
    bucket: "inbound",
  });
```

**New case to add** (Decision 3 — add alongside `PackageArrivedAtHub`):
```typescript
case "PackageInducted":
  // IND-01/Decision 3: inducted freight enters the induction hub's inbound bucket.
  // The optimizer reads this via the hub_inventory projection — same path as
  // PackageArrivedAtHub. The package-location reducer also updates last-known-location.
  return placePackage(state, event.payload.packageId, {
    hubId: event.payload.inductionHubId,
    bucket: "inbound",
  });
```

Also add `"PackageInducted"` to the no-op comment block AND the `default: return assertNeverEvent(event)` branch (currently no-op block spans lines 194-213).

---

### 11. Reducers — `package-location.ts`, `trailer-state.ts`, `driver-status.ts`, `driver-assignment.ts`, `tag-registry.ts`, `zone-estimate.ts`, `exceptions.ts`, `trailer-fuel.ts` (services, CRUD)

**Analog:** `packages/projections/src/reducers/package-location.ts` — no-op case block (lines 83-103)

**Pattern to copy** (lines 83-103):
```typescript
case "HubRegistered":
case "RouteRegistered":
case "PackageCreated":
case "TrailerDeparted":
// ... many cases ...
case "TruckRested":
case "TruckRefueled":
  return state;
default:
  return assertNeverEvent(event);
```

**New no-op case to add in ALL 8 reducers** (before existing no-op block, or as new case):
```typescript
case "PackageInducted":  // IND-01: no-op for [this reducer] — induction only affects
                          // hub-inventory (Decision 3) and package-location.
```

For `package-location.ts` specifically: the research recommends updating location to `inductionHubId` (mirrors `PackageArrivedAtHub` path). If that decision is taken:
```typescript
case "PackageInducted": {
  const next = new Map(state);
  next.set(event.payload.packageId, {
    packageId: event.payload.packageId,
    hubId: event.payload.inductionHubId,
    confidence: DIRECT_SCAN_CONFIDENCE,
    lastSeenAt: occurredAt,
  });
  return next;
}
```

**NOTE:** `audit-timeline.ts` uses its own local `assertNeverAudit` (line 267), not `assertNeverEvent`. `geo-track.ts` uses `assertNeverGeo` (line 347). Both need `case "PackageInducted": return null;` / `return { state, keyframes: [] };` respectively, following the pattern of their existing no-op returns.

---

### 12. `packages/optimizer/src/rolling/scope.ts` (service, event-driven)

**Analog:** `packages/optimizer/src/rolling/scope.ts` — `hubsOf()` exhaustive switch (lines 27-75), `PackageCreated` active case (lines 33-34)

**Pattern to copy — ACTIVE case** (lines 33-34):
```typescript
case "PackageCreated":
  return [event.payload.originHubId, event.payload.destHubId];
```

**New active case to add** (not a no-op — must return both hub ids):
```typescript
case "PackageInducted":
  // IND-01/Pitfall 3: must return BOTH hub ids or the optimizer silently ignores
  // inducted freight. [inductionHubId, destHubId] — same pattern as PackageCreated.
  return [event.payload.inductionHubId, event.payload.destHubId];
```

**Warning:** Adding `"PackageInducted"` to the existing no-op group (lines 54-69) is the Pitfall 3 mistake — the optimizer would never react to induction events. It must be a REAL return.

**`default` exhaustiveness guard** (lines 70-74 — unchanged):
```typescript
default: {
  const _never: never = event;
  return _never;
}
```

---

### 13. `packages/optimizer/src/rolling/types.ts` (model, CRUD)

**Analog:** `packages/optimizer/src/rolling/types.ts` — `TwinDriver.remainingDriveMinutes` additive optional field pattern (lines 68-76)

**Pattern to copy** (lines 74-75):
```typescript
readonly remainingDriveMinutes: number;
// OPT-HOS-02 (Phase 16) — OPTIONAL full per-shift HOS clock (DRV-02)...
readonly clock?: ...; // additive optional — prior plans reproduce byte-identically
```

**`TwinBlock` extension** (current lines 50-56):
```typescript
export interface TwinBlock {
  readonly blockId: string;
  readonly nextUnloadHubId: string;
  readonly volume: number;
  /**
   * IND-03 — OPTIONAL SLA deadline in epoch-minutes (from `slaDeadlineIso`).
   * When present, the optimizer uses it for slack/critical-ratio prioritization.
   * Absent → pre-Phase-20 plans reproduce byte-identically (additive, non-breaking).
   */
  readonly deadlineMin?: number;  // ADD
}
```

---

### 14. `packages/api/src/ws/envelope.ts` (model, request-response)

**Analog:** `packages/api/src/ws/envelope.ts` — `ExceptionItem` interface (lines 109-121) + `exceptionsNew?: readonly ExceptionItem[]` in `TickPayload` (line 200)

**`ExceptionItem` structure** (lines 109-121 — copy structure, adapt fields):
```typescript
export interface ExceptionItem {
  readonly id: string;
  readonly kind: "wrongTrailer" | "missedUnload" | "blockedFreight" | "lowUtilization";
  readonly severity: "low" | "med" | "high";
  readonly entityId: string;
  readonly reason: string;
  readonly recommendedAction: string;
  readonly simMs: number;
}
```

**New `InductionEvent` interface to add** (before or after `ExceptionItem`):
```typescript
/** VIZ-13 — a package inducted at a spoke hub this tick (transient; not in SnapshotPayload). */
export interface InductionEvent {
  readonly packageId:       string;
  readonly inductionHubId:  string;
  readonly destHubId:       string;
  readonly slaClass:        string;
  readonly slaDeadlineIso:  string;
  readonly occurredAt:      string;
}
```

**`TickPayload` additive extension** — mirrors `exceptionsNew` pattern (line 200):
```typescript
export interface TickPayload {
  // ... all existing fields ...
  readonly exceptionsNew?: readonly ExceptionItem[];
  readonly exceptionsResolved?: readonly string[];
  readonly planChanges?: readonly PlanDelta[];
  /** VIZ-13 — induction events this tick (transient; never in SnapshotPayload). */
  readonly inductionEvents?: readonly InductionEvent[];  // ADD
}
```

**CRITICAL:** `inductionEvents` goes in `TickPayload` ONLY, never `SnapshotPayload` (see Pitfall 7). The snapshot has no `inductionEvents` field.

---

### 15. `packages/web/src/map/inductionColoring.ts` (NEW utility, event-driven)

**Analog:** `packages/web/src/map/stopColoring.ts` — complete file (lines 1-104)

**Full pattern to copy from `stopColoring.ts`** (lines 13-92):
```typescript
// Copy the STRUCTURE of stopColoring.ts exactly:
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";

// 1. Disc radius constant (stopColoring.ts line 20: STOP_RADIUS = 15)
const INDUCTION_RADIUS = 14; // slightly smaller — distinct from stop markers

// 2. Emoji font (stopColoring.ts lines 21-23)
const EMOJI_FONT = '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// 3. Color + glyph (stopColoring.ts lines 29-37)
export const INDUCTION_COLOR = "#7c3aed"; // purple — distinct from hub (green/red) + stop (amber/blue)
const INDUCTION_GLYPH = "+";

// 4. Pre-allocated Style at module load (stopColoring.ts lines 53-69)
const INDUCTION_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: INDUCTION_RADIUS,
    fill: new Fill({ color: INDUCTION_COLOR }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: INDUCTION_GLYPH, font: EMOJI_FONT }),
});

// 5. Zero-allocation StyleFunction (stopColoring.ts lines 85-92)
export function inductionStyle(_feature: FeatureLike): Style {
  return INDUCTION_STYLE_DEFAULT; // no per-kind branching needed — all inductions look the same
}
```

**Key differences from `stopColoring.ts`:**
- Single style (no kind-branching) — all induction markers look identical
- Purple color — distinct from hub colors (green/red), stop colors (amber/blue)
- Used by `createInductionLayer()` in `layers.ts`

---

### 16. `packages/web/src/map/layers.ts` — `createInductionLayer()` (component, event-driven)

**Analog:** `packages/web/src/map/layers.ts` — `createTrailerStopLayer()` (lines 225-229) + `applyTrailerStops()` (lines 244-271)

**Import to add** (line 12 — alongside `stopStyle`):
```typescript
import { stopStyle } from "./stopColoring.js";
import { inductionStyle } from "./inductionColoring.js"; // ADD
```

**`createInductionLayer()` — copy `createTrailerStopLayer()` (lines 225-229)**:
```typescript
/**
 * Create the (initially empty) induction-event layer (VIZ-13). A
 * `PackageInducted` ws message adds a transient pulsing feature here; a
 * `setTimeout` removes it after ~2000 ms. The source is never cleared —
 * features are added + removed individually (same discipline as stopColoring).
 */
export function createInductionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: inductionStyle });
  return { layer, source };
}
```

**`flashInduction()` — the timed-feature approach (apply on each WS `inductionEvents` array)**:
```typescript
/**
 * Flash an induction event at `[lon, lat]` for `durationMs` (default 2000).
 * Adds a transient Point feature and removes it after the timeout.
 * Uses the hub's lon/lat (looked up client-side from the HubDto array).
 */
export function flashInduction(
  source: VectorSource,
  inductionHubId: string,
  lon: number,
  lat: number,
  durationMs: number = 2000,
): void {
  const featureId = `induction:${inductionHubId}:${Date.now()}`;
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

---

## Shared Patterns

### 5-File Closed-Union Extension Ceremony (IND-01)

**Source:** `packages/domain/src/events/` — ALL 5 files must be changed atomically in ONE commit.

**Apply to:** Domain-layer task (Wave 0 first commit).

The 5 files are: `schemas.ts` → `domain-event.ts` → `contract.assert.ts` → `events/index.ts` → `src/index.ts`.

**Build gate:** `pnpm build && pnpm typecheck` immediately after this commit. Any missing step produces:
- Missing from `domainEventSchema`: `Type 'false' is not assignable to type 'true'` (contract.assert.ts:68)
- Missing case from `assertExhaustive`: `Argument of type 'PackageInducted' is not assignable to parameter of type 'never'` (contract.assert.ts:51)

### Opt-In RNG Substream Gate (IND-02)

**Source:** `packages/simulation/src/engine.ts` — `hosEnabled`/`fuelOn` pattern (lines 427-500)

**Apply to:** Simulation engine task.

Three properties MUST be consistent:
1. Salt constant exported (`INDUCTION_RNG_SALT`) — for salt-collision test
2. `Rng | undefined` constructed only when `inductionOn` — never on off path
3. State captured as `induction: number | undefined` in `SerializedRngStates`

If any one of these three is missing, either: the continuation diverges (`inductionEnabled: true` chunked ≠ all-at-once), or the salt-collision test fails to import the constant.

### `assertNeverEvent` Exhaustiveness in Reducers

**Source:** `packages/projections/src/reducers/reducer.ts` — `assertNeverEvent` (lines 37-39)

**Apply to:** ALL 8 standard reducers + `audit-timeline.ts` (uses `assertNeverAudit`) + `geo-track.ts` (uses `assertNeverGeo`).

```typescript
// reducer.ts lines 37-39 — the build-gate mechanism:
export function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled DomainEvent in reducer: ${JSON.stringify(event)}`);
}
```

Adding `PackageInducted` to `DomainEvent` without adding a case to a reducer causes:
`Argument of type 'PackageInducted' is not assignable to parameter of type 'never'`

at compile time. Run `pnpm typecheck` after the domain change — it will list every missing case.

### Zero-Allocation OL StyleFunction

**Source:** `packages/web/src/map/stopColoring.ts` — pre-allocated `Style` at module load (lines 53-92)

**Apply to:** `inductionColoring.ts` (NEW file).

Rule: pre-allocate ONE `Style` (or a `ReadonlyMap<string, Style>`) at module load. The `StyleFunction` returns cached references only — zero per-frame allocation.

### Additive Optional Field Pattern

**Source:** `packages/optimizer/src/rolling/types.ts` — `TwinDriver.clock?` additive optional field

**Apply to:** `TwinBlock.deadlineMin?` addition.

Additive optionals (`?: T`) preserve pre-Phase-20 byte-identity: existing `TwinBlock` objects without `deadlineMin` continue to serialize identically. The optimizer's priority logic `if (block.deadlineMin !== undefined)` gates the new behavior.

---

## No Analog Found

All files have strong analogs. No "no analog found" entries.

---

## Verification Notes (Research.md Staleness Checks)

All cited line numbers were verified against the live codebase in this session:

| Claim | Verified? | Live Line |
|-------|-----------|-----------|
| `eventSchema` factory at schemas.ts:34-43 | CONFIRMED | Lines 34-43 |
| `DomainEvent` union at domain-event.ts:140-165 | CONFIRMED | Lines 140-165 |
| `assertExhaustive` at contract.assert.ts:25-53 | CONFIRMED | Lines 25-53 |
| Type-equality proof at contract.assert.ts:68 | CONFIRMED | Line 68 |
| Salt constants at engine.ts:71-103 | CONFIRMED (lines 73-103) | Lines 73-103 |
| `hosEnabled` gate at engine.ts:427 | CONFIRMED | Lines 427-428 |
| `fuelRng` substream at engine.ts:496-500 | CONFIRMED | Lines 496-500 |
| `createPackageBatch` at engine.ts:904-925 | CONFIRMED | Lines 904-935 |
| `dispatch()` at engine.ts:1488-1517 | CONFIRMED | Lines 1488-1517 |
| Bootstrap block at engine.ts:1520-1533 | CONFIRMED | Lines 1520-1534 |
| `captureContinuation()` at engine.ts:1558-1603 | CONFIRMED | Lines 1558-1603 |
| `SimTask` union at continuation.ts:27-51 | CONFIRMED | Lines 27-51 |
| `SerializedRngStates.fuel` at continuation.ts:103 | CONFIRMED | Line 102-103 |
| `SerializedWorldState` at continuation.ts:76-93 | CONFIRMED | Lines 76-93 |
| `hubInventoryReducer` switch at hub-inventory.ts:162-216 | CONFIRMED | Lines 162-217 |
| `packageLocationReducer` switch at package-location.ts:60-107 | CONFIRMED | Lines 60-107 |
| `assertNeverEvent` at reducer.ts:37-39 | CONFIRMED | Lines 37-39 |
| `hubsOf()` exhaustive switch at scope.ts:27-76 | CONFIRMED | Lines 27-75 |
| `TwinBlock` at optimizer/types.ts:50-56 | CONFIRMED | Lines 50-56 |
| `ExceptionItem` at envelope.ts:109-121 | CONFIRMED | Lines 109-121 |
| `TickPayload.exceptionsNew` at envelope.ts:200 | CONFIRMED | Line 200 |
| `createTrailerStopLayer()` at layers.ts:225-229 | CONFIRMED | Lines 225-229 |
| `stopStyle` at stopColoring.ts:85-92 | CONFIRMED | Lines 85-92 |
| Salt-collision test at fuel-determinism.unit.test.ts:43-56 | CONFIRMED | Lines 42-57 |
| `SHORT_TIMING` + `FEATURE_CASES` at continuation-equivalence.unit.test.ts:110-148 | CONFIRMED | Lines 110-148 |

**Corrections to RESEARCH.md claims:**
- RESEARCH.md claims `audit-timeline.ts` and `geo-track.ts` use `assertNeverEvent`. CORRECTED: they use local `assertNeverAudit` (line 267) and `assertNeverGeo` (line 347) respectively. Both still enforce exhaustiveness with `never` — the mechanism is the same, but the import is NOT from `reducer.js`. The no-op return values also differ: `return null` (audit) and `return { state, keyframes: [] }` (geo).
- RESEARCH.md cites `fuel-determinism.unit.test.ts:43-56` for 5 existing salts. VERIFIED: the array has 5 salts; `INDUCTION_RNG_SALT` will be the 6th added. The file imports from `engine.ts` — add `INDUCTION_RNG_SALT` to the import.
- `trailer-fuel.ts` reducer also uses `assertNeverEvent` (confirmed line 162-163). It is not in RESEARCH.md's reducer list but must also receive a `PackageInducted` no-op case.

---

## Metadata

**Analog search scope:** `packages/domain/src/`, `packages/simulation/src/`, `packages/simulation/test/`, `packages/projections/src/reducers/`, `packages/optimizer/src/rolling/`, `packages/api/src/ws/`, `packages/web/src/map/`
**Files scanned:** 25
**Pattern extraction date:** 2026-06-24
