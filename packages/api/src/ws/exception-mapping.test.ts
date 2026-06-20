/**
 * Unit tests for the projection→wire exception mappers (F-01).
 *
 * The websocket exception feed must TRANSLATE the projection's exception
 * vocabulary onto the wire/envelope vocabulary, not blind-cast it:
 *   - kind:     "wrong-trailer" → "wrongTrailer", "missed-unload" → "missedUnload"
 *   - severity: "info" → "low", "warning" → "med", "critical" → "high"
 *
 * Without this translation the frontend `AlertFeed.kindLabel` map renders a
 * blank label and `severityClass` produces a non-existent CSS class for the
 * exceptions the live sim actually fires (UI-01 broken).
 */

import { describe, expect, it } from "vitest";
import type { ExceptionKind } from "@mm/projections";
import type { Severity } from "@mm/domain";
import type { ExceptionItem } from "./envelope.js";
import {
  exceptionKindToWire,
  exceptionSeverityToWire,
} from "./snapshots.js";

describe("exceptionKindToWire", () => {
  it("maps 'wrong-trailer' → 'wrongTrailer'", () => {
    expect(exceptionKindToWire("wrong-trailer")).toBe("wrongTrailer");
  });

  it("maps 'missed-unload' → 'missedUnload'", () => {
    expect(exceptionKindToWire("missed-unload")).toBe("missedUnload");
  });

  it("covers every projection ExceptionKind member", () => {
    // Exhaustive: every member of the closed union maps to a wire literal.
    const allKinds: readonly ExceptionKind[] = ["wrong-trailer", "missed-unload"];
    const expected: Record<ExceptionKind, ExceptionItem["kind"]> = {
      "wrong-trailer": "wrongTrailer",
      "missed-unload": "missedUnload",
    };
    for (const k of allKinds) {
      expect(exceptionKindToWire(k)).toBe(expected[k]);
    }
  });
});

describe("exceptionSeverityToWire", () => {
  it("maps 'info' → 'low'", () => {
    expect(exceptionSeverityToWire("info")).toBe("low");
  });

  it("maps 'warning' → 'med'", () => {
    expect(exceptionSeverityToWire("warning")).toBe("med");
  });

  it("maps 'critical' → 'high'", () => {
    expect(exceptionSeverityToWire("critical")).toBe("high");
  });

  it("covers every projection Severity member", () => {
    const allSeverities: readonly Severity[] = ["info", "warning", "critical"];
    const expected: Record<Severity, ExceptionItem["severity"]> = {
      info: "low",
      warning: "med",
      critical: "high",
    };
    for (const s of allSeverities) {
      expect(exceptionSeverityToWire(s)).toBe(expected[s]);
    }
  });
});

describe("combined projection-exception → wire ExceptionItem mapping", () => {
  it("{kind:'wrong-trailer', severity:'warning'} → {kind:'wrongTrailer', severity:'med'}", () => {
    expect(exceptionKindToWire("wrong-trailer")).toBe("wrongTrailer");
    expect(exceptionSeverityToWire("warning")).toBe("med");
  });

  it("{kind:'missed-unload', severity:'critical'} → {kind:'missedUnload', severity:'high'}", () => {
    expect(exceptionKindToWire("missed-unload")).toBe("missedUnload");
    expect(exceptionSeverityToWire("critical")).toBe("high");
  });
});
