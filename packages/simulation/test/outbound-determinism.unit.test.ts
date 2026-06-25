import { describe, expect, it } from "vitest";
import {
  validateEvent,
  type PackageArrivedAtHub,
  type PackageDelivered,
  type TimingConfig,
} from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * OUT-01 / OUT-02 / OUT-03 — outbound-delivery determinism keystone.
 *
 * Seven behaviors (all RED until Plan 03 wires the engine):
 *  1. `outboundDeliveryEnabled` ABSENT ⇒ ZERO `PackageDelivered` events (the off
 *     path draws no `outboundRng` values). The determinism keystone (DET-01).
 *  2. `outboundDeliveryEnabled: false` ⇒ BYTE-IDENTICAL to absent (no perturbation).
 *  3. `outboundDeliveryEnabled: true` (+ induction) ⇒ at least one
 *     `PackageDelivered` fires within the bounded horizon.
 *  4. Lifecycle-ordering: every `PackageDelivered` follows a `PackageArrivedAtHub`
 *     for the same packageId at a strictly earlier tick (D-22-2).
 *  5. Terminal-completeness: every package that arrives at a hub eventually
 *     reaches `PackageDelivered` within the horizon.
 *  6. `onTime` is a boolean on every `PackageDelivered` payload (D-22-5).
 *  7. `deliveredAt` is whole-minute ISO (no sub-minute residue) (D-22-5).
 *
 * Scale bound (gate-hygiene): `durationTicks` ≤ 800.
 */

const SEED = 42;
const TICKS = 500;

/** SHORT timing so inductions/transits/deliveries fit inside the bounded window. */
const SHORT_TIMING: TimingConfig = {
  transit: { median: 8, sigma: 0.05, min: 1, max: 60 },
  dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
  dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 },
};

const ON_OPTS = {
  seed: SEED,
  durationTicks: TICKS,
  outboundDeliveryEnabled: true,
  inductionEnabled: true,
  timing: SHORT_TIMING,
} as const;

const types = (s: ReturnType<typeof simulate>): string[] =>
  s.map((e) => e.event.type);

const deliveredEvents = (s: ReturnType<typeof simulate>): PackageDelivered[] =>
  s
    .filter((e) => e.event.type === "PackageDelivered")
    .map((e) => e.event as PackageDelivered);

const arrivedEvents = (
  s: ReturnType<typeof simulate>,
): PackageArrivedAtHub[] =>
  s
    .filter((e) => e.event.type === "PackageArrivedAtHub")
    .map((e) => e.event as PackageArrivedAtHub);

describe("OUT-02: outbound determinism keystone (flag-off)", () => {
  it("outboundDeliveryEnabled ABSENT ⇒ ZERO PackageDelivered events (DET-01)", () => {
    const s = simulate({ seed: SEED, durationTicks: TICKS });
    expect(types(s)).not.toContain("PackageDelivered");
  });

  it("outboundDeliveryEnabled: false ⇒ byte-identical to absent (DET-01)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS });
    const b = simulate({
      seed: SEED,
      durationTicks: TICKS,
      outboundDeliveryEnabled: false,
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("OUT-02 / OUT-03: outbound delivery (flag-on)", () => {
  it("outboundDeliveryEnabled: true ⇒ at least one PackageDelivered within the horizon", () => {
    const s = simulate({ ...ON_OPTS });
    expect(deliveredEvents(s).length).toBeGreaterThan(0);
  });

  it("lifecycle-ordering: every PackageDelivered follows a PackageArrivedAtHub for the same packageId at an earlier index", () => {
    const s = simulate({ ...ON_OPTS });
    const delivered = deliveredEvents(s);
    expect(delivered.length).toBeGreaterThan(0);
    for (let i = 0; i < s.length; i += 1) {
      const e = s[i];
      if (e === undefined || e.event.type !== "PackageDelivered") continue;
      const packageId = (e.event as PackageDelivered).payload.packageId;
      // There must be an earlier PackageArrivedAtHub for the SAME packageId.
      const priorArrival = s
        .slice(0, i)
        .some(
          (p) =>
            p.event.type === "PackageArrivedAtHub" &&
            (p.event as PackageArrivedAtHub).payload.packageId === packageId,
        );
      expect(priorArrival).toBe(true);
    }
  });

  it("terminal-completeness: every package that arrives at a hub eventually reaches PackageDelivered", () => {
    const s = simulate({ ...ON_OPTS });
    const arrivedIds = new Set(arrivedEvents(s).map((e) => e.payload.packageId));
    const deliveredIds = new Set(
      deliveredEvents(s).map((e) => e.payload.packageId),
    );
    expect(arrivedIds.size).toBeGreaterThan(0);
    for (const id of arrivedIds) {
      expect(deliveredIds.has(id)).toBe(true);
    }
  });

  it("onTime is a boolean on every PackageDelivered payload (D-22-5)", () => {
    const s = simulate({ ...ON_OPTS });
    const delivered = deliveredEvents(s);
    expect(delivered.length).toBeGreaterThan(0);
    for (const e of delivered) {
      expect(typeof e.payload.onTime).toBe("boolean");
    }
  });

  it("deliveredAt is whole-minute ISO (no sub-minute residue) (D-22-5)", () => {
    const s = simulate({ ...ON_OPTS });
    const delivered = deliveredEvents(s);
    expect(delivered.length).toBeGreaterThan(0);
    for (const e of delivered) {
      expect(e.payload.deliveredAt).toMatch(/T\d{2}:\d{2}:00\.000Z$/);
    }
  });

  it("PackageDelivered events validate at the ingestion boundary", () => {
    const s = simulate({ ...ON_OPTS });
    for (const e of deliveredEvents(s)) {
      expect(() => validateEvent(e)).not.toThrow();
    }
  });
});
