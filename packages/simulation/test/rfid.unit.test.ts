import { describe, expect, it } from "vitest";
import { validateEvent, type RfidObserved } from "@mm/domain";
import { simulate } from "../src/engine.js";
import { emitRfidReads, DEFAULT_RFID_CONFIG, type RfidSimConfig } from "../src/rfid.js";
import { makeRng } from "../src/rng.js";

/**
 * SIM-03 — seeded probabilistic RFID emission.
 *
 * The simulator emits `RfidObserved` at dock-door PORTALS (on load) and trailer
 * ANTENNAS (bursts during dwell). Every miss / RSSI-jitter / wrong-zone / wrong-tag
 * decision flows through the seeded `Rng` (no Math.random / Date.now). A dropped
 * read is an OMITTED event — never a substitute "missing" signal (anti-P6).
 */

const RFID_OPTS = {
  seed: 7,
  durationTicks: 240,
  rfid: { missRate: 0.2, rssiNoise: 4 },
} as const;

function rfidEvents(stream: ReturnType<typeof simulate>): RfidObserved[] {
  return stream
    .map((s) => s.event)
    .filter((e): e is RfidObserved => e.type === "RfidObserved");
}

describe("emitRfidReads (unit) — reader-type RSSI, missRate, jitter (SIM-03)", () => {
  const baseArgs = {
    tags: ["TAG-P00001", "TAG-P00002"] as const,
    trailerId: "T001",
    hubId: "MEM",
    occurredAt: "2026-04-01T00:10:00.000Z",
  };

  it("missRate=0 ⇒ every candidate read is emitted (portal: one per tag)", () => {
    const rng = makeRng(42);
    const reads = emitRfidReads({
      ...baseArgs,
      readerType: "portal",
      rng,
      config: { ...DEFAULT_RFID_CONFIG, missRate: 0 },
    });
    expect(reads.length).toBe(baseArgs.tags.length);
    for (const r of reads) {
      expect(r.type).toBe("RfidObserved");
      expect(() => validateEvent(r)).not.toThrow();
    }
  });

  it("missRate=1 ⇒ ZERO reads emitted (all dropped); no substitute event", () => {
    const rng = makeRng(42);
    const reads = emitRfidReads({
      ...baseArgs,
      readerType: "portal",
      rng,
      config: { ...DEFAULT_RFID_CONFIG, missRate: 1 },
    });
    expect(reads.length).toBe(0);
  });

  it("antenna dwell produces a BURST (more reads than tags) for windowing", () => {
    const rng = makeRng(42);
    const reads = emitRfidReads({
      ...baseArgs,
      readerType: "antenna",
      rng,
      config: { ...DEFAULT_RFID_CONFIG, missRate: 0 },
    });
    // burstSize default > 1 ⇒ multiple reads per tag in one dwell window.
    expect(reads.length).toBeGreaterThan(baseArgs.tags.length);
  });

  it("portal reads have higher (less-negative) RSSI than antenna reads (no noise)", () => {
    const cfg: RfidSimConfig = {
      ...DEFAULT_RFID_CONFIG,
      missRate: 0,
      rssiNoise: 0,
      wrongZoneRate: 0,
      wrongTagRate: 0,
    };
    const portal = emitRfidReads({ ...baseArgs, readerType: "portal", rng: makeRng(1), config: cfg });
    const antenna = emitRfidReads({ ...baseArgs, readerType: "antenna", rng: makeRng(1), config: cfg });
    const avg = (xs: RfidObserved[]) =>
      xs.reduce((a, r) => a + r.payload.rssi, 0) / xs.length;
    expect(avg(portal)).toBeGreaterThan(avg(antenna));
  });

  it("reader/antenna ids derive from hub (portal) and trailer (antenna)", () => {
    const cfg = { ...DEFAULT_RFID_CONFIG, missRate: 0 };
    const portal = emitRfidReads({ ...baseArgs, readerType: "portal", rng: makeRng(3), config: cfg });
    const antenna = emitRfidReads({ ...baseArgs, readerType: "antenna", rng: makeRng(3), config: cfg });
    expect(portal[0]!.payload.readerId).toBe("MEM-PORTAL");
    expect(antenna[0]!.payload.readerId).toBe("T001-ANT");
  });

  it("every emitted read carries confidence in (0,1] capped ≤ 0.85 (anti-P5b at data layer)", () => {
    const reads = emitRfidReads({
      ...baseArgs,
      readerType: "portal",
      rng: makeRng(9),
      config: { ...DEFAULT_RFID_CONFIG, missRate: 0 },
    });
    for (const r of reads) {
      expect(r.payload.confidence).toBeGreaterThan(0);
      expect(r.payload.confidence).toBeLessThanOrEqual(0.85);
    }
  });
});

