# Meaningful Rest & Fuel Stops (+ Optimizer Fuel-Awareness) — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation planning
**Milestone target:** v1.3 (sub-project 2; paced-loop redesign was sub-project 1, already on `develop`)
**Author:** Claude (Opus 4.8) with o2alexanderfedin

---

## 1. Problem / goal

The live demo's trucks drive hub→hub and only pause invisibly: the v1.2 HOS engine already inserts driver rests (`resting` 10h, `on_break` 30-min) mid-transit as `DriverDutyStateChanged` events, but they have **no location and no map presence**, and there is **no fuel model at all**. The user wants **meaningful stops**: trucks visibly **resting at rest areas** (sleeping / meal / restroom) and **refueling**, with the planner aware of that lost time.

Three deliverables:
1. **Sim realism** — deterministic per-trailer odometer + fuel; emit rest/refuel stop events.
2. **Map visibility** — trucks shown **parked / refueling** mid-route for the stop duration.
3. **Optimizer fuel-awareness** — the (already timing- & HOS-aware) optimizer accounts for **expected refuel time** in leg timing / feasibility, extending OPT-09/10.

### Research (Google AI Mode, trucking domain)
- Class 8: dual tanks 240–300 gal, ~6.5–7.5 mpg → ~1,300–1,750 mi operational range; drivers **top off ~once a day, bundled with the 10-h rest or the 30-min meal break**. HOS: 11-h drive / 14-h window / 10-h off-duty / 30-min break after 8 h cumulative — **already modeled in v1.2**.
- DES modeling (Google AI Mode): in an event-sourced sim, model stops as **explicit domain events** (visibility, exact timelines, native fit) rather than implicit duty-state math; **never** wall-clock — sim-time only.

---

## 2. Decisions (locked with user)

| Decision | Choice |
|----------|--------|
| Scope | Visible rest **and** fuel stops **+ optimizer fuel-awareness** (the larger option) |
| Rests | **Reuse v1.2 HOS** (10-h rest, 30-min break). 30-min break **is** the meal/restroom stop (no separate event). Add a located `TruckRested` event + map "parked" rendering. |
| Fuel | **New**, deterministic, **mileage-triggered** (~1,200 mi), co-located with a due rest when possible. New `TruckRefueled` event + map "refueling" rendering. |
| Stop position | Carried as **interpolated route position computed by the geo-track projection** (events stay geometry-free). |
| Feature gating | **Opt-in `FuelConfig`, OFF by default** → HOS-off golden stays byte-identical; HOS-on/fuel-on stays deterministic (regenerate v1.2 baselines — expected, not a determinism break). |
| Optimizer | **Fuel-aware**: add expected refuel time to leg timing via `Stop.refuelMin` (mirrors OPT-HOS-02 `restMin`); inline default unchanged. |
| Optimizer rest-cost | Out of scope to change HOS objective weights; fuel-awareness is purely additive timing. |

---

## 3. Non-goals (YAGNI)

- No real rest-area / fuel-station geodata (stops are points interpolated along the existing route LineString).
- No fuel **price** modeling, station capacity/queueing, or fuel-cost objective term.
- No change to `driveSimulation` (sync) / paced-driver pacing — orthogonal to this feature.
- No new optimizer objective terms; refuel only affects **timing/feasibility** (consistent with OPT-09/10).

---

## 4. Component A — Domain events & config (`@mm/domain`)

Two new events (additive context; **no RNG in payload** → determinism-safe), following the existing `eventSchema` + discriminated-union + closed-union pattern:

```ts
// TruckRested — emitted alongside the existing DriverDutyStateChanged(resting|on_break)
{ type: "TruckRested", schemaVersion: 1, payload: {
  trailerId, tripId,
  reason: "rest-10h" | "break-30min",
  durationMin: number,         // from the HOS segment that triggered it
  occurredAt: ISO,             // sim time the stop begins
}}

// TruckRefueled — emitted when the per-trailer odometer crosses the refuel threshold
{ type: "TruckRefueled", schemaVersion: 1, payload: {
  trailerId, tripId,
  gallons: number,             // refilled amount (deterministic from tank model)
  odometerMiles: number,       // cumulative miles at refuel (pre-reset)
  durationMin: number,         // refuel service time
  occurredAt: ISO,
}}
```

- Files: `events/schemas.ts` (two `eventSchema` + add to `z.discriminatedUnion`), `events/domain-event.ts` (union + `z.infer` types), `events/index.ts` (exports). `contract.assert.ts` enforces type-equality.
- **`FuelConfig`** (new, mirrors `RfidSimConfig`/`TimingConfig`; lives in `@mm/domain` so both sim + optimizer import it):
```ts
export interface FuelConfig {
  readonly enabled?: boolean;            // default false (golden off)
  readonly tankCapacityGallons: number;  // 150
  readonly milesPerGallon: number;       // 6.5
  readonly refuelThresholdMiles: number; // 1200  (refuel when miles-since-refuel ≥ this)
  readonly refuelTimeMinutes: number;    // 30
}
export const DEFAULT_FUEL_CONFIG: FuelConfig = { enabled: false, tankCapacityGallons: 150, milesPerGallon: 6.5, refuelThresholdMiles: 1200, refuelTimeMinutes: 30 };
```

