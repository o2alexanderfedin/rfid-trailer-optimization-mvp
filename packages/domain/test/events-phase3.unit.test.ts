import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertNever,
  type DomainEvent,
  type DomainEventType,
  type MissedUnloadDetected,
  type PackageCreated,
  type RfidObserved,
  type WrongTrailerDetected,
  missedUnloadDetectedSchema,
  rfidObservedSchema,
  validateEvent,
  ValidationError,
  wrongTrailerDetectedSchema,
} from "../src/index.js";

/**
 * Phase-3 (SNS-01, SNS-02) — RED first.
 *
 * Extends the CLOSED `DomainEvent` union with the three RFID-assisted-validation
 * events and adds the optional `rfidTagId` to PackageCreated (the tag→package
 * mapping source, SNS-02). These tests assert:
 *
 *  - the three new events validate through `validateEvent` and round-trip,
 *  - the ingestion boundary rejects out-of-range `confidence`, non-finite `rssi`,
 *    bad `severity`, and (strict) extra fields,
 *  - `PackageCreated` validates WITH and WITHOUT `rfidTagId` (additive — Phase
 *    1/2 streams unaffected),
 *  - the new types are exhaustively handled in a `switch` over `DomainEvent`
 *    (closed-union guarantee mirrored at the test layer).
 */

// --- Canonical valid fixtures ----------------------------------------------

const rfidObserved: RfidObserved = {
  type: "RfidObserved",
  schemaVersion: 1,
  payload: {
    tagId: "TAG-1",
    readerId: "READER-1",
    antennaId: "ANT-1",
    rssi: -55,
    trailerId: "T1",
    hubId: "MEM",
    confidence: 0.72,
  },
};

const wrongTrailerDetected: WrongTrailerDetected = {
  type: "WrongTrailerDetected",
  schemaVersion: 1,
  payload: {
    packageId: "P1",
    observedTrailerId: "T2",
    plannedTrailerId: "T1",
    confidence: 0.81,
    severity: "critical",
    recommendedAction: "reroute-to-T1",
  },
};

const missedUnloadDetected: MissedUnloadDetected = {
  type: "MissedUnloadDetected",
  schemaVersion: 1,
  payload: {
    packageId: "P1",
    trailerId: "T1",
    hubId: "ORD",
    confidence: 0.66,
    severity: "warning",
    recommendedAction: "unload-at-ORD",
  },
};

const PHASE3_EVENTS: readonly DomainEvent[] = [
  rfidObserved,
  wrongTrailerDetected,
  missedUnloadDetected,
];

/**
 * Closed-union exhaustiveness at the test layer: only the three Phase-3 members
 * are handled; the `default` is `assertNever`, so this dispatch over the new
 * variants stays type-safe.
 */
function describePhase3Event(e: DomainEvent): string {
  switch (e.type) {
    case "RfidObserved":
      return e.payload.tagId;
    case "WrongTrailerDetected":
      return e.payload.packageId;
    case "MissedUnloadDetected":
      return e.payload.packageId;
    default:
      // Non-Phase-3 events are out of scope for this dispatcher.
      return "";
  }
}

describe("Phase-3 events validate + round-trip (SNS-01)", () => {
  it.each(PHASE3_EVENTS.map((e) => [e.type, e] as const))(
    "accepts a valid %s and round-trips it deep-equal",
    (_type, event) => {
      const parsed = validateEvent(event);
      expect(parsed).toEqual(event);
    },
  );

  it("each Phase-3 event is statically typed as DomainEvent", () => {
    expectTypeOf(rfidObserved).toMatchTypeOf<DomainEvent>();
    expectTypeOf(wrongTrailerDetected).toMatchTypeOf<DomainEvent>();
    expectTypeOf(missedUnloadDetected).toMatchTypeOf<DomainEvent>();
  });

  it("narrows RfidObserved by discriminator (no `any`)", () => {
    const parsed = validateEvent(rfidObserved);
    if (parsed.type === "RfidObserved") {
      expectTypeOf(parsed.payload.rssi).toEqualTypeOf<number>();
      expectTypeOf(parsed.payload.confidence).toEqualTypeOf<number>();
      expect(parsed.payload.tagId).toBe("TAG-1");
    }
  });

  it("DomainEventType includes the three Phase-3 discriminators", () => {
    const types = new Set<DomainEventType>(PHASE3_EVENTS.map((e) => e.type));
    expect(types).toEqual(
      new Set<DomainEventType>([
        "RfidObserved",
        "WrongTrailerDetected",
        "MissedUnloadDetected",
      ]),
    );
  });

  it("exhaustive switch dispatches every Phase-3 member", () => {
    expect(PHASE3_EVENTS.map(describePhase3Event)).toEqual(["TAG-1", "P1", "P1"]);
    // Guard fires on an out-of-union value (proves assertNever is reachable).
    expect(() => assertNever({ type: "Nope" } as never)).toThrow();
  });
});