describe("RFID emission wired into the engine (SIM-03)", () => {
  it("with rfid option, emits ≥1 RfidObserved whose tagId maps to a created package", () => {
    const stream = simulate(RFID_OPTS);
    const reads = rfidEvents(stream);
    expect(reads.length).toBeGreaterThan(0);

    const createdTags = new Set(
      stream
        .map((s) => s.event)
        .filter((e) => e.type === "PackageCreated")
        .map((e) => (e.payload as { rfidTagId?: string }).rfidTagId),
    );
    // At least one observed tag maps back to a created package's rfidTagId.
    expect(reads.some((r) => createdTags.has(r.payload.tagId))).toBe(true);
  });

  it("each PackageCreated carries a deterministic rfidTagId = TAG-${packageId}", () => {
    const stream = simulate(RFID_OPTS);
    const created = stream
      .map((s) => s.event)
      .filter((e) => e.type === "PackageCreated");
    expect(created.length).toBeGreaterThan(0);
    for (const e of created) {
      const p = e.payload as { packageId: string; rfidTagId?: string };
      expect(p.rfidTagId).toBe(`TAG-${p.packageId}`);
    }
  });

  it("WITHOUT the rfid option, NO RfidObserved is emitted (opt-in; goldens stay green)", () => {
    const stream = simulate({ seed: 7, durationTicks: 240 });
    expect(rfidEvents(stream).length).toBe(0);
  });

  it("missRate=1 ⇒ zero RfidObserved AND no 'missing' substitute event appears", () => {
    const stream = simulate({ seed: 7, durationTicks: 240, rfid: { missRate: 1 } });
    expect(rfidEvents(stream).length).toBe(0);
    const types = new Set(stream.map((s) => s.event.type));
    // The sim never invents a "missing"/absence event for a dropped read.
    expect([...types].some((t) => /missing|absent|notseen/i.test(t))).toBe(false);
  });

  it("portal reads occur on load (TrailerDeparted) and antenna reads during dwell (arrival)", () => {
    // TIME-01: antenna reads fire on ARRIVAL/dwell, and the per-leg transit
    // medians are now ≈400+ min, so the horizon must cover a real round-trip
    // arrival (a 240-tick run never reaches a spoke under realistic geography).
    const stream = simulate({ seed: 7, durationTicks: 6000, rfid: { missRate: 0 } });
    const reads = rfidEvents(stream);
    const readerIds = new Set(reads.map((r) => r.payload.readerId));
    expect([...readerIds].some((id) => id.endsWith("-PORTAL"))).toBe(true);
    expect([...readerIds].some((id) => id.endsWith("-ANT"))).toBe(true);
  });

  it("every RfidObserved in the engine stream passes the domain validateEvent boundary", () => {
    for (const r of rfidEvents(simulate(RFID_OPTS))) {
      expect(() => validateEvent(r)).not.toThrow();
    }
  });

  it("RfidObserved events go on the PLANNED trailer stream (even when wrong-zone corrupts the payload token) and preserve non-decreasing occurredAt", () => {
    const stream = simulate(RFID_OPTS);
    for (const s of stream) {
      if (s.event.type === "RfidObserved") {
        // Anti-P6/anti-zone-leak: the stream key is the PLANNED trailer; a
        // wrong-zone read corrupts only the OBSERVED payload token, never the
        // routing/stream id (so the observed disagreement stays detectable).
        expect(s.streamId.startsWith("trailer-")).toBe(true);
        expect(s.event.payload.trailerId.startsWith(s.streamId.slice("trailer-".length))).toBe(
          true,
        );
      }
    }
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i]!.occurredAt >= stream[i - 1]!.occurredAt).toBe(true);
    }
  });
});
