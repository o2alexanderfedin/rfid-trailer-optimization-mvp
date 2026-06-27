import { z } from "zod";
import {
  dutyStatusSchema,
  hosClockSchema,
  hubSchema,
  lonLatSchema,
  sizeClassSchema,
} from "../entities/index.js";
import { slaClassSchema } from "../planning/index.js";

/**
 * One zod schema per Phase-1 event type, composed into a single closed
 * `z.discriminatedUnion("type", [...])` — the runtime mirror of the
 * hand-written `DomainEvent` union (events/domain-event.ts).
 *
 * Discipline:
 *  - Every event carries an explicit `schemaVersion` literal (P11). An
 *    unsupported version fails the literal, so old/future shapes are *rejected*,
 *    never silently coerced (threat T-01-06).
 *  - Payloads are `.strict()` so an unexpected/extra field is a hard error at
 *    the ingestion boundary (threat T-01-05), preventing untyped JSONB drift.
 *  - `id` reuses a non-empty-string constraint so empty ids are rejected.
 */

const id = z.string().min(1);

/** The current schema version for every domain event (Phase-1 + Phase-4 plan events). */
export const EVENT_SCHEMA_VERSION = 1 as const;
const schemaVersion = z.literal(EVENT_SCHEMA_VERSION);

/**
 * Build a `{ type, schemaVersion, payload }` event schema from a payload shape.
 * Keeps all eight definitions DRY and uniform (KISS).
 */
function eventSchema<TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  payload: z.ZodObject<TShape>,
) {
  return z.object({
    type: z.literal(type),
    schemaVersion,
    payload: payload.strict(),
  });
}

// --- Per-event payloads -----------------------------------------------------

export const hubRegisteredSchema = eventSchema("HubRegistered", hubSchema);

export const routeRegisteredSchema = eventSchema(
  "RouteRegistered",
  z.object({
    routeId: id,
    fromHubId: id,
    toHubId: id,
    geometry: z.array(lonLatSchema),
  }),
);

export const packageCreatedSchema = eventSchema(
  "PackageCreated",
  z.object({
    packageId: id,
    originHubId: id,
    destHubId: id,
    sizeClass: sizeClassSchema,
    weight: z.number().positive(),
    /**
     * Optional RFID tag bound to this package at creation (SNS-02). Additive:
     * Phase-1/2 streams that predate RFID omit it and stay valid; when present,
     * it is the source for the tag→package mapping projection. The payload is
     * `.strict()`, so an unknown field would be rejected — this declaration is
     * what makes the new field accepted, not silently dropped.
     */
    rfidTagId: id.optional(),
  }),
);

export const packageScannedSchema = eventSchema(
  "PackageScanned",
  z.object({
    packageId: id,
    hubId: id,
    scanType: z.enum(["inbound", "outbound", "load", "unload"]),
  }),
);

export const packageArrivedAtHubSchema = eventSchema(
  "PackageArrivedAtHub",
  z.object({
    packageId: id,
    hubId: id,
  }),
);

export const trailerDepartedSchema = eventSchema(
  "TrailerDeparted",
  z.object({
    trailerId: id,
    fromHubId: id,
    toHubId: id,
    tripId: id,
    packageIds: z.array(id),
  }),
);

export const trailerArrivedAtHubSchema = eventSchema(
  "TrailerArrivedAtHub",
  z.object({
    trailerId: id,
    hubId: id,
    tripId: id,
  }),
);

export const trailerDockedSchema = eventSchema(
  "TrailerDocked",
  z.object({
    trailerId: id,
    hubId: id,
    dockDoorId: id,
  }),
);

// --- Phase-3 events (RFID-assisted validation, SNS-01/04/05) ----------------

/**
 * Confidence in [0, 1]. Shared by every RFID/detection payload. The upper bound
 * is a structural guard at the ingestion boundary (T-03-01): no observed or
 * detected event can carry confidence > 1 even if a fusion bug overshoots —
 * complementing the ≤ 0.85 cap the fusion layer applies upstream (P5b).
 */