---

## 5. Component B — Simulation (`@mm/simulation`)

- **Per-trailer odometer**: a `Map<trailerId, milesSinceRefuel>` in engine state (alongside `driverByTrailer`/`clockByDriver`), init 0 at roster seeding.
- **Per-leg miles**: `legMiles = haversineKm(fromHub, toHub) × 0.621371` (ORS `distance_m` when the road-geometry file is present; haversine fallback — matches how transit timing already resolves).
- **On departure** (`departTrailer`): `odometer += legMiles`. If `fuel.enabled` and `odometer ≥ refuelThresholdMiles`, schedule a **refuel stop** during the trip (co-located in time with a rest if the HOS engine inserts one this leg; else as its own mid-leg pause) and emit `TruckRefueled` at the stop's sim time; reset odometer to 0; refilled `gallons = round((odometer_at_refuel / mpg))` capped at tank capacity.
- **On HOS rest/break insertion** (`accrueDrivingLeg` already emits `DriverDutyStateChanged(resting|on_break)`): also emit `TruckRested` with the same `occurredAt` + the segment's `minutes` as `durationMin` and the mapped `reason`.
- **Determinism**: a new seeded substream `fuelRng = makeRng(seed ^ FUEL_RNG_SALT)` **only created when `fuel.enabled`** (zero draws when off → golden byte-identical). Any refuel-time jitter (if added) drawn from `fuelRng` at deterministic event-queue order. Rests reuse the existing `hosRng`/HOS segment timing (no new draws).
- **`SimulateOptions`** gains `fuel?: FuelConfig`. The live demo (`main.ts`) enables it (env `FUEL_ENABLED`, default on for the demo, like HOS).

---

## 6. Component C — Projections (`@mm/projections`)

- **Fuel state for the twin** — extend the trailer/operational projection (or a small dedicated `trailer_fuel` reducer) with `milesSinceRefuel` per trailer: `+= legMiles` on `TrailerArrivedAtHub` (leg miles from route geometry/haversine), reset to 0 on `TruckRefueled`. Pure reducer, deterministic. Used by the twin-snapshot builder for optimizer fuel-awareness (§7).
- **Geo-track viz** (`reducers/geo-track.ts`): handle `TruckRested` / `TruckRefueled` → emit a `GeoKeyframe` with new `kind: "rested" | "refueling"` at the **interpolated route position** for the stop's `occurredAt` (fraction along the in-flight leg geometry between the `depart` keyframe time and the leg's arrival time) carrying `durationMinutes`. Keyframe key extended so a stop doesn't collide with depart/arrive (e.g. key by `(trailerId, tripId, kind, occurredAt)` or a stop sequence index).
- Determinism: positions are a pure function of logged geometry + `occurredAt` (no clock/RNG) → `rebuildCatchup` stays byte-identical to the live run.

---

## 7. Component D — Optimizer fuel-awareness (`@mm/optimizer` + api twin-snapshot)

Mirror OPT-HOS-02's `restMin` injection exactly (smallest seam — no core VRPTW/objective change):
1. `TwinRoute` gains `distanceMiles: number` (snapshot builder: ORS `distance_m`→mi, else haversine mi).
2. `TwinTrailer` gains `milesSinceRefuel: number` (from §6 projection).
3. `EpochInput` gains `fuelConfig?: FuelConfig` (optional, like `timing`; default `DEFAULT_FUEL_CONFIG`).
4. `Stop` (vrptw/types.ts) gains `refuelMin?: number` (default 0).
5. `stopsForTrailer()` computes `refuelMin` per stop via a pure helper `refuelMinForStop(...)`: walk the planned route accumulating `distanceMiles` from `trailer.milesSinceRefuel`; when cumulative crosses `refuelThresholdMiles`, that stop gets `refuelMin = refuelTimeMinutes` and the running total resets.
6. Departure formulas fold it in (exactly like `restMin`):
   - `feasibility.ts feasibleArrivals`: `departureMin = serviceStart + serviceMin + (restMin ?? 0) + (refuelMin ?? 0)`
   - `route-trailers.ts hosLegsFeasible`: `legStartMin += legMinutes + serviceMin + (restMin ?? 0) + (refuelMin ?? 0)`
7. Effect: refuel time pushes ETAs/feasibility out → reflected in plan timing (and HOS feasibility), consistent with OPT-09/10. Objective terms unchanged; **inline default with no `fuelConfig` ⇒ byte-identical to current** (refuelMin defaults 0).
- Integer-round all fuel-derived minutes at the boundary (anti-P12), like dwell/transit.
- Snapshot builder (`api/src/optimizer/twin-snapshot.ts`) populates `distanceMiles` + `milesSinceRefuel`.

---

## 8. Component E — Web (`@mm/web`)

