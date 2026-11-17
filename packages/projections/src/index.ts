/**
 * `@mm/projections` — the operational-twin read models (FND-05/06/07) built
 * from PURE reducers, plus the inline (read-your-writes) applier and the
 * truncate+replay rebuild driver that together prove deterministic
 * rebuildability (FND-04, the phase keystone).
 *
 * Dependency discipline: this package depends ONLY on `@mm/domain` + `kysely`.
 * It does NOT import `@mm/event-store` (which depends on it for the inline hub
 * projection — importing back would create a cycle). The rebuild driver instead
 * takes the event reader as a parameter (dependency inversion), so production
 * code stays acyclic while tests can inject `@mm/event-store`'s `readAll`.
 */

// --- Walking-skeleton hub projection (Plan 01 spine — kept green) ------------
export type { HubUpsert, HubProjectionWrite } from "./hub-projection.js";
export { projectHub } from "./hub-projection.js";

// --- Pure reducer contract --------------------------------------------------
export type { OccurredEvent, Reducer } from "./reducers/reducer.js";
export { assertNeverEvent } from "./reducers/reducer.js";

// --- FND-05: package last-known location -------------------------------------
export type {
  PackageLocation,
  PackageLocationState,
} from "./reducers/package-location.js";
export {
  DIRECT_SCAN_CONFIDENCE,
  emptyPackageLocationState,
  packageLocationReducer,
} from "./reducers/package-location.js";

// --- FND-06: trailer current state / assignment ------------------------------
export type {
  TrailerState,
  TrailerStateMap,
  TrailerStatus,
} from "./reducers/trailer-state.js";
export {
  emptyTrailerStateMap,
  trailerStateReducer,
} from "./reducers/trailer-state.js";

// --- FND-07: hub inventory (inbound / outbound / staged) ---------------------
export type {
  HubInventory,
  HubInventoryState,
  InventoryBucket,
} from "./reducers/hub-inventory.js";
export {
  emptyHubInventoryState,
  hubInventoryReducer,
} from "./reducers/hub-inventory.js";

// --- PRJ-01: driver duty status + HOS summary --------------------------------
export type {
  DriverStatus,
  DriverStatusState,
} from "./reducers/driver-status.js";
export {
  driverStatusReducer,
  emptyDriverStatusState,
} from "./reducers/driver-status.js";

// --- PRJ-02: driver -> trip/trailer assignment -------------------------------
export type {
  DriverAssignment,
  DriverAssignmentState,
} from "./reducers/driver-assignment.js";
export {
  driverAssignmentReducer,
  emptyDriverAssignmentState,
} from "./reducers/driver-assignment.js";

// --- SNS-02: tag -> package registry (inline, decision-critical) -------------
export type { TagRegistryState } from "./reducers/tag-registry.js";
export {
  emptyTagRegistryState,
  resolveTag,
  tagRegistryReducer,
} from "./reducers/tag-registry.js";

// --- SNS-02/03: latest fused zone estimate per (packageId, trailerId) --------
export type {
  ResolveTag,
  ZoneEstimateDeps,
  ZoneEstimateState,
} from "./reducers/zone-estimate.js";
export {
  DEFAULT_DWELL_WINDOW_MS,
  emptyZoneEstimateState,
  makeZoneEstimateReducer,
  zoneEstimateKey,
} from "./reducers/zone-estimate.js";

// --- SNS-04/05: open exceptions feed + false-positive-rate KPI + COORD-03 ----
export type {
  CoordinationRejectReason,
  ExceptionKind,
  ExceptionsState,
  OpenException,
} from "./reducers/exceptions.js";
export {
  COORDINATION_REJECT_LABELS,
  coordinationRejectId,
  emptyExceptionsState,
  exceptionId,
  exceptionsReducer,
  falsePositiveRate,
  FALSE_POSITIVE_SEVERITY,
  openExceptions,
} from "./reducers/exceptions.js";

// --- FND-08 (catch-up): package audit timeline -------------------------------
export type {
  AuditTimelineEntry,
  StoredEventLike,
} from "./reducers/audit-timeline.js";
export { auditTimelineReducer } from "./reducers/audit-timeline.js";

