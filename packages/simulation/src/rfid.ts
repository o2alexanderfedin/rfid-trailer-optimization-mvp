import type { RfidObserved } from "@mm/domain";
import type { Rng } from "./rng.js";

/**
 * SIM-03: seeded, probabilistic RFID read generation.
 *
 * The simulator is the ONLY data source for Phase 3, so its RFID stream must be
 * (a) believably imperfect — drops, RSSI jitter, the occasional wrong-zone /
 * wrong-tag read — and (b) perfectly reproducible. Both hold because EVERY
 * stochastic decision here flows through the injected seeded {@link Rng}; there
 * is NO `Math.random` and NO `Date.now` in this module. `occurredAt` is supplied
 * by the caller (the engine's virtual clock).
 *
 * Anti-P6 (data layer): a dropped read is an OMITTED event — this function never
 * returns a substitute "missing"/"absent" signal. Absence is decided downstream
 * (detection, a separate one-way layer), never here.
 *
 * Anti-P5b (data layer): the per-read `confidence` is the SIMULATOR's own and is
 * bounded ≤ {@link RfidSimConfig.maxConfidence} (default 0.85). The fusion engine
 * recomputes its own posterior from `rssi`; this cap just means no single sim
 * read is ever reported as certain.
 */

/** Which physical reader produced a read — drives base RSSI + burst behaviour. */
export type ReaderType = "portal" | "antenna";

/** Tunable knobs for probabilistic RFID emission. All decisions are rng-driven. */
export interface RfidSimConfig {
  /** P(drop) per candidate read ∈ [0,1]. 0 ⇒ all reads; 1 ⇒ none. */
  readonly missRate: number;
  /** Max absolute RSSI jitter in dBm (symmetric ± via rng). 0 ⇒ no jitter. */
  readonly rssiNoise: number;
  /** P(a read is tagged to the wrong zone/trailer token) ∈ [0,1]. */
  readonly wrongZoneRate: number;
  /** P(a read carries a corrupted/unknown tag id) ∈ [0,1]. */
  readonly wrongTagRate: number;
  /** Reads per tag a trailer antenna emits per dwell window (the burst). */
  readonly antennaBurst: number;
  /** Base RSSI (dBm) for a dock-door portal — strong, high-reliability. */
  readonly portalBaseRssi: number;
  /** Base RSSI (dBm) for a trailer antenna — weaker, zone-ish, noisier. */
  readonly antennaBaseRssi: number;
  /** Per-read sim-confidence cap (anti-P5b at the data layer). */
  readonly maxConfidence: number;
}

/**
 * Defaults: a modest, demo-credible noise profile. Portal −50 dBm (strong),
 * antenna −65 dBm (zone-ish), a 4-read antenna burst per dwell so the fusion
 * engine's windowing is exercised, and a 0.85 confidence cap.
 */
export const DEFAULT_RFID_CONFIG: RfidSimConfig = {
  missRate: 0.1,
  rssiNoise: 3,
  wrongZoneRate: 0.03,
  wrongTagRate: 0.01,
  antennaBurst: 4,
  portalBaseRssi: -50,
  antennaBaseRssi: -65,
  maxConfidence: 0.85,
};

/** Merge a partial override onto the defaults (engine passes user knobs here). */
export function resolveRfidConfig(partial?: Partial<RfidSimConfig>): RfidSimConfig {
  return { ...DEFAULT_RFID_CONFIG, ...(partial ?? {}) };
}

/** Arguments for one emission pass (one portal load or one antenna dwell). */
export interface EmitRfidReadsArgs {
  /** The rfidTagIds of the packages eligible to be read at this moment. */
  readonly tags: readonly string[];
  /** Portal (on load) vs antenna (during dwell). */
  readonly readerType: ReaderType;
  /** The trailer these reads belong to (the RfidObserved stream key). */
  readonly trailerId: string;
  /** The hub at which the read occurs (portal reader id derives from it). */
  readonly hubId: string;
  /** Domain time from the engine's virtual clock (never the wall clock). */
  readonly occurredAt: string;
  /** The seeded randomness source — the SOLE source of all decisions here. */
  readonly rng: Rng;
  /** Resolved knobs (defaults already merged). */
  readonly config: RfidSimConfig;
}

