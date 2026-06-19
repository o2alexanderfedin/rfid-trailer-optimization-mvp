import type { z } from "zod";
import type {
  hubRegisteredSchema,
  missedUnloadDetectedSchema,
  packageArrivedAtHubSchema,
  packageCreatedSchema,
  packageScannedSchema,
  rfidObservedSchema,
  routeRegisteredSchema,
  severitySchema,
  trailerArrivedAtHubSchema,
  trailerDepartedSchema,
  trailerDockedSchema,
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
  | MissedUnloadDetected;

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
