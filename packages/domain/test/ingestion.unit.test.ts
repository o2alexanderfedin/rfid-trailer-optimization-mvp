import type { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DomainEvent,
  domainEventSchema,
  parseDomainEvent,
  validateEvent,
  ValidationError,
} from "../src/index.js";

/** Compile-time proof the zod schema infers exactly the hand-written union. */
type InferredDomainEvent = z.infer<typeof domainEventSchema>;

/**
 * Task 2 (RED first): the zod-validated typed ingestion boundary (FND-03).
 *
 * `validateEvent(unknown): DomainEvent` is the single choke point where
 * arbitrary input crosses into the typed domain. Valid payloads round-trip and
 * are typed; invalid / unknown-type / unsupported-version payloads throw a
 * descriptive `ValidationError`.
 */

const VALID_EVENTS: readonly DomainEvent[] = [
  {
    type: "HubRegistered",
    schemaVersion: 1,
    payload: { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  },
  {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: {
      routeId: "R1",
      fromHubId: "MEM",
      toHubId: "ORD",
      geometry: [
        [-90.049, 35.1495],
        [-87.6298, 41.8781],
      ],
    },
  },
  {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId: "P1",
      originHubId: "MEM",
      destHubId: "ORD",
      sizeClass: "medium",
      weight: 4.2,
    },
  },
  {
    type: "PackageScanned",
    schemaVersion: 1,
    payload: { packageId: "P1", hubId: "MEM", scanType: "inbound" },
  },
  {
    type: "PackageArrivedAtHub",
    schemaVersion: 1,
    payload: { packageId: "P1", hubId: "ORD" },
  },
  {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: {
      trailerId: "T1",
      fromHubId: "MEM",
      toHubId: "ORD",
      tripId: "TRIP-1",
      packageIds: ["P1", "P2"],
    },
  },
  {
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId: "T1", hubId: "ORD", tripId: "TRIP-1" },
  },
  {
    type: "TrailerDocked",
    schemaVersion: 1,
    payload: { trailerId: "T1", hubId: "ORD", dockDoorId: "DOCK-12" },
  },
];

describe("validateEvent — happy path (FND-03)", () => {
  it.each(VALID_EVENTS.map((e) => [e.type, e] as const))(
    "accepts a valid %s and round-trips it deep-equal",
    (_type, event) => {
      const parsed = validateEvent(event);
      expect(parsed).toEqual(event);
    },
  );

  it("returns a value statically typed as DomainEvent", () => {
    const parsed = validateEvent(VALID_EVENTS[0]);
    expectTypeOf(parsed).toEqualTypeOf<DomainEvent>();
  });

  it("narrows by discriminator after validation (no `any`)", () => {
    const parsed = validateEvent({
      type: "PackageScanned",
      schemaVersion: 1,
      payload: { packageId: "P9", hubId: "MEM", scanType: "load" },
    });
    if (parsed.type === "PackageScanned") {
      expectTypeOf(parsed.payload.scanType).toEqualTypeOf<
        "inbound" | "outbound" | "load" | "unload"
      >();
      expect(parsed.payload.packageId).toBe("P9");
    }
  });
});

describe("validateEvent — rejects malformed input (T-01-05 Tampering)", () => {
  it("throws ValidationError for a missing required field, naming it", () => {
    let caught: unknown;
    try {
      validateEvent({
        type: "HubRegistered",
        schemaVersion: 1,
        payload: { name: "Memphis", lat: 1, lon: 2 }, // hubId missing
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/hubId/);
  });

  it("throws for a wrong-typed field (lat as string)", () => {
    expect(() =>
      validateEvent({
        type: "HubRegistered",
        schemaVersion: 1,
        payload: { hubId: "MEM", name: "Memphis", lat: "35.1", lon: -90 },
      }),
    ).toThrow(ValidationError);
  });

  it("throws for an out-of-range latitude (>90)", () => {
    expect(() =>
      validateEvent({
        type: "HubRegistered",
        schemaVersion: 1,
        payload: { hubId: "MEM", name: "Memphis", lat: 999, lon: 0 },
      }),
    ).toThrow(ValidationError);
  });

  it("throws for an extra (unrecognized) field — strict payloads", () => {
    expect(() =>
      validateEvent({
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId: "P1", hubId: "ORD", surprise: "boom" },
      }),
    ).toThrow(ValidationError);
  });

  it("throws for an unknown event type (closed union, no pass-through)", () => {
    expect(() =>
      validateEvent({ type: "SomethingElse", schemaVersion: 1, payload: {} }),
    ).toThrow(ValidationError);
  });

  it("throws for a non-object input", () => {
    expect(() => validateEvent(null)).toThrow(ValidationError);
    expect(() => validateEvent("not-an-event")).toThrow(ValidationError);
    expect(() => validateEvent(42)).toThrow(ValidationError);
  });
});

describe("validateEvent — schemaVersion tolerance (T-01-06, P11)", () => {
  it("accepts a recognized schemaVersion (1)", () => {
    expect(() =>
      validateEvent({
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId: "P1", hubId: "ORD" },
      }),
    ).not.toThrow();
  });

  it("rejects an unsupported schemaVersion — not silently coerced", () => {
    let caught: unknown;
    try {
      validateEvent({
        type: "PackageArrivedAtHub",
        schemaVersion: 2, // unknown future version — must be rejected, not read
        payload: { packageId: "P1", hubId: "ORD" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/schemaVersion|version/i);
  });

  it("rejects a missing schemaVersion", () => {
    expect(() =>
      validateEvent({
        type: "PackageArrivedAtHub",
        payload: { packageId: "P1", hubId: "ORD" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("validateEvent / parseDomainEvent / domainEventSchema agree", () => {
  it("validateEvent is the named ingestion boundary and equals parseDomainEvent", () => {
    const input = VALID_EVENTS[2];
    expect(validateEvent(input)).toEqual(parseDomainEvent(input));
  });

  it("the exported zod schema infers exactly the DomainEvent union (type-equality)", () => {
    // Compile-time proof the hand-written union and the zod schema agree.
    expectTypeOf<InferredDomainEvent>().toEqualTypeOf<DomainEvent>();
    // Runtime use of the schema value: it accepts a valid event and is the
    // same closed contract the boundary parses through.
    expect(domainEventSchema.safeParse(VALID_EVENTS[0]).success).toBe(true);
  });
});