const confidence = z.number().min(0).max(1);

/**
 * Exception severity — a fixed, closed taxonomy reused by both detection events
 * so the exception feed has a single, stable ranking vocabulary.
 */
export const severitySchema = z.enum(["info", "warning", "critical"]);

/**
 * RfidObserved (SNS-01, spec §8.3): a single fused-or-raw RFID observation of a
 * tag at a reader/antenna. This is the OBSERVED layer — evidence, not truth
 * (anti-P6). It carries only zone-relevant ids + signal strength + a bounded
 * `confidence`; there is no (x, y) coordinate field, so "RFID ≠ coordinates" is
 * structural (T-03-03). `rssi` must be finite (NaN/Infinity rejected, T-03-01).
 */
export const rfidObservedSchema = eventSchema(
  "RfidObserved",
  z.object({
    tagId: id,
    readerId: id,
    antennaId: id,
    rssi: z.number().finite(),
    trailerId: id,
    hubId: id,
    confidence,
  }),
);

/**
 * WrongTrailerDetected (SNS-04): the detector found a package observed in a
 * trailer other than the one it was planned into, above the confidence
 * threshold. Carries the disagreement (observed vs planned), the bounded
 * confidence, a `severity`, and a non-empty `recommendedAction` for the feed.
 */
export const wrongTrailerDetectedSchema = eventSchema(
  "WrongTrailerDetected",
  z.object({
    packageId: id,
    observedTrailerId: id,
    plannedTrailerId: id,
    confidence,
    severity: severitySchema,
    recommendedAction: id,
  }),
);

/**
 * MissedUnloadDetected (SNS-05): a package destined for a hub is still observed
 * aboard its trailer after departure from that hub, above threshold. Detection
 * is gated POST-departure by the detector; this event is the emitted outcome.
 */
export const missedUnloadDetectedSchema = eventSchema(
  "MissedUnloadDetected",
  z.object({
    packageId: id,
    trailerId: id,
    hubId: id,
    confidence,
    severity: severitySchema,
    recommendedAction: id,
  }),
);

// --- Phase-4 plan-lifecycle payloads (OPT-04) -------------------------------

/**
 * `occurredAt` is an ISO-8601 domain-clock string supplied by the caller (the
 * sim/epoch clock) — NEVER `Date.now()` inside this deterministic leaf.
 */
const occurredAt = z.string().min(1);

/**
 * `PlanGenerated` — a candidate plan was produced over the twin. Purely
 * observational (OPT-04: evaluating candidates has NO side effect). Carries the
 * weighted-objective value (`objectiveCost`, opaque at the domain layer) and a
 * HARD `feasible` flag kept DISTINCT from the objective (anti-P2: feasibility is
 * never folded into the score). `scopeHash` is the optimizer idempotency key.
 */
export const planGeneratedSchema = eventSchema(
  "PlanGenerated",
  z.object({
    epochId: id,
    scopeHash: id,
    planId: id,
    trailerId: id,
    objectiveCost: z.number(),
    feasible: z.boolean(),
    occurredAt,
  }),
);

/**
 * `PlanAccepted` — the ONE operational side effect when a candidate plan is
 * committed (OPT-04). Carries only the identifiers + idempotency keys; the
 * objective/feasibility belong to the evaluation (`PlanGenerated`), not the
 * commit.
 */
export const planAcceptedSchema = eventSchema(
  "PlanAccepted",
  z.object({
    epochId: id,
    scopeHash: id,
    planId: id,
    trailerId: id,
    occurredAt,
  }),
);

