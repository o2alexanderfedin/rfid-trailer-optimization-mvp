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
  planGeneratedSchema,
  planAcceptedSchema,
]);
