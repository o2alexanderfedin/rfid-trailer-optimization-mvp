export type {
  DomainEvent,
  DomainEventType,
  EventEnvelope,
  HubRegistered,
  RouteRegistered,
  PackageCreated,
  PackageScanned,
  PackageArrivedAtHub,
  TrailerDeparted,
  TrailerArrivedAtHub,
  TrailerDocked,
} from "./domain-event.js";
export { assertNever } from "./domain-event.js";
export {
  PHASE1_SCHEMA_VERSION,
  domainEventSchema,
  hubRegisteredSchema,
  routeRegisteredSchema,
  packageCreatedSchema,
  packageScannedSchema,
  packageArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerArrivedAtHubSchema,
  trailerDockedSchema,
} from "./schemas.js";
