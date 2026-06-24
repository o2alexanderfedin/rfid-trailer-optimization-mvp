# Rest & Fuel Stops (+ Optimizer Fuel-Awareness) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. **Executed by competing rival agents in isolated worktrees; a judge selects the winner.** Implement the WHOLE plan; compete on correctness, test quality, determinism discipline, and SOLID/KISS/DRY — not on resolving ambiguity differently. Where this plan fixes a contract (interfaces, formulas, test contracts), follow it exactly so rival outputs stay comparable & mergeable. Spec: `docs/superpowers/specs/2026-06-23-rest-fuel-stops-design.md`.

**Goal:** Add deterministic, visible truck **rest** (reuse HOS) and **fuel** stops to the sim + map, and make the optimizer **fuel-aware** (expected refuel time in leg timing), opt-in and golden-preserving.

**Architecture:** New opt-in `FuelConfig` (off by default). Sim tracks a per-trailer odometer and emits located `TruckRested`/`TruckRefueled` events (refuel overlaps a co-located rest → `max`, not sum). Projections track `milesSinceRefuel` (for the twin) and emit geo-track `rested`/`refueling` keyframes at interpolated route positions. The optimizer adds `Stop.refuelMin` folded into ETA/feasibility via `max(restMin, refuelMin)` (mirrors OPT-HOS-02). Web renders parked/refueling markers.

**Tech Stack:** TypeScript 5.9 strict, Vitest 4, zod, Kysely/pg, OpenLayers/React (web). Packages: `@mm/domain`, `@mm/simulation`, `@mm/projections`, `@mm/optimizer`, `@mm/api`, `@mm/web`.

## Global Constraints

- No `any`/assertions-to-silence/new non-null. Explicit types, discriminated unions.
- TDD: failing test → run-fail → minimal impl → run-pass → commit. Frequent atomic commits.
- **Determinism keystone:** fuel/stops are **opt-in (`FuelConfig.enabled` default false)**. Fuel OFF ⇒ NO new RNG draws, NO new events, NO projection deltas ⇒ **byte-identical to the current golden**. Fuel ON ⇒ deterministic (same seed+config → same stream). New seeded substream `fuelRng = makeRng((seed ^ FUEL_RNG_SALT) >>> 0)`, created ONLY when enabled.
- **No-double-count:** effective added stop time = `Math.max(restMin ?? 0, refuelMin ?? 0)` (refuel inside a co-located rest). `max(restMin,0)===restMin` keeps HOS-only timing byte-identical.
- Stops carry NO lon/lat and NO RNG in payload (geometry-free; positions computed by the geo-track projection).
- `driveSimulation`/paced-driver pacing untouched. Optimizer `inline` default + absent `fuelConfig` ⇒ byte-identical to current.
- Gate: turbo `pnpm build`, `vitest --project unit`, `--project integration`, `--project ui`, `pnpm lint` all green (run unit lane with repo-root-relative paths).

---

## File Structure
- `@mm/domain`: `src/fuel.ts` (new — `FuelConfig`+`DEFAULT_FUEL_CONFIG`), `src/events/schemas.ts`, `src/events/domain-event.ts`, `src/events/index.ts`, `src/events/contract.assert.ts`, `src/index.ts` (exports).
- `@mm/simulation`: `src/engine.ts` (odometer, `fuelRng`, emit stops, `SimulateOptions.fuel`), `src/rng.ts` or salts file (`FUEL_RNG_SALT`); tests under `test/`.
- `@mm/projections`: `src/reducers/geo-track.ts` (+kinds+interp), trailer-fuel field/reducer + `src/schema.ts`; tests.
- `@mm/optimizer`: `src/rolling/types.ts`, `src/vrptw/types.ts`, `src/vrptw/feasibility.ts`, `src/vrptw/route-trailers.ts`, `src/rolling/epoch.ts`; tests.
- `@mm/api`: `src/optimizer/twin-snapshot.ts`, `src/main.ts`; `test/*.int.test.ts`.
- `@mm/web`: trailer layer + legend component(s); tests.

## Interfaces (the fixed contract)
```ts
// @mm/domain/fuel.ts
export interface FuelConfig { readonly enabled?: boolean; readonly tankCapacityGallons: number; readonly milesPerGallon: number; readonly refuelThresholdMiles: number; readonly refuelTimeMinutes: number; }
export const DEFAULT_FUEL_CONFIG: FuelConfig = { enabled: false, tankCapacityGallons: 150, milesPerGallon: 6.5, refuelThresholdMiles: 1200, refuelTimeMinutes: 30 };

// events (payloads) — schemaVersion 1, NO lon/lat, NO rng
TruckRested:   { trailerId, tripId, reason: "rest-10h" | "break-30min", durationMin: number, occurredAt: string }
TruckRefueled: { trailerId, tripId, gallons: number, odometerMiles: number, durationMin: number, occurredAt: string }

// @mm/simulation SimulateOptions
fuel?: FuelConfig

// @mm/optimizer
// TwinRoute  += distanceMiles: number
// TwinTrailer += milesSinceRefuel: number
// EpochInput += fuelConfig?: FuelConfig
// Stop (vrptw/types.ts) += refuelMin?: number
export function refuelMinForStop(args: { milesBefore: number; legDistanceMiles: number; fuel: FuelConfig }): { refuelMin: number; milesAfter: number };
// departure folds: serviceMin + Math.max(restMin ?? 0, refuelMin ?? 0)

// @mm/projections geo-track
// GeoKeyframe.kind: "depart" | "arrive" | "rested" | "refueling"
// GeoKeyframe += durationMinutes?: number
```

