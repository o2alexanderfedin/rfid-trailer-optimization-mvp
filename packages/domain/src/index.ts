/**
 * `@mm/domain` — the zero-(workspace-)dependency leaf that defines the Phase-1
 * operational vocabulary:
 *
 *  - entity types (Package, Trailer, Hub, DockDoor, Route, Trip; LoadBlock /
 *    TrailerSlice stubs for Phase 2),
 *  - the CLOSED, VERSIONED `DomainEvent` discriminated union (FND-01),
 *  - one zod schema per event type,
 *  - the typed ingestion boundary `validateEvent` (FND-03).
 *
 * This is the single contract every other package imports. Only `zod` is a
 * runtime dependency.
 */

import type { DomainEvent } from "./events/index.js";
import { validateEvent } from "./ingestion/validate.js";

// --- Entities ---------------------------------------------------------------
export type {
  BlockKey,
  DockDoor,
  Driver,
  DutyStatus,
  HosClock,
  Hub,
  LoadBlock,
  LonLat,
  Package,
  Route,
  SizeClass,
  Trailer,
  TrailerSlice,
  Trip,
} from "./entities/index.js";
export {
  blockKeySchema,
  dockDoorSchema,
  driverSchema,
  dutyStatusSchema,
  hosClockSchema,
  hubSchema,
  loadBlockSchema,
  lonLatSchema,
  packageSchema,
  routeSchema,
  sizeClassSchema,
  trailerSchema,
  trailerSliceSchema,
  tripSchema,
} from "./entities/index.js";

// --- Events (closed, versioned union + per-event zod schemas) ---------------
export type {
  DomainEvent,
  DomainEventType,
  EventEnvelope,
  HubRegistered,
  PackageArrivedAtHub,
  PackageCreated,
  PackageScanned,
  PlanAccepted,
  PlanGenerated,
  RouteRegistered,
  TrailerArrivedAtHub,
  TrailerDeparted,
  TrailerDocked,
  Severity,
  RfidObserved,
  WrongTrailerDetected,
  MissedUnloadDetected,
  DriverRegistered,
  DriverAssignedToTrip,
  DriverDutyStateChanged,
  DriverSwappedAtHub,
  UnloadStarted,
  LoadStarted,
  UnloadCompleted,
  TruckRested,
  TruckRefueled,
  PackageInducted,
  PlanSuperseded,
} from "./events/index.js";
export {
  assertNever,
  domainEventSchema,
  hubRegisteredSchema,
  packageArrivedAtHubSchema,
  packageCreatedSchema,
  packageScannedSchema,
  EVENT_SCHEMA_VERSION,
  planAcceptedSchema,
  planGeneratedSchema,
  routeRegisteredSchema,
  trailerArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerDockedSchema,
  severitySchema,
  rfidObservedSchema,
  wrongTrailerDetectedSchema,
  missedUnloadDetectedSchema,
  driverRegisteredSchema,
  driverAssignedToTripSchema,
  driverDutyStateChangedSchema,
  driverSwappedAtHubSchema,
  unloadStartedSchema,
  loadStartedSchema,
  unloadCompletedSchema,
  truckRestedSchema,
  truckRefueledSchema,
  packageInductedSchema,
  planSupersededSchema,
} from "./events/index.js";

// --- Shared FUEL contract (SP2 §4 — sim odometer + optimizer fuel-awareness) --
export type { FuelConfig } from "./fuel.js";
export { DEFAULT_FUEL_CONFIG } from "./fuel.js";

// --- Phase-2 planning value types (the shared planner/aggregation contract) --
export type {
  DeadlineBucket,
  HandlingClass,
  PlannerConfig,
  PlanningPackage,
  RouteStop,
  SizeWeightClass,
  SlaClass,
} from "./planning/index.js";
export {
  DEFAULT_PLANNER_CONFIG,
  deadlineBucketSchema,
  handlingClassSchema,
  plannerConfigObjectSchema,
  plannerConfigSchema,
  planningPackageSchema,
  routeStopSchema,
  sizeWeightClassSchema,
  SLA_CLASS_WEIGHT,
  slaClassSchema,
} from "./planning/index.js";

// --- Shared timing contract (v1.1 — sim draws + optimizer estimate, DRY) -----
export type { LogNormalParams, TimingConfig } from "./timing.js";
export { DEFAULT_TIMING_CONFIG, expectedMinutes } from "./timing.js";

// --- Shared HOS contract (v1.2 HOS-01 — full-FMCSA limits, sim + optimizer) --
export type {
  DrivingLegResult,
  DutySegment,
  HosConfig,
  SleeperBerthResult,
} from "./hos.js";
export {
  applyDrivingLeg,
  applySleeperBerthPeriod,
  DEFAULT_HOS_CONFIG,
  epochMinutesToIso,
  hosConfigSchema,
  isoToEpochMinutes,
  mayDriveNow,
  remainingLegalDriveMinutes,
} from "./hos.js";

// --- Shared geography→transit derivation (v1.1 Phase-7 OPT-09/OPT-10) --------
// Pure helpers the optimizer imports (it cannot import @mm/simulation) and the
// simulator re-imports — one source of truth for per-leg transit + role dwell.
export {
  expectedDwellMinutes,
  expectedTransitMinutes,
  haversineKm,
  transitParamsForLeg,
} from "./timing-geo.js";

// --- Ingestion boundary (FND-03) --------------------------------------------
export { validateEvent, ValidationError } from "./ingestion/validate.js";

/**
 * Back-compat alias for the original skeleton API. `parseDomainEvent` is the
 * name the event store and earlier plans imported; it is identical to
 * `validateEvent` (the FND-03 boundary). New code should prefer `validateEvent`.
 */
export function parseDomainEvent(input: unknown): DomainEvent {
  return validateEvent(input);
}