/**
 * `PlanSuperseded` — the SOLE stage-mutating plan event (FLOW-04 / D-21-1). The
 * optimizer emits it in the SAME atomic append as the new `PlanAccepted` that
 * replaces the prior plan; the hub-inventory reducer stays a dumb pure
 * delete-then-apply over `supersededPackageIds`.
 *
 * D-21-1 (RESOLVED): the explicit event gives absolute determinism (state
 * depends only on stream facts), a clean audit trail (`priorPlanId` + `reason`),
 * and trivial replay-from-zero. The payload carries HOLISTIC scope state —
 * `supersededPackageIds` is every packageId the prior plan staged for this
 * scope — so items present in the OLD plan but absent in the NEW are wiped, not
 * stranded. Carries identifiers + clock only (no RNG; determinism keystone).
 */
export const planSupersededSchema = eventSchema(
  "PlanSuperseded",
  z.object({
    epochId: id,
    scopeHash: id,
    priorPlanId: id,
    trailerId: id,
    supersededPackageIds: z.array(id),
    reason: z.string().min(1),
    occurredAt,
  }),
);

// --- Phase-9 (v1.2) driver-lifecycle events (EVT-01) ------------------------

/**
 * `DriverRegistered` — a driver joined a hub's pool (the renewable-resource
 * roster). Carries identity, an optional human `name`/`licenseClass` (additive),
 * the `homeHubId` the driver is rostered at, and the virtual-clock `occurredAt`.
 * No RNG payload (determinism keystone): identifiers + clock only.
 */
export const driverRegisteredSchema = eventSchema(
  "DriverRegistered",
  z.object({
    driverId: id,
    name: z.string().min(1).optional(),
    licenseClass: z.string().min(1).optional(),
    homeHubId: id,
    occurredAt,
  }),
);

/**
 * `DriverAssignedToTrip` — a free driver was bound to a trip (on dispatch). The
 * single mutation that ties the renewable driver resource to a concrete trailer
 * movement; carries identifiers + clock only.
 */
export const driverAssignedToTripSchema = eventSchema(
  "DriverAssignedToTrip",
  z.object({
    driverId: id,
    tripId: id,
    trailerId: id,
    occurredAt,
  }),
);

/**
 * `DriverDutyStateChanged` — the driver moved between duty states (the panel
 * state machine). Carries the new `dutyStatus`, a human-meaningful `reason`
 * (e.g. "trip-dispatched", "30-min-break-due", "10h-reset"), and a SNAPSHOT of
 * the driver's {@link HosClock} at the transition (so the projection folds the
 * authoritative clock without recomputing it). All times are virtual-clock —
 * the clock fields and `occurredAt` come from the sim/epoch clock, no RNG.
 */
export const driverDutyStateChangedSchema = eventSchema(
  "DriverDutyStateChanged",
  z.object({
    driverId: id,
    dutyStatus: dutyStatusSchema,
    reason: z.string().min(1),
    clock: hosClockSchema,
    occurredAt,
  }),
);

/**
 * `DriverSwappedAtHub` — a relay handoff: a trip's trailer was reassigned from a
 * depleted `outgoingDriverId` to a fresh `incomingDriverId` from the hub pool
 * (the "fresh-driver swap" moment). Carries both driver ids, the hub, the trip,
 * the trailer, and the clock. Identifiers + clock only — no RNG.
 */
export const driverSwappedAtHubSchema = eventSchema(
  "DriverSwappedAtHub",
  z.object({
    outgoingDriverId: id,
    incomingDriverId: id,
    hubId: id,
    tripId: id,
    trailerId: id,
    occurredAt,
  }),
);

// --- Phase-9 (v1.2) authoritative load/unload phase events (EVT-02) ---------

/**
 * The shared payload for the three load/unload PHASE events: exactly
 * `{ trailerId, hubId, tripId, occurredAt }` — identifiers + virtual clock,
 * NOTHING else. This is the determinism keystone: phase events carry no RNG
 * value, so adding them never perturbs the seeded golden stream.
 */
const phaseEventPayload = z.object({
  trailerId: id,
  hubId: id,
  tripId: id,
  occurredAt,
});