- Accept geo-keyframe kinds `rested` / `refueling`: render the trailer as a **stationary marker** at that position for `durationMinutes` (no tween during the stop), then resume tween toward arrival. Distinct icon/color (e.g. rested = amber "P", refueling = blue fuel glyph).
- Legend: add a "Truck status" row (moving / rested / refueling).
- Keep the OL map instance in the existing ref; drive from the WS snapshot as today (no architectural change).

---

## 9. Determinism & testing strategy (TDD)

**Determinism**
- Fuel OFF (default): `fuelRng` never created, no new events, no projection deltas → **byte-identical to the current golden** (assert in a new sim test).
- Fuel ON + HOS ON + same seed/config → byte-identical across runs (deterministic). The v1.2 HOS-on baseline assertions that enumerate event types/counts **will change** (new event types) → regenerate them (expected; documented).
- Optimizer: `runEpoch` stays pure; `inline` default + absent `fuelConfig` ⇒ identical results (existing optimizer tests unchanged).

**New/updated tests**
- `@mm/domain`: schema validation for `TruckRested`/`TruckRefueled`; contract assert.
- `@mm/simulation`: (a) fuel-OFF golden byte-identity; (b) fuel-ON determinism (same seed→same stream); (c) odometer accrues per leg + refuel resets at threshold + `TruckRefueled` emitted; (d) `TruckRested` emitted with each HOS rest/break (reason+duration); (e) regenerate `determinism.unit.test.ts` / `hos-determinism.unit.test.ts` baselines.
- `@mm/projections`: geo-track emits `rested`/`refueling` keyframes at interpolated positions; `milesSinceRefuel` accrual+reset; `rebuildCatchup` equivalence.
- `@mm/optimizer`: mirror `time-aware.test.ts` — increasing `refuelMin`/crossing threshold pushes ETA/feasibility; integer-rounding; idempotency; **back-compat (no fuelConfig ⇒ prior result)**.
- `@mm/web`: rested/refueling markers render (jsdom/RTL) from a snapshot fixture.
- Integration (`@mm/api`): a fuel-on live-demo int test — `TruckRested`/`TruckRefueled` reach projections; geo-track keyframes present; optimizer plan reflects refuel timing.

---

## 10. Acceptance criteria

1. `pnpm build` (turbo) + full `unit`/`integration`/`ui` lanes green; lint clean; no `any`.
2. Fuel **OFF** golden byte-identical to current (determinism keystone test).
3. Fuel **ON** deterministic (same seed/config → byte-identical); regenerated HOS-on baselines committed.
4. Sim emits located `TruckRested` (per HOS rest/break) + odometer-triggered `TruckRefueled` (~every 1,200 mi).
5. Optimizer: refuel time changes ETA/feasibility when a leg crosses the threshold; **no change when `fuelConfig` absent** (existing tests pass unmodified).
6. Live demo (browser): trucks visibly **park at rest areas and refuel** mid-route, with distinct markers + legend; no regression to the paced-loop smoothness.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Golden churn cascades across packages | Fuel OFF default keeps all golden-off tests green; regenerate only the HOS-on baselines, in one reviewed step. |
| Stop position interpolation drift vs client tween | Projection computes position from the same logged geometry + occurredAt the client uses; assert via rebuild-equivalence. |
| Optimizer fuel double-counting with HOS rest at the same stop | refuelMin and restMin are independent additive terms; when a refuel is co-located with a rest, both apply (models real "refuel during the rest" only partially — acceptable; documented). Revisit if it overstates time. |
| Twin needs odometer (new projection field) | Small pure reducer addition; off-default trailers report 0 → optimizer adds 0 refuelMin (back-compat). |
| Determinism break via new RNG ordering | `fuelRng` only when enabled; draws at deterministic event-queue order; off ⇒ zero draws. |

---

## 12. File-level change map (anticipated)

- `@mm/domain`: `events/schemas.ts`, `events/domain-event.ts`, `events/index.ts`, new `fuel.ts` (`FuelConfig`+default), `contract.assert.ts`.
- `@mm/simulation`: `src/engine.ts` (odometer, `fuelRng`, emit `TruckRested`/`TruckRefueled`, `SimulateOptions.fuel`), salt const; tests incl. golden regen.
- `@mm/projections`: `src/reducers/geo-track.ts` (+kinds), trailer-fuel reducer/field, schema; tests.
- `@mm/optimizer`: `rolling/types.ts` (`distanceMiles`, `milesSinceRefuel`, `EpochInput.fuelConfig`), `vrptw/types.ts` (`Stop.refuelMin`), `vrptw/feasibility.ts`, `vrptw/route-trailers.ts`, `rolling/epoch.ts` (`stopsForTrailer`+`refuelMinForStop`); tests.
- `@mm/api`: `src/optimizer/twin-snapshot.ts` (populate `distanceMiles`+`milesSinceRefuel`), `main.ts` (`FUEL_ENABLED` wiring); int test.
- `@mm/web`: trailer-layer rendering + legend; tests.

---

## 13. Out of scope → future

Fuel price/station capacity, fuel-cost objective term, rest-area geodata, and fuel-aware re-routing (choosing WHERE to refuel) are deferred. This delivers realistic visible stops + timing-accurate fuel-aware planning.
