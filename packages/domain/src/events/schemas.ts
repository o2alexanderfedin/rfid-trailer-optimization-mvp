import { z } from "zod";
import {
  hubSchema,
  lonLatSchema,
  sizeClassSchema,
} from "../entities/index.js";

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

/** The current schema version for every Phase-1 event. */
export const PHASE1_SCHEMA_VERSION = 1 as const;
const schemaVersion = z.literal(PHASE1_SCHEMA_VERSION);

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
]);
