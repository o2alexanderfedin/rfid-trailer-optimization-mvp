import { describe, expect, it } from "vitest";
import { DEFAULT_FUSION_CONFIG } from "../src/config.js";
import {
  type RfidRead,
  type WindowedObservation,
  windowObservations,
} from "../src/window.js";

/**
 * Task 1 — `windowObservations` (anti-P5b dwell collapse).
 *
 * The keystone of P5b lives here in embryo: N raw reads of the SAME
 * `(tagId, readerId, dwellWindowId)` collapse into exactly ONE
 * `WindowedObservation` — never N. The aggregate RSSI is the 90th-PERCENTILE
 * (NOT the mean, which multipath drops skew), and the window carries the read
 * COUNT (read-rate density). Output ordering is DETERMINISTIC (sorted by key),
 * independent of input order — so the engine is replayable (anti-repudiation).
 */
function read(
  over: Partial<RfidRead> & Pick<RfidRead, "tagId" | "readerId" | "rssi">,
): RfidRead {
  return {
    antennaId: "ant-1",
    trailerId: "trl-1",
    hubId: "hub-1",
    readerType: "trailer-antenna",
    dwellWindowId: "dw-1",
    observedAt: "2026-06-19T10:00:00.000Z",
    perReadConfidence: 1,
    ...over,
  };
}

describe("windowObservations", () => {
  const cfg = DEFAULT_FUSION_CONFIG;

  it("collapses 50 identical reads of one (tag,reader,dwell) into exactly ONE observation", () => {
    const reads: RfidRead[] = Array.from({ length: 50 }, () =>
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55 }),
    );
    const out = windowObservations(reads, cfg);
    expect(out).toHaveLength(1);
    const only = out[0] as WindowedObservation;
    expect(only.readCount).toBe(50);
    expect(only.tagId).toBe("tag-A");
    expect(only.readerId).toBe("rdr-1");
    expect(only.dwellWindowId).toBe("dw-1");
  });

  it("splits distinct (tag,reader,dwell) keys into distinct observations", () => {
    const reads: RfidRead[] = [
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55 }),
      read({ tagId: "tag-A", readerId: "rdr-2", rssi: -55 }),
      read({ tagId: "tag-B", readerId: "rdr-1", rssi: -55 }),
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55, dwellWindowId: "dw-2" }),
    ];
    const out = windowObservations(reads, cfg);
    expect(out).toHaveLength(4);
  });

  it("does NOT collide id-tuples that share a naive delimiter-less concatenation", () => {
    // Under the old `${tagId}${readerId}${dwellWindowId}` (no delimiter), the
    // tuple (tag="AB", reader="C", dwell="D") and (tag="A", reader="BC", dwell="D")
    // both flatten to "ABCD" and would be MERGED into one observation. The keying
    // must keep them DISTINCT — proving the delimiter is load-bearing.
    const reads: RfidRead[] = [
      read({ tagId: "AB", readerId: "C", rssi: -55, dwellWindowId: "D" }),
      read({ tagId: "A", readerId: "BC", rssi: -55, dwellWindowId: "D" }),
    ];
    const out = windowObservations(reads, cfg);
    expect(out).toHaveLength(2);
    // Each observation is its own single read, not a merged 2-read window.
    expect(out.every((o) => o.readCount === 1)).toBe(true);
    // And both original tuples survive distinctly.
    const tuples = out.map((o) => `${o.tagId}|${o.readerId}|${o.dwellWindowId}`);
    expect(new Set(tuples).size).toBe(2);
    expect(tuples).toContain("AB|C|D");
    expect(tuples).toContain("A|BC|D");
  });

  it("does NOT collide a tag/dwell shift that the delimiter-less concat would merge", () => {
    // (reader="A", dwell="BC") vs (reader="AB", dwell="C") both flatten to the
    // same tail "ABC" with a fixed tag — distinct groups under a real delimiter.
    const reads: RfidRead[] = [
      read({ tagId: "tag-X", readerId: "A", rssi: -55, dwellWindowId: "BC" }),
      read({ tagId: "tag-X", readerId: "AB", rssi: -55, dwellWindowId: "C" }),
    ];
    const out = windowObservations(reads, cfg);
    expect(out).toHaveLength(2);
  });

  it("aggregates RSSI as the 90th-percentile, NOT the mean (multipath-drop-skewed sample)", () => {
    // A realistic dwell burst: a body of solid reads around -55 with a handful of
    // deep multipath DROPS to -95. The mean is dragged DOWN by the drops
    // (≈ -67); the 90th-percentile ignores the low tail and reports a strong
    // ≈ -54 — the strong signal "survives" the drops, which is the whole point.
    const rssis = [
      -55, -54, -56, -55, -53, -54, -55, -56, -54, -55, -53, -55,
      -95, -95, -95, -95, -95, -95, // 6 multipath drops out of 18
    ];
    const reads: RfidRead[] = rssis.map((rssi) =>
      read({ tagId: "tag-A", readerId: "rdr-1", rssi }),
    );
    const out = windowObservations(reads, cfg);
    expect(out).toHaveLength(1);
    const obs = out[0] as WindowedObservation;
    const mean = rssis.reduce((s, v) => s + v, 0) / rssis.length;
    // the aggregate must sit FAR above the drop-skewed mean (closer to the body)
    expect(obs.aggregatedRssi).toBeGreaterThan(mean + 5);
    // and report a strong read, not the depressed mean
    expect(obs.aggregatedRssi).toBeGreaterThanOrEqual(-56);
    expect(obs.aggregatedRssi).toBeLessThanOrEqual(-53);
  });

  it("produces deterministic, key-sorted output independent of input order", () => {
    const base: RfidRead[] = [
      read({ tagId: "tag-B", readerId: "rdr-2", rssi: -60 }),
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -60 }),
      read({ tagId: "tag-A", readerId: "rdr-2", rssi: -60 }),
      read({ tagId: "tag-B", readerId: "rdr-1", rssi: -60 }),
    ];
    const forward = windowObservations(base, cfg).map(
      (o) => `${o.tagId}|${o.readerId}|${o.dwellWindowId}`,
    );
    const reversed = windowObservations([...base].reverse(), cfg).map(
      (o) => `${o.tagId}|${o.readerId}|${o.dwellWindowId}`,
    );
    expect(forward).toEqual(reversed);
    // and it is actually sorted
    expect(forward).toEqual([...forward].sort());
  });

  it("returns no observations for an empty read list", () => {
    expect(windowObservations([], cfg)).toEqual([]);
  });

  it("carries lastObservedAt = the max observedAt in the window", () => {
    const reads: RfidRead[] = [
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55, observedAt: "2026-06-19T10:00:00.000Z" }),
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55, observedAt: "2026-06-19T10:00:02.500Z" }),
      read({ tagId: "tag-A", readerId: "rdr-1", rssi: -55, observedAt: "2026-06-19T10:00:01.000Z" }),
    ];
    const out = windowObservations(reads, cfg);
    expect(out[0]?.lastObservedAt).toBe("2026-06-19T10:00:02.500Z");
  });
});
