import type { z } from "zod";
import type {
  actionSuggestedSchema,
  driverAssignedToTripSchema,
  driverDutyStateChangedSchema,
  driverRegisteredSchema,
  driverSwappedAtHubSchema,
  hubRegisteredSchema,
  loadStartedSchema,
  missedUnloadDetectedSchema,
  packageArrivedAtHubSchema,
  packageCreatedSchema,
  packageDeliveredSchema,
  packageInductedSchema,
  packageScannedSchema,
  planAcceptedSchema,
  planGeneratedSchema,
  planSupersededSchema,
  rfidObservedSchema,
  routeRegisteredSchema,
  severitySchema,
  suggestionAcceptedSchema,
  suggestionRejectedSchema,
  trailerArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerDivertedSchema,
  trailerDockedSchema,
  truckRefueledSchema,
  truckRestedSchema,
  unloadCompletedSchema,
  unloadStartedSchema,
  wrongTrailerDetectedSchema,
} from "./schemas.js";

/**
 * The Phase-1 domain event contract: a CLOSED, VERSIONED discriminated union
 * (FND-01) keyed on `type`, with a `schemaVersion` discriminator (P11).
 *
 * Envelope shape — established by the walking skeleton and depended on by the
 * event store, projections, and simulation:
 *
 *   { type, schemaVersion, payload }
 *
 * The `data`/`occurredAt` ledger concerns live at the persistence boundary:
 * `occurred_at` is recorded by the event store from the caller-supplied domain
 * clock (never `Date.now()` inside the domain), keeping this package a pure,
 * deterministic, zero-(workspace)-dependency leaf.
 *
 * Each member type is inferred from its zod schema (events/schemas.ts) so the
 * hand-written union and the runtime validator are provably the same shape —
 * one source of truth, no drift (proven by a type-equality test).
 */

/**
 * Generic event envelope. All Phase-1 events are
 * `EventEnvelope<TType, TPayload>` with `schemaVersion: 1`.
 */
export interface EventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly schemaVersion: number;
  readonly payload: TPayload;
}

export type HubRegistered = z.infer<typeof hubRegisteredSchema>;
export type RouteRegistered = z.infer<typeof routeRegisteredSchema>;
export type PackageCreated = z.infer<typeof packageCreatedSchema>;
export type PackageScanned = z.infer<typeof packageScannedSchema>;
export type PackageArrivedAtHub = z.infer<typeof packageArrivedAtHubSchema>;
export type TrailerDeparted = z.infer<typeof trailerDepartedSchema>;
export type TrailerArrivedAtHub = z.infer<typeof trailerArrivedAtHubSchema>;
export type TrailerDocked = z.infer<typeof trailerDockedSchema>;

// --- Phase-3 events (RFID-assisted validation, SNS-01/04/05) ----------------
/**
 * Exception severity — the fixed, closed taxonomy (`info | warning | critical`)
 * shared by both detection events, so the exception feed has a single, stable
 * ranking vocabulary. Inferred from {@link severitySchema} (one source of truth).
 */
export type Severity = z.infer<typeof severitySchema>;
/** A single RFID observation of a tag at a reader/antenna (SNS-01). OBSERVED layer. */
export type RfidObserved = z.infer<typeof rfidObservedSchema>;
/** A package observed in a trailer other than the planned one (SNS-04). */
export type WrongTrailerDetected = z.infer<typeof wrongTrailerDetectedSchema>;
/** A package still aboard after its unload hub departed (SNS-05). */
export type MissedUnloadDetected = z.infer<typeof missedUnloadDetectedSchema>;

// --- Phase-4 plan-lifecycle events (OPT-04) ---------------------------------

/**
 * A candidate plan was produced over the twin (purely observational — OPT-04
 * mandates NO side effect on evaluation). Carries the weighted objective and a
 * hard feasibility flag kept distinct from the score (anti-P2).
 */
export type PlanGenerated = z.infer<typeof planGeneratedSchema>;

/**
 * The ONE operational side effect when a candidate plan is committed (OPT-04).
 */
export type PlanAccepted = z.infer<typeof planAcceptedSchema>;

// --- Phase-9 (v1.2) driver-lifecycle events (EVT-01) ------------------------

