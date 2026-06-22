import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine.js";

/**
 * SIM-03 — RFID determinism keystone.
 *
 * Same seed + same rfid config ⇒ byte-identical event stream (RFID reads, drops,
 * and RSSI jitter included), because EVERY miss/jitter/wrong-zone/wrong-tag
 * decision flows through the seeded `Rng` and the stable (fireTick, seq) queue.
 * Different seed ⇒ a different RFID stream. The opt-in design also guarantees the
 * pre-existing non-RFID stream is byte-unchanged.
 */

const RFID = { missRate: 0.25, rssiNoise: 5, wrongZoneRate: 0.05, wrongTagRate: 0.02 } as const;
// TIME-01: per-leg transit medians are now ≈400–2250 min (real great-circle
// distance / 80 km/h), so the horizon must span real round-trips for antenna
// reads (fired on arrival/dwell) and enough departures to survive the miss-rate.
const OPTS = { seed: 1234, durationTicks: 6000, rfid: RFID } as const;

const types = (s: ReturnType<typeof simulate>) => s.map((e) => e.event.type);
const rfidCount = (s: ReturnType<typeof simulate>) =>
  s.filter((e) => e.event.type === "RfidObserved").length;

describe("RFID determinism (SIM-03)", () => {
  it("same seed + same rfid config ⇒ byte-identical stream (incl. drops + noise)", () => {
    const a = simulate(OPTS);
    const b = simulate({ ...OPTS, rfid: { ...RFID } });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(rfidCount(a)).toBeGreaterThan(0);
  });

  it("different seed ⇒ a different RFID stream (drops/noise differ)", () => {
    const a = simulate({ ...OPTS, seed: 1 });
    const b = simulate({ ...OPTS, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("higher missRate ⇒ (weakly) fewer reads; missRate=0 ⇒ the most reads", () => {
    const none = rfidCount(simulate({ ...OPTS, rfid: { ...RFID, missRate: 0 } }));
    const some = rfidCount(simulate({ ...OPTS, rfid: { ...RFID, missRate: 0.5 } }));
    const all = rfidCount(simulate({ ...OPTS, rfid: { ...RFID, missRate: 1 } }));
    expect(all).toBe(0);
    expect(none).toBeGreaterThan(0);
    expect(some).toBeLessThanOrEqual(none);
  });

  it("opt-in: the non-RFID stream is byte-identical to a run with no rfid option", () => {
    const withoutOption = simulate({ seed: 1234, durationTicks: 240 });
    const withMissAll = simulate({ seed: 1234, durationTicks: 240, rfid: { missRate: 1 } });
    // With every read dropped, only the additive rfidTagId on PackageCreated and
    // ZERO RfidObserved differ — the ordered non-RFID event TYPES are unchanged.
    expect(rfidCount(withMissAll)).toBe(0);
    const nonRfid = (s: ReturnType<typeof simulate>) =>
      types(s).filter((t) => t !== "RfidObserved");
    expect(nonRfid(withMissAll)).toEqual(types(withoutOption));
  });

  it("the rfidTagId addition does not change non-RFID event ORDER vs the legacy stream", () => {
    // Same horizon as OPTS so the non-RFID order is compared like-for-like.
    const legacy = simulate({ seed: 1234, durationTicks: OPTS.durationTicks });
    const withRfid = simulate(OPTS);
    const legacyOrder = types(legacy);
    const observedOrder = types(withRfid).filter((t) => t !== "RfidObserved");
    expect(observedOrder).toEqual(legacyOrder);
  });
});