---

### Task 1 — Domain: FuelConfig + events
**Files:** create `packages/domain/src/fuel.ts`; modify `events/schemas.ts`, `events/domain-event.ts`, `events/index.ts`, `events/contract.assert.ts`, `src/index.ts`. Tests: `events/*.test.ts` (follow existing schema tests).
**Produces:** `FuelConfig`/`DEFAULT_FUEL_CONFIG`, `TruckRested`/`TruckRefueled` types+schemas in the closed union.
- [ ] **Step 1 (RED):** add tests — `truckRestedSchema`/`truckRefueledSchema` accept valid payloads + reject bad (missing field, wrong reason enum, negative durationMin); the discriminated union parses both; `DEFAULT_FUEL_CONFIG` shape.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement `fuel.ts`; add the two `eventSchema(...)` defs; add to `z.discriminatedUnion("type", [...])`; add `z.infer` types + to the `DomainEvent` union; export from `events/index.ts` + `src/index.ts`; ensure `contract.assert.ts` covers them.
- [ ] **Step 4:** run → pass; `pnpm --filter @mm/domain build` clean.
- [ ] **Step 5:** commit `feat(domain): FuelConfig + TruckRested/TruckRefueled events`.

### Task 2 — Simulation: odometer, fuel RNG, emit stops (golden-preserving)
**Files:** `packages/simulation/src/engine.ts` (+ salt const); tests under `packages/simulation/test/`.
**Consumes:** Task 1. **Produces:** `SimulateOptions.fuel`; emits `TruckRested` (per HOS rest/break) + `TruckRefueled` (odometer ≥ threshold), with `max` no-double-count arrival.
- [ ] **Step 1 (RED):** tests — (a) **fuel OFF (default) ⇒ stream byte-identical to current** `simulate({seed,durationTicks})` (keystone); (b) fuel ON ⇒ deterministic (same seed/config → byte-identical) + different from OFF; (c) odometer accrues `haversine mi/leg`, `TruckRefueled` fires at/after threshold then odometer resets; (d) a `TruckRested` accompanies each HOS `resting`/`on_break` with matching `durationMin`+`reason`; (e) refuel co-located with a rest adds NO extra arrival delay vs the rest alone; a lone refuel delays arrival by `refuelTimeMinutes`.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement: `odometerByTrailer` map (init 0); `FUEL_RNG_SALT`; `fuelRng` created only when `fuel.enabled`; in `departTrailer` accrue `legMiles` + refuel decision (reset, emit `TruckRefueled`); in `accrueDrivingLeg` emit `TruckRested` alongside the existing `DriverDutyStateChanged`; arrival adds `max(restMinutesThisLeg, refuelTimeMinutes)`; thread `SimulateOptions.fuel` (default `DEFAULT_FUEL_CONFIG`).
- [ ] **Step 4:** run → pass.
- [ ] **Step 5 (golden regen):** run `determinism.unit.test.ts` + `hos-determinism.unit.test.ts`; the HOS-ON baselines (event type/count enumerations) now include the new events — inspect, confirm correct, update the baseline assertions. The HOS-OFF + fuel-OFF goldens MUST remain unchanged. Commit `feat(sim): per-trailer odometer + located rest/refuel stops (opt-in, deterministic)`.

### Task 3 — Projections: fuel state + geo-track stop keyframes
**Files:** `packages/projections/src/reducers/geo-track.ts`, trailer-fuel reducer/field + `src/schema.ts`; tests.
**Consumes:** Tasks 1–2. **Produces:** `milesSinceRefuel` per trailer (for the twin); geo-track `rested`/`refueling` keyframes at interpolated positions.
- [ ] **Step 1 (RED):** tests — (a) `milesSinceRefuel` accrues per `TrailerArrivedAtHub` leg + resets on `TruckRefueled`; (b) geo-track emits a `rested` keyframe on `TruckRested` and `refueling` on `TruckRefueled`, positioned by interpolating the in-flight leg geometry at `(occurredAt − departAt)/(arriveAt − departAt)`, carrying `durationMinutes`; (c) keyframe keying lets a stop coexist with depart/arrive (no overwrite); (d) `rebuildCatchup` byte-identical to live.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the reducer cases + field; extend `GeoKeyframe.kind` + `durationMinutes`; pure (no clock/RNG).
- [ ] **Step 4:** run → pass.
- [ ] **Step 5:** commit `feat(projections): trailer milesSinceRefuel + geo-track rest/refuel keyframes`.