/** A driver joined a hub's pool/roster (the renewable-resource registration). */
export type DriverRegistered = z.infer<typeof driverRegisteredSchema>;
/** A free driver was bound to a trip on dispatch. */
export type DriverAssignedToTrip = z.infer<typeof driverAssignedToTripSchema>;
/**
 * A driver moved between duty states; carries the `reason` + an {@link HosClock}
 * snapshot so the projection folds the authoritative clock (no recompute).
 */
export type DriverDutyStateChanged = z.infer<
  typeof driverDutyStateChangedSchema
>;
/** A relay handoff — a trip's trailer was reassigned to a fresh hub-pool driver. */
export type DriverSwappedAtHub = z.infer<typeof driverSwappedAtHubSchema>;

// --- Phase-9 (v1.2) authoritative load/unload phase events (EVT-02) ---------

/** Unloading began at a hub (after `TrailerDocked`). Identifiers + clock only. */
export type UnloadStarted = z.infer<typeof unloadStartedSchema>;
/** Loading began at a hub (before `TrailerDeparted`). Identifiers + clock only. */
export type LoadStarted = z.infer<typeof loadStartedSchema>;
/** Unloading finished (after the last unload scan). Identifiers + clock only. */
export type UnloadCompleted = z.infer<typeof unloadCompletedSchema>;

// --- SP2 visible rest/fuel stop events (spec §4) ----------------------------

/**
 * A trailer parked for a driver rest/break (alongside `DriverDutyStateChanged`).
 * Carries `reason` + `durationMin` only — NO lon/lat, NO RNG (the geo-track
 * projection computes the map position from the logged leg geometry).
 */
export type TruckRested = z.infer<typeof truckRestedSchema>;
/**
 * A trailer refueled mid-route (odometer crossed `refuelThresholdMiles`). Carries
 * the deterministic `gallons` + cumulative `odometerMiles` + `durationMin` — NO
 * lon/lat, NO RNG (geometry-free; the geo-track projection interpolates position).
 */
export type TruckRefueled = z.infer<typeof truckRefueledSchema>;

// --- v2.0 external induction (IND-01) ---------------------------------------

/**
 * Freight entered the network from outside at a spoke hub (IND-01 / v2.0).
 * COEXISTS with `PackageCreated` (internal center-origin spawn). `slaDeadlineIso`
 * is locked at induction; `externalOriginRef` is a deterministic counter id. The
 * optimizer reads inducted packages via the `hub_inventory` projection's
 * `inbound` bucket (Decision 3).
 */
export type PackageInducted = z.infer<typeof packageInductedSchema>;

// --- Phase-21 bidirectional freight / consolidation (FLOW-04 / D-21-1) -------

/**
 * The SOLE stage-mutating plan event (FLOW-04 / D-21-1). Emitted by the
 * optimizer in the SAME atomic append as the new `PlanAccepted` that supersedes
 * a prior plan. Carries HOLISTIC scope state (`supersededPackageIds`) so the
 * hub-inventory reducer's dumb pure delete-then-apply wipes the prior plan's
 * staged freight without stranding old-plan-only items. `priorPlanId` + `reason`
 * give a replayable audit trail.
 */
export type PlanSuperseded = z.infer<typeof planSupersededSchema>;

// --- Phase-22 outbound delivery (OUT-01) ------------------------------------

/**
 * The TERMINAL delivery event (OUT-01 / Phase 22). Freight reaching its
 * DESTINATION hub exits the network here after a seeded outbound dwell. It
 * DELETE-purges the package from the read-model projections (`packageLocation`,
 * `hubInventory`, `zoneEstimate`), completing the bounded-memory story (OUT-04).
 * `onTime` carries the SLA flag computed at emit (D-22-5). Emitted ONLY when
 * `outboundDeliveryEnabled === true` (the determinism keystone).
 */
export type PackageDelivered = z.infer<typeof packageDeliveredSchema>;

// --- Phase-24 OODA truck divert (OODA-01) -----------------------------------

/**
 * The OODA truck agent's re-route decision (OODA-01 / Phase 24) — the ONE
 * genuinely-new truck decision with no current centralized analog. A truck
 * diverts from its planned next hub (`fromHubId`) to an alternate (`toHubId`)
 * with a closed `reason`. Carries `tripId` + from/to hub ids for a replayable
 * audit trail (T-24-02); NO lon/lat, NO RNG (geometry-free).
 */
