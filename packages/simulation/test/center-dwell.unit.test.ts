import { describe, expect, it } from "vitest";
import type { TimingConfig } from "@mm/domain";
import { simulate, type SimulatedEvent } from "../src/engine.js";

/**
 * TIME-02 — the CENTER-hub re-dispatch dwell.
 *
 * Before TIME-02 the engine drew a single hub dwell without distinguishing hub
 * role, so the wired-but-unused `dwellCenter` (median 60) never fired: a trailer
 * arrived at its spoke, dwelled once, and re-departed FROM the center with no
 * modeled center pass-through. TIME-02 closes that gap — a trailer turning around
 * incurs EXACTLY ONE `dwellSpoke` at the spoke and EXACTLY ONE `dwellCenter` at
 * the center re-dispatch boundary (PITFALLS P4: one dwell per stop, keyed by hub
 * role, no double-count).
 *
 * The draws stay fully deterministic (seeded timing substream) so the assertions
 * pin both roles to distinct constants and read the realized gaps back out of the
 * stream.
 */

const SEED = 4242;
const TICKS = 480; // many round-trips ⇒ many turnarounds to assert over.
const CENTER = "MEM";
const EPOCH = Date.parse("2026-04-01T00:00:00.000Z");
const MS_PER_TICK = 60_000;
const tick = (iso: string): number => Math.round((Date.parse(iso) - EPOCH) / MS_PER_TICK);

/**
 * Pin every distribution to a CONSTANT (sigma 0, min===median===max) with DISTINCT
 * spoke vs center dwell, so a realized gap reveals exactly which roles fired.
 */
const SPOKE_DWELL = 10;
const CENTER_DWELL = 60;
const TRANSIT = 5;
const PINNED: TimingConfig = {
  dwellSpoke: { median: SPOKE_DWELL, sigma: 0, min: SPOKE_DWELL, max: SPOKE_DWELL },
  dwellCenter: { median: CENTER_DWELL, sigma: 0, min: CENTER_DWELL, max: CENTER_DWELL },
  transit: { median: TRANSIT, sigma: 0, min: TRANSIT, max: TRANSIT },
};

/**
 * Recover each turnaround gap: from a trailer's SPOKE arrival to that same
 * trailer's NEXT center-origin (re-dispatch) departure. With pinned constants
 * this gap is `dwellSpoke` (at the spoke) + `dwellCenter` (at the center) iff
 * EXACTLY ONE of each role fired per turnaround.
 */
function turnaroundGaps(stream: readonly SimulatedEvent[]): number[] {
  const lastSpokeArrival = new Map<string, number>();
  const out: number[] = [];
  for (const s of stream) {
    if (s.event.type === "TrailerArrivedAtHub" && s.event.payload.hubId !== CENTER) {
      lastSpokeArrival.set(s.event.payload.trailerId, tick(s.occurredAt));
    } else if (s.event.type === "TrailerDeparted" && s.event.payload.fromHubId === CENTER) {
      const arr = lastSpokeArrival.get(s.event.payload.trailerId);
      if (arr !== undefined) {
        out.push(tick(s.occurredAt) - arr);
        lastSpokeArrival.delete(s.event.payload.trailerId);
      }
    }
  }
  return out;
}

describe("center-hub re-dispatch dwell (TIME-02)", () => {
  it("a turnaround incurs EXACTLY ONE spoke dwell AND ONE center dwell (dwellCenter fires; no double-count)", () => {
    const stream = simulate({ seed: SEED, durationTicks: TICKS, timing: PINNED });
    const gaps = turnaroundGaps(stream);

    // There are real turnarounds to measure.
    expect(gaps.length).toBeGreaterThan(5);

    // Each turnaround = ONE spoke dwell + ONE center re-dispatch dwell, and
    // nothing else. If center dwell never fired the gap would be SPOKE_DWELL
    // alone (10); if dwell were double-counted it would be larger.
    for (const g of gaps) {
      expect(g).toBe(SPOKE_DWELL + CENTER_DWELL);
    }
  });

  it("the center dwell is LONGER than the spoke dwell (dwellCenter ≠ dwellSpoke, distinctly applied)", () => {
    // With center dwell wired, swapping ONLY dwellCenter to a larger constant
    // lengthens the turnaround by exactly the delta — proving the center leg of
    // the gap is governed by dwellCenter (not dwellSpoke).
    const baseline = turnaroundGaps(simulate({ seed: SEED, durationTicks: TICKS, timing: PINNED }));
    const longerCenter: TimingConfig = {
      ...PINNED,
      dwellCenter: { median: 90, sigma: 0, min: 90, max: 90 },
    };
    const longer = turnaroundGaps(simulate({ seed: SEED, durationTicks: TICKS, timing: longerCenter }));

    expect(longer.length).toBeGreaterThan(0);
    // The first few comparable turnarounds grow by exactly 90 - 60 = 30.
    const n = Math.min(baseline.length, longer.length);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      expect(longer[i]! - baseline[i]!).toBe(30);
    }
    // And the center dwell (90/60) dominates the spoke dwell (10) in the gap.
    expect(CENTER_DWELL).toBeGreaterThan(SPOKE_DWELL);
  });

  it("same seed + same timing ⇒ byte-identical stream (center dwell draw is deterministic)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS, timing: PINNED });
    const b = simulate({ seed: SEED, durationTicks: TICKS, timing: PINNED });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
