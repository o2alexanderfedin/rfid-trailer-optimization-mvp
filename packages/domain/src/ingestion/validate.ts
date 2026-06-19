import type { z } from "zod";
import type { DomainEvent } from "../events/domain-event.js";
import { domainEventSchema } from "../events/schemas.js";

/**
 * The typed ingestion boundary (FND-03). `validateEvent` is the single choke
 * point where arbitrary `unknown` input crosses into the typed domain
 * (trust boundary: ingestion -> domain).
 *
 * Threat mitigations baked in here:
 *  - T-01-05 (Tampering): a zod discriminated-union parse rejects malformed
 *    payloads, wrong types, extra keys, and unknown event types BEFORE they can
 *    reach the store.
 *  - T-01-06 (schema drift): each event's `schemaVersion` is a literal, so an
 *    unsupported version is rejected, never silently coerced (P11).
 *
 * Failures throw a `ValidationError` with a descriptive, field-naming message,
 * so callers (and logs) can see exactly what was rejected.
 */

/** Thrown when an unknown payload fails validation at the ingestion boundary. */
export class ValidationError extends Error {
  /** The underlying zod issues, for programmatic inspection. */
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(ValidationError.format(issues));
    this.name = "ValidationError";
    this.issues = issues;
    // Restore prototype chain across the transpiled `extends Error` boundary.
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  /** Human-readable, field-pathed summary: `payload.hubId: <message>; ...`. */
  private static format(issues: readonly z.core.$ZodIssue[]): string {
    const detail = issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return `Invalid domain event: ${detail}`;
  }
}

/**
 * Parse an unknown value into a typed `DomainEvent`, or throw `ValidationError`.
 * This is THE function every ingress path (API, simulator, store) must call
 * before persisting an event.
 */
export function validateEvent(input: unknown): DomainEvent {
  const result = domainEventSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}
