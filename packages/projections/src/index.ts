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

// --- Operational twin: schema + inline applier + rebuild driver --------------
export type {
  ProjectionDatabase,
  PackageLocationTable,
  TrailerStateTable,
  HubInventoryTable,
  AuditTimelineTable,
  GeoRouteTable,
  GeoKeyframeTable,
  CatchupProjectionName,
} from "./schema.js";
export {
  PROJECTIONS_SCHEMA_SQL,
  OPERATIONAL_PROJECTIONS,
  CATCHUP_PROJECTIONS,
} from "./schema.js";
export type { ReplayEvent, OperationalTwin, ProjectionDb } from "./runner/inline.js";
export { applyInline, readOperationalTwin, projectionView } from "./runner/inline.js";
export type { ReadAllEvents } from "./runner/rebuild.js";
export { rebuildProjections, serializeTwin } from "./runner/rebuild.js";

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
  readGeoKeyframes,
  serializeCatchup,
} from "./runner/catchup.js";
