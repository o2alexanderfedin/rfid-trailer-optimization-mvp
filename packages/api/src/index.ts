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
export { registerPlanRoutes } from "./routes/plan.js";
export type { PlanResponseDto, ScoredPlanDto } from "./routes/plan.js";
export { attachSnapshotSocket } from "./ws/snapshots.js";
export type {
  Broadcast,
  SnapshotBuilder,
  SnapshotSocketOptions,
  SnapshotMessage,
  TrailerSnapshot,
  HubSnapshot,
} from "./ws/snapshots.js";
export { driveSimulation } from "./sim/driver.js";
export type { DriveSimulationOptions } from "./sim/driver.js";

// --- Walking-skeleton spine (Plan 01) — kept green; GET /hubs preserved ------
export { buildApp } from "./app.js";
export type { HubDto } from "./app.js";
export { seedHubs } from "./seed.js";
