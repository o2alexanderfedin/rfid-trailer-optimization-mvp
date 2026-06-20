import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG, type FusionConfig } from "../src/config.js";
import { rssiToLikelihood } from "../src/likelihood.js";

/**
 * Task 1 — `rssiToLikelihood` (SNS-01).
 *
 * The per-read RSSI→likelihood mapping must be MONOTONIC (stronger signal ⇒ at
 * least as much confidence), reader/antenna-TYPE weighted (a high-reliability
 * `dock-portal` beats a zone-ish `trailer-antenna` for the same RSSI), and
 * CAPPED at `config.maxLikelihood` (default 0.85) with a strictly positive floor
 * — the first line of the anti-P5b defense: no single read can ever be certain.
 */
describe("rssiToLikelihood", () => {
  const cfg = DEFAULT_FUSION_CONFIG;

  it("is monotonic non-decreasing in RSSI for a fixed reader type", () => {
    const samples = [-100, -90, -80, -75, -70, -65, -60, -55, -50, -45, -40, -30];
    const likelihoods = samples.map((rssi) =>
      rssiToLikelihood(rssi, "trailer-antenna", cfg),
    );
    for (let i = 1; i < likelihoods.length; i += 1) {
      const prev = likelihoods[i - 1];
      const cur = likelihoods[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      // non-decreasing
      expect(cur as number).toBeGreaterThanOrEqual(prev as number);
    }
  });

  it("never exceeds maxLikelihood, even for an absurdly strong RSSI", () => {
    for (const rssi of [-45, -40, -20, 0, 10, 1000]) {
      const l = rssiToLikelihood(rssi, "dock-portal", cfg);
      expect(l).toBeLessThanOrEqual(cfg.maxLikelihood);
      expect(l).toBeLessThan(1.0);
    }
  });

  it("stays strictly above zero (a positive floor), even for an absurdly weak RSSI", () => {
    for (const rssi of [-90, -120, -200, -1000]) {
      const l = rssiToLikelihood(rssi, "trailer-antenna", cfg);
      expect(l).toBeGreaterThan(0);
      expect(l).toBeGreaterThanOrEqual(cfg.minLikelihood);
    }
  });

  it("rates a dock-portal higher than a trailer-antenna for the same RSSI", () => {
    for (const rssi of [-70, -60, -55, -50]) {
      const portal = rssiToLikelihood(rssi, "dock-portal", cfg);
      const antenna = rssiToLikelihood(rssi, "trailer-antenna", cfg);
      expect(portal).toBeGreaterThan(antenna);
    }
  });

  it("honors a custom (lower) maxLikelihood cap from config", () => {
    const tight: FusionConfig = { ...cfg, maxLikelihood: 0.6 };
    const l = rssiToLikelihood(9999, "dock-portal", tight);
    expect(l).toBeLessThanOrEqual(0.6);
  });

  it("is a pure function: same input ⇒ same output", () => {
    const a = rssiToLikelihood(-62, "trailer-antenna", cfg);
    const b = rssiToLikelihood(-62, "trailer-antenna", cfg);
    expect(a).toBe(b);
  });
});