// --- Catch-up: geo-track (trailer position keyframes for the map) -------------
export type {
  GeoKeyframe,
  GeoKeyframeKind,
  GeoTrackState,
  GeoTrackStep,
} from "./reducers/geo-track.js";
export { emptyGeoTrackState, geoTrackReducer, legKey } from "./reducers/geo-track.js";

// --- SP2: trailer fuel state (milesSinceRefuel for the planning twin) ---------
export type { TrailerFuel, TrailerFuelState } from "./reducers/trailer-fuel.js";
export {
  emptyTrailerFuelState,
  geometryMiles,
  getTrailerMiles,
  trailerFuelReducer,
} from "./reducers/trailer-fuel.js";

// --- PERF-02: induction deadline (LWW from PackageInducted) -------------------
export type { InductionDeadlineState } from "./reducers/induction-deadline.js";
export {
  emptyInductionDeadlineState,
  inductionDeadlineReducer,
} from "./reducers/induction-deadline.js";

// --- Operational twin: schema + inline applier + rebuild driver --------------
export type {
  ProjectionDatabase,
  PackageLocationTable,
  TrailerStateTable,
  HubInventoryTable,
  DriverStatusTable,
  DriverStatusRow,
  DriverAssignmentTable,
  DriverAssignmentRow,
  TagRegistryTable,
  TagRegistryRow,
  ZoneEstimateTable,
  ZoneEstimateRow,
  ExceptionsTable,
  ExceptionsRow,
  ExceptionKpiTable,
  ExceptionKpiRow,
  AuditTimelineTable,
  GeoRouteTable,
  GeoKeyframeTable,
  TrailerFuelTable,
  TrailerFuelRow,
  InductionDeadlineTable,
  InductionDeadlineRow,
  OperationalProjectionName,
  CatchupProjectionName,
} from "./schema.js";
export {
  PROJECTIONS_SCHEMA_SQL,
  OPERATIONAL_PROJECTIONS,
  CATCHUP_PROJECTIONS,
} from "./schema.js";
export type {
  ReplayEvent,
  OperationalTwin,
  ProjectionDb,
  ExceptionKpiSnapshot,
} from "./runner/inline.js";
export {
  applyInline,
  applyTrailerFuel,
  applyInductionDeadline,
  readOperationalTwin,
  projectionView,
  readOpenExceptions,
  readExceptionKpi,
} from "./runner/inline.js";
export type { ReadAllEvents } from "./runner/rebuild.js";
export { rebuildProjections, serializeTwin } from "./runner/rebuild.js";

// --- SNS-04/05: the detector (PLANNED vs OBSERVED ⇒ exception events) --------
export type {
  AppendExceptions,
  DetectorReads,
  ProjectionReadDeps,
  RunDetectionOptions,
} from "./detector.js";
export {
  ACTIVE_TRAILER_STATUSES,
  isActiveTrailerStatus,
  makeProjectionReads,
  planDetection,
  runDetection,
} from "./detector.js";

// Re-export the (pure) detection config + types from @mm/sensor-fusion so the
// API/sim composition root can configure detection WITHOUT taking a direct
// dependency on @mm/sensor-fusion (it already depends on @mm/projections).
export type {
  DetectionConfig,
  MissedUnloadCandidate,
  PlannedAssignment,
  SlaImpact,
  WrongTrailerCandidate,
  ZoneEstimate,
} from "@mm/sensor-fusion";
export { DEFAULT_DETECTION_CONFIG } from "@mm/sensor-fusion";

// --- Catch-up runner (async poller + rebuild + read side) --------------------
export type {
  CatchupDb,
  CatchupResult,
  ReadAllEvents as ReadAllCatchupEvents,
} from "./runner/catchup.js";
export {
  runCatchup,
  rebuildCatchup,
  readAuditTimeline,
  readTrailerAuditTimeline,
  readGeoKeyframes,
  serializeCatchup,
} from "./runner/catchup.js";
