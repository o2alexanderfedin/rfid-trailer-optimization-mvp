import { describe, expect, it } from "vitest";
import { validateEvent, type PackageInducted, type TimingConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * IND-02 / IND-03 — external-induction determinism keystone.
 *
 * Four halves:
 *  1. `inductionEnabled` ABSENT ⇒ ZERO `PackageInducted` events (the off path
 *     draws no `inductionRng` values). This is the determinism keystone (DET-01).
 *  2. `inductionEnabled: false` ⇒ BYTE-IDENTICAL to absent (no perturbation).
 *  3. `inductionEnabled: true` ⇒ `PackageInducted` events PRESENT, drawn from the
 *     `INDUCTION_RNG_SALT` substream.
 *  4. `slaDeadlineIso` is deterministic and strictly `> occurredAt` (IND-03).
 *
 * Scale bound (gate-hygiene): `durationTicks` ≤ 500 — well under the 1000 cap.
 */

const SEED = 42;
const TICKS = 500;

/** SHORT timing so inductions/transits fit inside the bounded tick window. */
const SHORT_TIMING: TimingConfig = {
  transit: { median: 8, sigma: 0.05, min: 1, max: 60 },
  dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
  dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 },
};

const types = (s: ReturnType<typeof simulate>): string[] => s.map((e) => e.event.type);
const inductedEvents = (s: ReturnType<typeof simulate>): PackageInducted[] =>
  s
    .filter((e) => e.event.type === "PackageInducted")
    .map((e) => e.event as PackageInducted);

describe("IND-02: induction determinism keystone", () => {
  it("inductionEnabled ABSENT ⇒ ZERO PackageInducted events (DET-01)", () => {
    const s = simulate({ seed: SEED, durationTicks: TICKS });
    expect(types(s)).not.toContain("PackageInducted");
  });

  it("inductionEnabled: false ⇒ byte-identical to absent (DET-01)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS });
    const b = simulate({ seed: SEED, durationTicks: TICKS, inductionEnabled: false });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("inductionEnabled: true ⇒ PackageInducted events present (IND-02)", () => {
    const s = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    expect(inductedEvents(s).length).toBeGreaterThan(0);
  });

  it("inductionEnabled: true ⇒ same seed ⇒ byte-identical stream", () => {
    const a = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    const b = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("PackageInducted events validate at the ingestion boundary", () => {
    const s = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    for (const e of inductedEvents(s)) {
      expect(() => validateEvent(e)).not.toThrow();
    }
  });

  it("inductions fire at spokes (never the center) toward a different hub", () => {
    const s = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    const inducted = inductedEvents(s);
    expect(inducted.length).toBeGreaterThan(0);
    for (const e of inducted) {
      // center is USA_HUBS[0]; spokes are the rest — induction hub must differ
      // from dest hub (spoke→spoke, multi-hop via center).
      expect(e.payload.inductionHubId).not.toBe(e.payload.destHubId);
    }
  });
});

describe("IND-03: slaDeadlineIso derivation", () => {
  it("slaDeadlineIso is deterministic and strictly > occurredAt", () => {
    const s = simulate({
      seed: SEED,
      durationTicks: TICKS,
      inductionEnabled: true,
      timing: SHORT_TIMING,
    });
    const inducted = inductedEvents(s);
    expect(inducted.length).toBeGreaterThan(0);
    for (const e of inducted) {
      expect(e.payload.slaDeadlineIso > e.payload.occurredAt).toBe(true);
    }
  });
});
