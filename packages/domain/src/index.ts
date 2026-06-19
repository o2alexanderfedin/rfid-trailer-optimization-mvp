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
  RouteRegistered,
  TrailerArrivedAtHub,
  TrailerDeparted,
  TrailerDocked,
} from "./events/index.js";
export {
  assertNever,
  domainEventSchema,
  hubRegisteredSchema,
  packageArrivedAtHubSchema,
  packageCreatedSchema,
  packageScannedSchema,
  PHASE1_SCHEMA_VERSION,
  routeRegisteredSchema,
  trailerArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerDockedSchema,
} from "./events/index.js";

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
  plannerConfigSchema,
  planningPackageSchema,
  routeStopSchema,
  sizeWeightClassSchema,
  SLA_CLASS_WEIGHT,
  slaClassSchema,
} from "./planning/index.js";

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