export type TrailerDiverted = z.infer<typeof trailerDivertedSchema>;

// --- Phase-25 advisory coordination events (COORD-02) -----------------------

/**
 * An ADVISORY coordination suggestion from a regional-center coordinator
 * (COORD-01/02 / Phase 25). NON-binding: the target Phase-24 agent accepts it
 * (→ a binding event + {@link SuggestionAccepted}) or rejects it against its own
 * local feasibility (→ {@link SuggestionRejected}). The RICH payload feeds the
 * five anti-oscillation guards (COORD-04). Ids + a closed `kind` enum + an
 * integer/string-only `params` + sim-time INTEGER ms only — NO lon/lat, NO RNG
 * (geometry-free; the hashed payload is pinned via `canonicalizeSuggestionPayload`).
 * Streamed on `coordinator-<centerId>`. SCOPE-NEUTRAL in scope.ts.
 */
export type ActionSuggested = z.infer<typeof actionSuggestedSchema>;

/**
 * The target agent ACCEPTED an {@link ActionSuggested}; it then emits the
 * corresponding binding domain event in the SAME in-fold step. Carries the
 * `suggestionId` correlation key + the virtual-clock `occurredAt`. Streamed on
 * the target's own stream. SCOPE-NEUTRAL — never re-triggers the coordinator.
 */
export type SuggestionAccepted = z.infer<typeof suggestionAcceptedSchema>;

/**
 * The target agent DECLINED an {@link ActionSuggested} against the binding local
 * feasibility it alone knows (Phase 24). The CLOSED `reasonCode`
 * (`hos | fuel | dock | infeasible`) drives the visible reject-with-reason demo
 * moment (COORD-03, surfacing wired in Plan 03). SCOPE-NEUTRAL (anti-feedback-
 * storm, Pitfall 11).
 */
export type SuggestionRejected = z.infer<typeof suggestionRejectedSchema>;

/**
 * The closed `DomainEvent` union — the single contract every other package
 * imports (FND-01). Adding an event means adding a member here AND a schema in
 * events/schemas.ts; the type-equality proof in contract.assert.ts fails the
 * BUILD if they diverge.
 */
export type DomainEvent =
  | HubRegistered
  | RouteRegistered
  | PackageCreated
  | PackageScanned
  | PackageArrivedAtHub
  | TrailerDeparted
  | TrailerArrivedAtHub
  | TrailerDocked
  | RfidObserved
  | WrongTrailerDetected
  | MissedUnloadDetected
  | PlanGenerated
  | PlanAccepted
  // Phase-9 (v1.2) driver-lifecycle events (EVT-01).
  | DriverRegistered
  | DriverAssignedToTrip
  | DriverDutyStateChanged
  | DriverSwappedAtHub
  // Phase-9 (v1.2) load/unload phase events (EVT-02).
  | UnloadStarted
  | LoadStarted
  | UnloadCompleted
  // SP2 visible rest/fuel stop events (spec §4).
  | TruckRested
  | TruckRefueled
  // v2.0 external induction (IND-01).
  | PackageInducted
  // Phase-21 bidirectional freight / consolidation (FLOW-04 / D-21-1).
  | PlanSuperseded
  // Phase-22 terminal delivery event (OUT-01).
  | PackageDelivered
  // Phase-24 OODA truck divert (OODA-01).
  | TrailerDiverted
  // Phase-25 advisory coordination events (COORD-02).
  | ActionSuggested
  | SuggestionAccepted
  | SuggestionRejected;

/** The discriminator literal — useful for exhaustive switches in reducers. */
export type DomainEventType = DomainEvent["type"];

/**
 * Exhaustiveness helper. Call in the `default` branch of a `switch` over a
 * closed union: if a new member is added without a case, this STOPS COMPILING
 * (the argument is no longer assignable to `never`). At runtime it throws,
 * guarding against unsafe casts that bypass the type system.
 */
export function assertNever(value: never): never {
  throw new Error(
    `Unhandled DomainEvent variant: ${JSON.stringify(value)}`,
  );
}
