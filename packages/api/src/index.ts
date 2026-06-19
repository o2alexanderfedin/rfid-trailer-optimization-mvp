// --- Full query API + ws (Plan 06 composition root) -------------------------
export { buildServer } from "./server.js";
export type { ServerDeps, BuiltServer } from "./server.js";
export { registerQueryRoutes } from "./routes/queries.js";
export type {
  ApiDb,
  PackageLocationDto,
  TrailerDto,
  HubInventoryDto,
  AuditEntryDto,
  RouteDto,
} from "./routes/queries.js";
// --- Phase 3 (SNS-04/05): exception feed + FP KPI + zone-estimate query ------
export { registerExceptionRoutes } from "./routes/exceptions.js";
export type {
  ExceptionDto,
  ExceptionKpiDto,
  ZoneEstimateDto,
} from "./routes/exceptions.js";
export { PRODUCTION_DETECTION_CONFIG, DEMO_RFID_CONFIG } from "./detection-config.js";
export { registerPlanRoutes } from "./routes/plan.js";
export type { PlanResponseDto, ScoredPlanDto } from "./routes/plan.js";
export { registerOptimizerRoutes } from "./routes/optimizer.js";
export type {
  OptimizerRecommendationsDto,
  RecommendationDto,
} from "./routes/optimizer.js";
export { RollingOptimizerService } from "./optimizer/rolling-service.js";
export type {
  RollingEpochOutcome,
  RollingOptimizerDeps,
} from "./optimizer/rolling-service.js";
export { attachSnapshotSocket } from "./ws/snapshots.js";
export type {
  Broadcast,
  SnapshotPayloadBuilder,
  SnapshotSocketOptions,
  // Legacy shims (deprecated — use WsEnvelope from ./ws/envelope.js directly):
  SnapshotMessage,
  TrailerSnapshot,
  HubSnapshot,
  SnapshotBuilder,
} from "./ws/snapshots.js";
// VIZ-04 versioned wire types — the new canonical exports for @mm/web:
export type {
  WsEnvelope,
  SnapshotPayload,
  TickPayload,
  TrailerKeyframe,
  HubState,
  RouteState,
  ExceptionItem,
  PlanDelta,
  KpiSnapshot,
} from "./ws/envelope.js";
export { diffTick } from "./ws/envelope.js";
export { driveSimulation } from "./sim/driver.js";
export type { DriveSimulationOptions } from "./sim/driver.js";

// --- Walking-skeleton spine (Plan 01) — kept green; GET /hubs preserved ------
export { buildApp } from "./app.js";
export type { HubDto } from "./app.js";
export { seedHubs } from "./seed.js";
