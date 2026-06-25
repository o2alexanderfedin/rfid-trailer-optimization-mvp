import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  packageInductedSchema,
  validateEvent,
  type PackageInducted,
} from "../src/index.js";

/**
 * IND-01 — `PackageInducted` closed-union ceremony.
 *
 * Proves a well-formed `PackageInducted` round-trips through the `validateEvent`
 * ingestion boundary (the closed discriminated union accepts it) and that the
 * inferred type is structurally what the engine emits.
 */

function buildWellFormedPackageInducted(): PackageInducted {
  return {
    type: "PackageInducted",
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: {
      packageId: "EXT-P00001",
      inductionHubId: "hub-spoke-a",
      destHubId: "hub-spoke-b",
      slaClass: "express",
      slaDeadlineIso: "2026-06-24T12:34:00.000Z",
      externalOriginRef: "EXT-00001",
      occurredAt: "2026-06-24T08:00:00.000Z",
    },
  };
}

describe("PackageInducted (IND-01)", () => {
  it("round-trips a well-formed event through validateEvent()", () => {
    const event = buildWellFormedPackageInducted();
    const parsed = validateEvent(event);
    expect(parsed.type).toBe("PackageInducted");
    expect(parsed).toEqual(event);
  });

  it("packageInductedSchema accepts the well-formed event", () => {
    const result = packageInductedSchema.safeParse(
      buildWellFormedPackageInducted(),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an extra/unknown payload field (.strict() boundary)", () => {
    const bad = {
      ...buildWellFormedPackageInducted(),
      payload: {
        ...buildWellFormedPackageInducted().payload,
        sneakyExtra: "nope",
      },
    };
    expect(() => validateEvent(bad)).toThrow();
  });
});