/** `UnloadStarted` — unloading began at a hub (after `TrailerDocked`). */
export const unloadStartedSchema = eventSchema("UnloadStarted", phaseEventPayload);

/** `LoadStarted` — loading began at a hub (before `TrailerDeparted`). */
export const loadStartedSchema = eventSchema("LoadStarted", phaseEventPayload);

/** `UnloadCompleted` — unloading finished (after the last unload scan). */
export const unloadCompletedSchema = eventSchema(
  "UnloadCompleted",
  phaseEventPayload,
);

// --- SP2 visible rest/fuel stop events (spec §4) ----------------------------

/**
 * `TruckRested` — emitted ALONGSIDE the existing `DriverDutyStateChanged`
 * (`resting` 10-h | `on_break` 30-min) so the rest gains a MAP presence (the
 * trailer parks at a rest area). `reason` is a CLOSED two-value enum mapping the
 * HOS segment that triggered it; `durationMin` is that segment's whole minutes.
 *
 * DETERMINISM (spec §4): the payload carries NO lon/lat and NO RNG value — only
 * ids + the clock + the duration derived from the HOS segment. The stop's map
 * position is computed by the geo-track projection from the logged leg geometry,
 * never carried here. `durationMin` is a non-negative integer (a 0-minute or
 * negative rest is rejected at this boundary).
 */
export const truckRestedSchema = eventSchema(
  "TruckRested",
  z.object({
    trailerId: id,
    tripId: id,
    reason: z.enum(["rest-10h", "break-30min"]),
    durationMin: z.number().int().nonnegative(),
    occurredAt,
  }),
);

/**
 * `TruckRefueled` — emitted when a trailer's per-trailer odometer crosses the
 * `FuelConfig.refuelThresholdMiles` (the trailer visibly refuels mid-route).
 * `gallons` is the deterministic refilled amount from the tank model
 * (`min(odometerMiles / mpg, tankCapacityGallons)`, rounded); `odometerMiles` is
 * the cumulative miles AT the refuel (pre-reset); `durationMin` is the refuel
 * service time.
 *
 * DETERMINISM (spec §4): NO lon/lat and NO RNG in the payload — the geo-track
 * projection interpolates the refuel position from the logged leg geometry. All
 * numeric fields are non-negative (a NaN/Infinity or negative value is rejected
 * structurally at this boundary).
 */
export const truckRefueledSchema = eventSchema(
  "TruckRefueled",
  z.object({
    trailerId: id,
    tripId: id,
    gallons: z.number().nonnegative().finite(),
    odometerMiles: z.number().nonnegative().finite(),
    durationMin: z.number().int().nonnegative(),
    occurredAt,
  }),
);

// --- v2.0 external induction (IND-01) ---------------------------------------

/**
 * `PackageInducted` — freight enters the network FROM OUTSIDE at a spoke hub
 * (IND-01 / v2.0). This is the first network-visible entry of externally
 * originated freight; it COEXISTS with `PackageCreated` (internal center-origin
 * spawn), which is unchanged.
 *
 * DETERMINISM: `occurredAt` is the VIRTUAL clock ISO string (never `Date.now()`).
 * `slaDeadlineIso` is LOCKED at induction time (`occurredAt + expectedTravel
 * (inductionHub→center→destHub) + SLA-class buffer`) and never regenerated.
 * `externalOriginRef` is a deterministic counter id (e.g. `EXT-00001`). All
 * fields are simulation-generated; the optimizer reads inducted freight via the
 * `hub_inventory` projection's `inbound` bucket (Decision 3).
 */
export const packageInductedSchema = eventSchema(
  "PackageInducted",
  z.object({
    packageId: id,
    inductionHubId: id,
    destHubId: id,
    slaClass: slaClassSchema,
    slaDeadlineIso: z.string().min(1),
    externalOriginRef: id,
    occurredAt,
  }),
);

// --- Phase-22 outbound delivery (OUT-01) ------------------------------------

