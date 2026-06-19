import { z } from "zod";
import { hubSchema } from "./hub.js";

/**
 * Domain events are an append-only, versioned discriminated union.
 *
 * Discipline (PITFALLS P3/P11):
 *  - Every event carries `schemaVersion` so reducers can tolerate evolution.
 *  - Payloads carry their own data only; no ambient time/randomness. The
 *    authoritative timestamp is `occurred_at`, recorded by the event store at
 *    the persistence boundary (NOT inside the reducer).
 *
 * Phase 1 ships exactly one event: `HubRegistered`. Later phases extend this
 * union; the event-store/projection machinery is event-agnostic.
 */

export const hubRegisteredSchema = z.object({
  type: z.literal("HubRegistered"),
  schemaVersion: z.literal(1),
  payload: hubSchema,
});

export type HubRegistered = z.infer<typeof hubRegisteredSchema>;

/** Discriminated union of all domain events. */
export const domainEventSchema = z.discriminatedUnion("type", [hubRegisteredSchema]);

export type DomainEvent = z.infer<typeof domainEventSchema>;

/** Event `type` literal, useful for exhaustive switches in reducers. */
export type DomainEventType = DomainEvent["type"];

/**
 * Parse an unknown value into a typed DomainEvent at the ingestion boundary
 * (FND-03). Throws a ZodError on invalid payloads.
 */
export function parseDomainEvent(input: unknown): DomainEvent {
  return domainEventSchema.parse(input);
}