describe("RfidObserved — ingestion boundary rejects bad evidence (T-03-01)", () => {
  it("rejects confidence < 0", () => {
    expect(() =>
      validateEvent({
        ...rfidObserved,
        payload: { ...rfidObserved.payload, confidence: -0.01 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects confidence > 1 (no overconfident lock-on past the union boundary)", () => {
    expect(() =>
      validateEvent({
        ...rfidObserved,
        payload: { ...rfidObserved.payload, confidence: 1.0001 },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts confidence at the [0,1] endpoints", () => {
    for (const confidence of [0, 1]) {
      expect(() =>
        validateEvent({
          ...rfidObserved,
          payload: { ...rfidObserved.payload, confidence },
        }),
      ).not.toThrow();
    }
  });

  it("rejects a non-finite rssi (NaN / Infinity)", () => {
    for (const rssi of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        validateEvent({
          ...rfidObserved,
          payload: { ...rfidObserved.payload, rssi },
        }),
      ).toThrow(ValidationError);
    }
  });

  it("rejects an extra field — strict payload", () => {
    expect(() =>
      validateEvent({
        ...rfidObserved,
        payload: { ...rfidObserved.payload, surprise: "boom" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an empty tagId (non-empty id constraint)", () => {
    expect(() =>
      validateEvent({
        ...rfidObserved,
        payload: { ...rfidObserved.payload, tagId: "" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("WrongTrailerDetected / MissedUnloadDetected — severity + action", () => {
  it("rejects a severity outside the {info,warning,critical} enum", () => {
    expect(() =>
      validateEvent({
        ...wrongTrailerDetected,
        payload: { ...wrongTrailerDetected.payload, severity: "fatal" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({
        ...missedUnloadDetected,
        payload: { ...missedUnloadDetected.payload, severity: "fatal" },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts each allowed severity", () => {
    for (const severity of ["info", "warning", "critical"] as const) {
      expect(() =>
        validateEvent({
          ...wrongTrailerDetected,
          payload: { ...wrongTrailerDetected.payload, severity },
        }),
      ).not.toThrow();
    }
  });

  it("rejects an empty recommendedAction (non-empty string)", () => {
    expect(() =>
      validateEvent({
        ...missedUnloadDetected,
        payload: { ...missedUnloadDetected.payload, recommendedAction: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects confidence out of [0,1] for both detection events", () => {
    expect(() =>
      validateEvent({
        ...wrongTrailerDetected,
        payload: { ...wrongTrailerDetected.payload, confidence: 2 },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({
        ...missedUnloadDetected,
        payload: { ...missedUnloadDetected.payload, confidence: -1 },
      }),
    ).toThrow(ValidationError);
  });
});

describe("PackageCreated.rfidTagId is optional + additive (SNS-02)", () => {
  const base: PackageCreated["payload"] = {
    packageId: "P1",
    originHubId: "MEM",
    destHubId: "ORD",
    sizeClass: "medium",
    weight: 4.2,
  };

  it("accepts a PackageCreated WITHOUT rfidTagId (Phase 1/2 stream unaffected)", () => {
    const parsed = validateEvent({
      type: "PackageCreated",
      schemaVersion: 1,
      payload: base,
    });
    expect(parsed.type).toBe("PackageCreated");
    if (parsed.type === "PackageCreated") {
      expect(parsed.payload.rfidTagId).toBeUndefined();
    }
  });

  it("accepts a PackageCreated WITH rfidTagId (tag→package mapping source)", () => {
    const parsed = validateEvent({
      type: "PackageCreated",
      schemaVersion: 1,
      payload: { ...base, rfidTagId: "TAG-1" },
    });
    if (parsed.type === "PackageCreated") {
      expect(parsed.payload.rfidTagId).toBe("TAG-1");
      expectTypeOf(parsed.payload.rfidTagId).toEqualTypeOf<string | undefined>();
    }
  });

  it("rejects an empty rfidTagId when present (non-empty id)", () => {
    expect(() =>
      validateEvent({
        type: "PackageCreated",
        schemaVersion: 1,
        payload: { ...base, rfidTagId: "" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("the new schemas are exported and parse standalone", () => {
  it("rfidObservedSchema / wrongTrailerDetectedSchema / missedUnloadDetectedSchema accept their fixtures", () => {
    expect(rfidObservedSchema.safeParse(rfidObserved).success).toBe(true);
    expect(wrongTrailerDetectedSchema.safeParse(wrongTrailerDetected).success).toBe(
      true,
    );
    expect(
      missedUnloadDetectedSchema.safeParse(missedUnloadDetected).success,
    ).toBe(true);
  });
});