### Task 4 — Optimizer fuel-awareness
**Files:** `packages/optimizer/src/rolling/types.ts`, `vrptw/types.ts`, `vrptw/feasibility.ts`, `vrptw/route-trailers.ts`, `rolling/epoch.ts`; tests (mirror `rolling/time-aware.test.ts`).
**Consumes:** Task 1. **Produces:** `TwinRoute.distanceMiles`, `TwinTrailer.milesSinceRefuel`, `EpochInput.fuelConfig?`, `Stop.refuelMin?`, `refuelMinForStop`, `max`-folded departures.
- [ ] **Step 1 (RED):** tests — (a) **back-compat: absent `fuelConfig` (and `milesSinceRefuel:0`) ⇒ byte-identical EpochResult to current** (incl. an HOS-rest leg — `max(restMin,0)===restMin`); (b) a trailer whose planned legs cross `refuelThresholdMiles` gets `refuelMin=refuelTimeMinutes` at the crossing stop → later ETA / changed feasibility; (c) co-located refuel+rest at a stop ⇒ added time = `max` (NOT sum); (d) integer-rounding (anti-P12); (e) idempotency (identical inputs ⇒ byte-identical).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement `refuelMinForStop` (pure); `stopsForTrailer` walks the route accumulating `distanceMiles` from `trailer.milesSinceRefuel`, assigning `refuelMin` at the crossing stop + resetting the running total; change both departure formulas to `+ Math.max(restMin ?? 0, refuelMin ?? 0)`; add the type fields; `EpochInput.fuelConfig ?? DEFAULT_FUEL_CONFIG`.
- [ ] **Step 4:** run → pass; run the FULL optimizer suite — all prior tests green (back-compat).
- [ ] **Step 5:** commit `feat(optimizer): fuel-aware leg timing via Stop.refuelMin (max, not sum)`.

### Task 5 — API wiring: twin-snapshot + main
**Files:** `packages/api/src/optimizer/twin-snapshot.ts`, `src/main.ts`; `test/*.int.test.ts`.
**Consumes:** Tasks 1,3,4. **Produces:** snapshot populates `distanceMiles` (ORS `distance_m`→mi, else haversine mi) + `milesSinceRefuel` (from Task 3); demo enables fuel via `FUEL_ENABLED`.
- [ ] **Step 1 (RED):** an int test (testcontainers) — fuel-on live run produces `TruckRested`/`TruckRefueled` in the store, geo-track `rested`/`refueling` keyframes, `milesSinceRefuel` in the twin snapshot, and an optimizer plan whose timing reflects refuel (vs fuel-off).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement snapshot population; `main.ts` reads `FUEL_ENABLED` (default on for demo, like HOS) → `fuel: { ...DEFAULT_FUEL_CONFIG, enabled }` into `driveSimulationPaced`/sim + `fuelConfig` into the loop/epoch input.
- [ ] **Step 4:** run → pass.
- [ ] **Step 5:** commit `feat(api): wire fuel config + odometer/distance into twin snapshot + demo`.

### Task 6 — Web: parked/refueling rendering
**Files:** `packages/web` trailer layer + legend; tests (jsdom/RTL).
**Consumes:** Task 3 (keyframe kinds). **Produces:** stationary color-coded markers for `rested`/`refueling` for `durationMinutes`; legend row.
- [ ] **Step 1 (RED):** jsdom/RTL test — given a snapshot with a `rested`/`refueling` trailer, the map layer renders a stationary marker (distinct style) and the legend shows the new "Truck status" row.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement rendering (no tween during a stop; resume after `durationMinutes`) + legend; keep the OL map in its ref.
- [ ] **Step 4:** run → pass (`--project ui`).
- [ ] **Step 5:** commit `feat(web): render parked/refueling trucks + legend`.

### Task 7 — Full gate + golden + demo verify
- [ ] `pnpm build` (turbo) green.
- [ ] `vitest --project unit` + `--project integration` + `--project ui` all green; regenerated baselines committed; fuel-OFF goldens unchanged.
- [ ] `pnpm lint` clean (fix ALL).
- [ ] Manual demo (browser, fresh DB): `FUEL_ENABLED=1 FLEET_PER_SPOKE=3 pnpm --filter @mm/api demo` + web → confirm trucks visibly **park at rest areas and refuel** mid-route with distinct markers + legend; paced-loop smoothness intact; screenshot.
- [ ] commit any fixups `chore: SP2 gate fixups`.

---

## Self-Review (vs spec)
- Spec §4 → Task 1; §5 → Task 2; §6 → Task 3; §7 → Task 4 + §5 snapshot; §8 → Task 6; §9 tests spread across Tasks 1–6 + Task 7; §10 acceptance → Task 7. No section unmapped.
- Placeholders: none. Type consistency: `FuelConfig` (T1,2,4,5), events (T1,2,3,5), `Stop.refuelMin`/`max` formula (T4), geo-keyframe kinds (T3,6), `milesSinceRefuel` (T3,4,5), `distanceMiles` (T4,5) — all identical across tasks.
- Determinism: fuel-OFF byte-identity asserted (T2a); optimizer back-compat byte-identity asserted (T4a); both keystones.
- Known risk: golden regen touches HOS-on baselines only (T2 step 5) — do it as one reviewed step; fuel-off goldens must stay green.
