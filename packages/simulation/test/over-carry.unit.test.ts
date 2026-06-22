import { describe, expect, it } from "vitest";
import type { PackageCreated, TrailerDeparted } from "@mm/domain";
import { validateEvent } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * F-07 / SNS-05 — the seeded OVER-CARRY substream.
 *
 * The detector (`detectMissedUnload`) is correct but, on the pre-F-07 stream,
 * unsatisfiable: every `TrailerDeparted.fromHubId` is the center and every
 * package's `destHubId` is a spoke, so the SNS-05 gate (`destHubId == departedHub`
 * for a hub that has departed and is STILL observed aboard) can never fire.
 *
 * This suite proves the new, OPT-IN over-carry knob makes the simulator PRODUCE
 * a missed-unload signal the UNCHANGED detector can catch:
 *
 *   (1) With `overCarry: 1` there is a SPOKE-origin `TrailerDeparted`
 *       (fromHubId != center) whose `packageIds` include a package whose
 *       `destHubId == that fromHubId` (a held-back over-carried package on the
 *       return leg) — i.e. a package destined for the spoke is still aboard a
 *       trailer that has departed the spoke. That is exactly the SNS-05 gate.
 *   (2) Same seed + same rate ⇒ byte-identical stream (the new substream is
 *       fully seeded; no Math.random / Date.now).
 *   (3) WITHOUT overCarry the stream is byte-identical to the golden (the knob is
 *       off by default; randomness flows through a SEPARATE salted substream that
 *       is never drawn when overCarry is absent).
 */

const CENTER = "MEM";
const SEED = 4242;
// TIME-01: over-carry fires on a SPOKE ARRIVAL, then emits a spoke→center return
// leg. With per-leg transit medians now derived from real great-circle distance
// (≈400+ min even for the shortest spoke), the horizon must span a full round
// trip plus the return leg — a 240-tick run never reaches a spoke.
const TICKS = 6000;

type Created = PackageCreated["payload"];
type Departed = TrailerDeparted["payload"];

function createdByPackageId(
  stream: ReturnType<typeof simulate>,
): Map<string, Created> {
  const out = new Map<string, Created>();
  for (const s of stream) {
    if (s.event.type === "PackageCreated") out.set(s.event.payload.packageId, s.event.payload);
  }
  return out;
}

function departures(stream: ReturnType<typeof simulate>): Departed[] {
  return stream
    .map((s) => s.event)
    .filter((e): e is TrailerDeparted => e.type === "TrailerDeparted")
    .map((e) => e.payload);
}

describe("over-carry (F-07 / SNS-05)", () => {
  it("(1) overCarry rate 1 produces a SPOKE-origin TrailerDeparted carrying a package destined for that spoke", () => {
    // RFID on so the held-back package is positively observed aboard (the live
    // gate needs a read above the calibrated threshold), but the structural
    // assertion below holds regardless of RFID.
    const stream = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0 }, overCarry: 1 });
    const created = createdByPackageId(stream);

    // A spoke-origin departure exists (the return leg of an over-carry).
    const spokeOrigin = departures(stream).filter((d) => d.fromHubId !== CENTER);
    expect(
      spokeOrigin.length,
      "expected at least one spoke-origin TrailerDeparted (over-carry return leg)",
    ).toBeGreaterThan(0);

    // At least one such departure carries a package whose dest IS that spoke —
    // i.e. a package that should have unloaded at the spoke is STILL aboard a
    // trailer that has now departed the spoke. THE SNS-05 gate.
    const missedUnloadShaped = spokeOrigin.some((d) =>
      d.packageIds.some((pid) => created.get(pid)?.destHubId === d.fromHubId),
    );
    expect(
      missedUnloadShaped,
      "expected a spoke-origin departure whose packageIds include a package destined for that spoke",
    ).toBe(true);

    // The over-carried departure also routes back toward the center.
    expect(spokeOrigin.some((d) => d.toHubId === CENTER)).toBe(true);

    // Every event still passes the domain boundary.
    for (const s of stream) expect(() => validateEvent(s.event)).not.toThrow();
  });

  it("(1b) the over-carried package is positively OBSERVED aboard the spoke-origin trailer (RFID portal read)", () => {
    const stream = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0 }, overCarry: 1 });
    const created = createdByPackageId(stream);
    const spokeOrigin = departures(stream).filter((d) => d.fromHubId !== CENTER);

    // Find one over-carried package (dest == spoke origin of its return departure).
    let overCarried: { packageId: string; trailerId: string } | undefined;
    for (const d of spokeOrigin) {
      const pid = d.packageIds.find((p) => created.get(p)?.destHubId === d.fromHubId);
      if (pid !== undefined) {
        overCarried = { packageId: pid, trailerId: d.trailerId };
        break;
      }
    }
    expect(overCarried).toBeDefined();

    // An RfidObserved read attributes that package's tag to the same trailer
    // (positively observed aboard after the spoke departed) so the live fusion
    // layer can clear the detection gate.
    const tag = `TAG-${overCarried!.packageId}`;
    const observedAboard = stream.some(
      (s) =>
        s.event.type === "RfidObserved" &&
        s.event.payload.tagId === tag &&
        s.event.payload.trailerId === overCarried!.trailerId,
    );
    expect(observedAboard, "over-carried package must be observed aboard the return trailer").toBe(true);
  });

  it("(2) same seed + same rate ⇒ byte-identical stream (the over-carry substream is fully seeded)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0.05 }, overCarry: 0.5 });
    const b = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0.05 }, overCarry: 0.5 });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("(3) WITHOUT overCarry the stream is byte-identical to the golden (knob off by default)", () => {
    const golden = simulate({ seed: SEED, durationTicks: TICKS });
    const withZeroNoKnob = simulate({ seed: SEED, durationTicks: TICKS });
    // Passing overCarry: 0 must ALSO leave the stream byte-identical (no draw,
    // no spoke-origin departure) — the rate gate is `< rate`, so 0 never fires.
    const withZeroKnob = simulate({ seed: SEED, durationTicks: TICKS, overCarry: 0 });

    expect(JSON.stringify(withZeroNoKnob)).toBe(JSON.stringify(golden));
    expect(JSON.stringify(withZeroKnob)).toBe(JSON.stringify(golden));

    // And no spoke-origin departure exists on the golden stream.
    expect(departures(golden).every((d) => d.fromHubId === CENTER)).toBe(true);
  });

  it("(3b) RFID golden is byte-identical with overCarry off (separate substream never perturbs rng/rfidRng)", () => {
    const rfidGolden = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0.1 } });
    const rfidGoldenOff = simulate({ seed: SEED, durationTicks: TICKS, rfid: { missRate: 0.1 }, overCarry: 0 });
    expect(JSON.stringify(rfidGoldenOff)).toBe(JSON.stringify(rfidGolden));
  });
});