/**
 * `PackageDelivered` — the TERMINAL delivery event (OUT-01 / Phase 22). Freight
 * reaching its DESTINATION hub exits the network here, after a seeded outbound
 * dwell (>= 1 tick from arrival, D-22-2). It DELETE-purges the package from the
 * read-model projections (`packageLocation`, `hubInventory`, `zoneEstimate`),
 * completing the bounded-memory story (OUT-04).
 *
 * DETERMINISM: emitted ONLY when `outboundDeliveryEnabled === true`. `deliveredAt`
 * is the VIRTUAL clock ISO string canonicalized to whole minutes (never
 * `Date.now()`). `onTime = deliveredAt <= slaDeadlineIso` is computed at emit
 * (ISO-8601 lexicographic; D-22-5); center-origin freight without an induction
 * deadline is `onTime: true` by convention.
 */
export const packageDeliveredSchema = eventSchema(
  "PackageDelivered",
  z.object({
    packageId: id,
    hubId: id,
    deliveredAt: z.string().min(1),
    onTime: z.boolean(),
    occurredAt,
  }),
);

// --- Phase-24 OODA truck divert (OODA-01) -----------------------------------

/**
 * `TrailerDiverted` — the OODA truck agent's re-route decision (OODA-01 /
 * Phase 24). The ONE genuinely-new truck decision with no current centralized
 * analog: a truck agent, observing its frozen frame-N state, chooses to divert
 * from its planned next hub (`fromHubId`) to an alternate (`toHubId`) — e.g. the
 * next hub is congested/blocked, or a rebalance is warranted.
 *
 * ANTI-REPUDIATION (T-24-02): the payload carries `reason` + `tripId` + from/to
 * hub ids so every divert is replayable/auditable. `reason` is a CLOSED enum
 * matching the agent's `DivertReason`.
 *
 * DETERMINISM (DET-03): the payload is ids + a domain clock string ONLY — NO
 * lon/lat and NO RNG value (the geo-track projection computes any map position
 * from the logged route geometry). All ids are non-empty; the boundary rejects
 * empty ids, unknown reasons, and extra fields structurally.
 */
export const trailerDivertedSchema = eventSchema(
  "TrailerDiverted",
  z.object({
    trailerId: id,
    tripId: id,
    fromHubId: id,
    toHubId: id,
    reason: z.enum(["next-hub-congested", "next-hub-blocked", "rebalance"]),
    occurredAt,
  }),
);

// --- Phase-25 advisory coordination events (COORD-02) -----------------------

/**
 * `ActionSuggested` — an ADVISORY coordination suggestion emitted by a
 * regional-center coordinator (COORD-01/02 / Phase 25). It is NON-binding: the
 * target agent (the Phase-24 truck/hub OODA step) ACCEPTS it (→ a binding domain
 * event + `SuggestionAccepted`) or REJECTS it against its OWN local feasibility
 * verdict (→ `SuggestionRejected`). Streamed on `coordinator-<centerId>`.
 *
 * GUARD SUBSTRATE (COORD-04): the payload is RICH because the five anti-
 * oscillation guards need it — `suggestionId` (lease/pruning/TTL key),
 * `coordinatorId` (single-owner lease), `targetAgentId` (the advisee),
 * `kind` (the closed 4-option enum the reject-path-pruning cooldown keys on),
 * `params` (a small CLOSED option object per kind), `issuedAtSimMs`+`ttlSimMs`
 * (sim-time TTL self-destruct).
 *
 * DETERMINISM (Pitfall 1): ids + a CLOSED `kind` enum + an integer/string-only
 * `params` + sim-time INTEGER milliseconds ONLY — NO lon/lat float geometry and
 * NO RNG value in the payload. The boundary is `.strict()`, so an unknown field
 * (or a non-enum `kind`) is rejected; the hashed payload is pinned through
 * `canonicalizeSuggestionPayload` (simulation/src/coordinator/canonical.ts) so
 * key order never drifts the golden (Pitfall 7).
 */
