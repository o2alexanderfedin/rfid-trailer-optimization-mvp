import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  packageDeliveredSchema,
  validateEvent,
  type PackageDelivered,
} from "../src/index.js";

/**
 * OUT-01 — `PackageDelivered` closed-union ceremony.
 *
 * Proves a well-formed `PackageDelivered` round-trips through the `validateEvent`
 * ingestion boundary (the closed discriminated union accepts it) and that the
 * inferred type is structurally what the engine emits.
 */

function buildWellFormedPackageDelivered(): PackageDelivered {
  return {
    type: "PackageDelivered",
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: {
      packageId: "EXT-P00001",
      hubId: "hub-spoke-b",
      deliveredAt: "2026-06-24T12:34:00.000Z",
      onTime: true,
      occurredAt: "2026-06-24T12:34:00.000Z",
    },
  };
}

describe("PackageDelivered (OUT-01)", () => {
  it("round-trips a well-formed event through validateEvent()", () => {
    const event = buildWellFormedPackageDelivered();
    const parsed = validateEvent(event);
    expect(parsed.type).toBe("PackageDelivered");
    expect(parsed).toEqual(event);
  });

  it("packageDeliveredSchema accepts the well-formed event", () => {
    const result = packageDeliveredSchema.safeParse(
      buildWellFormedPackageDelivered(),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an extra/unknown payload field (.strict() boundary)", () => {
    const bad = {
      ...buildWellFormedPackageDelivered(),
      payload: {
        ...buildWellFormedPackageDelivered().payload,
        sneakyExtra: "nope",
      },
    };
    expect(() => validateEvent(bad)).toThrow();
  });
});
