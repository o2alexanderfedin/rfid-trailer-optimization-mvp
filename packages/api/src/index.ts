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
export {
  PRODUCTION_DETECTION_CONFIG,
  DEMO_RFID_CONFIG,
  DEMO_OVER_CARRY_CONFIG,
  resolveDemoHosEnabled,
} from "./detection-config.js";
// Phase 18: re-export the FMCSA HOS limits so downstream consumers (e.g. the
// @mm/web real-e2e globalSetup, which does NOT depend on @mm/domain directly)
// can drive the LIVE HOS-on demo path with the same default config as `main.ts`.
export { DEFAULT_HOS_CONFIG } from "@mm/domain";
export type { HosConfig } from "@mm/domain";
export type { OverCarryConfig } from "./detection-config.js";
export { registerPlanRoutes } from "./routes/plan.js";
export type { PlanResponseDto, ScoredPlanDto } from "./routes/plan.js";
// Plan 05-04 (VIZ-05) / Phase 14 (HUBQ-04): trailer plan detail DTO.
export { registerPlanDetailRoutes } from "./routes/plan-detail.js";
export type { TrailerPlanDto, RearToNoseSlice } from "./routes/plan-detail.js";
// Phase 14 (HUBQ-01..07): the hub-detail read endpoint + DTOs.
export { registerHubDetailRoutes } from "./routes/hub-detail.js";
export type {
  HubDetailDto,
  HubTrailerDto,
  HubTrailerDriverDto,
} from "./routes/hub-detail.js";
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
  SimSpeedState,
} from "./ws/envelope.js";
export { diffTick } from "./ws/envelope.js";
export { driveSimulation, driveSimulationPaced } from "./sim/driver.js";
export type {
  DriveSimulationOptions,
  DriveSimulationPacedOptions,
} from "./sim/driver.js";
export { makeSpeedController } from "./sim/speed-controller.js";
export type {
  SpeedController,
  SpeedControllerOptions,
} from "./sim/speed-controller.js";
export { registerSimSpeedRoutes } from "./routes/sim-speed.js";
export type { SimSpeedControllerPort } from "./routes/sim-speed.js";

// --- Walking-skeleton spine (Plan 01) — kept green; GET /hubs preserved ------
export { buildApp } from "./app.js";
export type { HubDto } from "./app.js";
export { seedHubs } from "./seed.js";