export const actionSuggestedSchema = eventSchema(
  "ActionSuggested",
  z.object({
    suggestionId: id,
    coordinatorId: id,
    targetAgentId: id,
    kind: z.enum(["reroute", "hold", "consolidate", "dispatch"]),
    // A small CLOSED option object — integer/string only (Pitfall 1: no float
    // geometry, no RNG). `toHubId` carries a reroute/dispatch destination hub;
    // hold/consolidate carry an empty `{}`. `.strict()` rejects any other field.
    params: z.object({ toHubId: id.optional() }).strict(),
    issuedAtSimMs: z.number().int().nonnegative(),
    ttlSimMs: z.number().int().nonnegative(),
  }),
);

/**
 * `SuggestionAccepted` — the target agent ACCEPTED an `ActionSuggested`; the
 * agent then emits the corresponding binding domain event (e.g. a
 * `TrailerDiverted` for a `reroute`) in the SAME atomic in-fold step. Carries
 * only the `suggestionId` correlation key + the virtual-clock `occurredAt`.
 * Streamed on the target's own stream (`trailer-<id>` / `hub-<id>`). SCOPE-NEUTRAL.
 */
export const suggestionAcceptedSchema = eventSchema(
  "SuggestionAccepted",
  z.object({
    suggestionId: id,
    occurredAt,
  }),
);

/**
 * `SuggestionRejected` — the target agent DECLINED an `ActionSuggested` against
 * the binding local feasibility it alone knows (Phase 24). The `reasonCode` is a
 * CLOSED enum (`hos | fuel | dock | infeasible`) — the visible "won't divert:
 * HOS/fuel" demo moment surfaces from it (COORD-03, wired in Plan 03). Carries
 * the `suggestionId` correlation key + the virtual-clock `occurredAt`. Streamed
 * on the target's own stream. SCOPE-NEUTRAL — it must NOT re-trigger the
 * suggesting coordinator (anti-feedback-storm, Pitfall 11).
 */
export const suggestionRejectedSchema = eventSchema(
  "SuggestionRejected",
  z.object({
    suggestionId: id,
    reasonCode: z.enum(["hos", "fuel", "dock", "infeasible"]),
    occurredAt,
  }),
);

/**
 * The closed discriminated union, keyed on `type`. zod rejects any `type`
 * outside this list (unknown-event-type guard) and any payload that fails its
 * per-event schema.
 */
export const domainEventSchema = z.discriminatedUnion("type", [
  hubRegisteredSchema,
  routeRegisteredSchema,
  packageCreatedSchema,
  packageScannedSchema,
  packageArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerArrivedAtHubSchema,
  trailerDockedSchema,
  rfidObservedSchema,
  wrongTrailerDetectedSchema,
  missedUnloadDetectedSchema,
  planGeneratedSchema,
  planAcceptedSchema,
  // Phase-9 (v1.2) driver-lifecycle events (EVT-01).
  driverRegisteredSchema,
  driverAssignedToTripSchema,
  driverDutyStateChangedSchema,
  driverSwappedAtHubSchema,
  // Phase-9 (v1.2) load/unload phase events (EVT-02).
  unloadStartedSchema,
  loadStartedSchema,
  unloadCompletedSchema,
  // SP2 visible rest/fuel stop events (spec §4).
  truckRestedSchema,
  truckRefueledSchema,
  // v2.0 external induction (IND-01).
  packageInductedSchema,
  // Phase-21 bidirectional freight / consolidation (FLOW-04 / D-21-1).
  planSupersededSchema,
  // Phase-22 terminal delivery (OUT-01).
  packageDeliveredSchema,
  // Phase-24 OODA truck divert (OODA-01).
  trailerDivertedSchema,
  // Phase-25 advisory coordination events (COORD-02).
  actionSuggestedSchema,
  suggestionAcceptedSchema,
  suggestionRejectedSchema,
]);
