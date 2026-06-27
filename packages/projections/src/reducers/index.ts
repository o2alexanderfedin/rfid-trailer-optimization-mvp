/** Barrel for the pure operational reducers (FND-05/06/07) + shared contract. */
export type { OccurredEvent, Reducer } from "./reducer.js";
export { assertNeverEvent } from "./reducer.js";

export type {
  PackageLocation,
  PackageLocationState,
} from "./package-location.js";
export {
  DIRECT_SCAN_CONFIDENCE,
  emptyPackageLocationState,
  packageLocationReducer,
} from "./package-location.js";

export type { TrailerState, TrailerStateMap, TrailerStatus } from "./trailer-state.js";
export { emptyTrailerStateMap, trailerStateReducer } from "./trailer-state.js";

export type {
  HubInventory,
  HubInventoryState,
  InventoryBucket,
} from "./hub-inventory.js";
export { emptyHubInventoryState, hubInventoryReducer } from "./hub-inventory.js";

// --- PRJ-01: driver duty status + HOS summary -------------------------------
export type { DriverStatus, DriverStatusState } from "./driver-status.js";
export { driverStatusReducer, emptyDriverStatusState } from "./driver-status.js";

// --- PRJ-02: driver -> trip/trailer assignment ------------------------------
export type {
  DriverAssignment,
  DriverAssignmentState,
} from "./driver-assignment.js";
export {
  driverAssignmentReducer,
  emptyDriverAssignmentState,
} from "./driver-assignment.js";

// --- SNS-02: tag -> package registry ----------------------------------------
export type { TagRegistryState } from "./tag-registry.js";
export {
  emptyTagRegistryState,
  resolveTag,
  tagRegistryReducer,
} from "./tag-registry.js";

// --- SNS-02/03: latest fused zone estimate per (packageId, trailerId) -------
export type {
  ResolveTag,
  ZoneEstimateDeps,
  ZoneEstimateState,
} from "./zone-estimate.js";
export {
  DEFAULT_DWELL_WINDOW_MS,
  emptyZoneEstimateState,
  makeZoneEstimateReducer,
  zoneEstimateKey,
} from "./zone-estimate.js";

// --- OUT-05 (P2) / D-22-3: event-derived delivery KPI (delivered + on-time) -
export type { DeliveryKpiState } from "./delivery-kpi.js";
export { deliveryKpiReducer, emptyDeliveryKpiState } from "./delivery-kpi.js";

// --- SNS-04/05: open exceptions feed + false-positive-rate KPI + COORD-03 ----
export type {
  CoordinationRejectReason,
  ExceptionKind,
  ExceptionsState,
  OpenException,
} from "./exceptions.js";
export {
  COORDINATION_REJECT_LABELS,
  coordinationRejectId,
  emptyExceptionsState,
  exceptionId,
  exceptionsReducer,
  falsePositiveRate,
  FALSE_POSITIVE_SEVERITY,
  openExceptions,
} from "./exceptions.js";