const MIN_CONFIDENCE = 0.4;

/** A fixed pool of foreign zone tokens for the (rare) wrong-zone read. */
const WRONG_ZONE_SUFFIXES: readonly string[] = ["X", "Y", "Z"];

/** Reader id for a reader type at a location (deterministic, id-safe). */
function readerId(readerType: ReaderType, trailerId: string, hubId: string): string {
  return readerType === "portal" ? `${hubId}-PORTAL` : `${trailerId}-ANT`;
}

/** Antenna id mirrors the reader; portals expose a single logical antenna. */
function antennaId(readerType: ReaderType, trailerId: string, hubId: string): string {
  return readerType === "portal" ? `${hubId}-PORTAL-A1` : `${trailerId}-ANT-A1`;
}

/** Base RSSI (dBm) for the reader type, before jitter. */
function baseRssi(readerType: ReaderType, config: RfidSimConfig): number {
  return readerType === "portal" ? config.portalBaseRssi : config.antennaBaseRssi;
}

/**
 * Map an RSSI (dBm) to a bounded per-read confidence. Monotonic in signal
 * strength (less-negative ⇒ higher), normalised across the plausible band, and
 * hard-capped at `maxConfidence` so a single strong read is never reported as
 * certain (anti-P5b). Portal reads sit higher than antenna reads by construction.
 */
function rssiToConfidence(rssi: number, config: RfidSimConfig): number {
  // Plausible band ~ [-90, -40] dBm → [0,1] before capping.
  const lo = -90;
  const hi = -40;
  const norm = (rssi - lo) / (hi - lo);
  const clamped = norm < 0 ? 0 : norm > 1 ? 1 : norm;
  const spread = config.maxConfidence - MIN_CONFIDENCE;
  return MIN_CONFIDENCE + clamped * spread;
}

/** Symmetric integer-ish jitter in [-noise, +noise] dBm, all from the rng. */
function jitter(rng: Rng, noise: number): number {
  if (noise <= 0) return 0;
  // rng.next() ∈ [0,1) → [-noise, +noise]; kept off Math.random.
  return rng.next() * 2 * noise - noise;
}

/**
 * Generate the RfidObserved reads for one emission pass. Returns events (the
 * engine emits them); never mutates ambient state. Order is deterministic:
 * tags in the given order, and for an antenna, burst reads in sequence.
 */
export function emitRfidReads(args: EmitRfidReadsArgs): RfidObserved[] {
  const { tags, readerType, trailerId, hubId, occurredAt, rng, config } = args;
  const out: RfidObserved[] = [];
  const reads = readerType === "antenna" ? Math.max(1, config.antennaBurst) : 1;
  const rId = readerId(readerType, trailerId, hubId);
  const aId = antennaId(readerType, trailerId, hubId);
  const base = baseRssi(readerType, config);

  for (const tag of tags) {
    for (let i = 0; i < reads; i += 1) {
      // 1) Miss decision FIRST (rng consumed even on drop → deterministic).
      const dropped = rng.next() < config.missRate;
      // Always advance the rng identically whether or not we drop, so the
      // stream past a drop does not shift: draw jitter + the two corruption
      // rolls unconditionally below.
      const noise = jitter(rng, config.rssiNoise);
      const wrongTagRoll = rng.next();
      const wrongZoneRoll = rng.next();
      if (dropped) continue;

      const rssi = base + noise;
      const observedTag =
        wrongTagRoll < config.wrongTagRate ? `TAG-UNKNOWN-${rng.int(1000)}` : tag;
      const observedTrailerToken =
        wrongZoneRoll < config.wrongZoneRate
          ? `${trailerId}-${WRONG_ZONE_SUFFIXES[rng.int(WRONG_ZONE_SUFFIXES.length)]!}`
          : trailerId;

      const event: RfidObserved = {
        type: "RfidObserved",
        schemaVersion: 1,
        payload: {
          tagId: observedTag,
          readerId: rId,
          antennaId: aId,
          rssi,
          trailerId: observedTrailerToken,
          hubId,
          confidence: rssiToConfidence(rssi, config),
        },
      };
      out.push(event);
      void occurredAt; // occurredAt is applied by the engine's emit().
    }
  }
  return out;
}
