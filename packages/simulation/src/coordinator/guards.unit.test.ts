import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MS_PER_TICK } from "../epoch.js";
import { makeRng } from "../rng.js";
import {
  BACKOFF_BASE_SIM_MS,
  BACKOFF_CAP_SIM_MS,
  BACKOFF_JITTER_SIM_MS,
  HYSTERESIS_DWELL_SIM_MS,
  LEASE_SIM_MS,
  REJECT_COOLDOWN_K,
  SUGGESTION_TTL_SIM_MS,
} from "./constants.js";
import {
  acquireLease,
  clearPruneOnZoneChange,
  inBackoff,
  isExpired,
  isPruned,
  leaseAvailable,
  nextBackoffUntil,
  passesHysteresis,
  recordReject,
  updateHysteresisMarker,
} from "./guards.js";

/**
 * Phase-25 COORD-04 — unit proof of the five pure / sim-time / seeded guard
 * predicates. Each guard's suppress/allow/expire/lease/prune behavior is asserted
 * with concrete sim-time values; the last describe block proves PURITY (no
 * `Date.now`, no `Math.random` anywhere in `constants.ts`/`guards.ts`) by reading
 * the source — the structural DET-03 witness this leaf must hold (the ESLint guard
 * lands in Plan 05).
 */

describe("constants — the named sim-time envelope (COORD-04)", () => {
  it("are all integral multiples of MS_PER_TICK (sim-time, never wall-clock)", () => {
    for (const c of [
      HYSTERESIS_DWELL_SIM_MS,
      SUGGESTION_TTL_SIM_MS,
      LEASE_SIM_MS,
      BACKOFF_BASE_SIM_MS,
      BACKOFF_CAP_SIM_MS,
      BACKOFF_JITTER_SIM_MS,
    ]) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c % MS_PER_TICK).toBe(0);
      expect(c).toBeGreaterThan(0);
    }
  });

  it("encode the DESIGN-CONSULT envelope (dwell ~15m, TTL ~6m, lease ~5m, K=3)", () => {
    expect(HYSTERESIS_DWELL_SIM_MS).toBe(15 * MS_PER_TICK);
    expect(SUGGESTION_TTL_SIM_MS).toBe(6 * MS_PER_TICK);
    expect(LEASE_SIM_MS).toBe(5 * MS_PER_TICK);
    expect(REJECT_COOLDOWN_K).toBe(3);
  });
});

describe("GUARD 1 — hysteresis dead-band (passesHysteresis / updateHysteresisMarker)", () => {
  it("a null marker (no active breach) never passes", () => {
    expect(passesHysteresis(null, 10 * MS_PER_TICK)).toBe(false);
  });

  it("a breach BELOW the dwell window is suppressed (transient spike)", () => {
    const sinceSimMs = 100 * MS_PER_TICK;
    // 14 sim-min into a 15-sim-min dwell ⇒ not yet allowed.
    const now = sinceSimMs + (HYSTERESIS_DWELL_SIM_MS - MS_PER_TICK);
    expect(passesHysteresis(sinceSimMs, now)).toBe(false);
  });

  it("a sustained breach AT/ABOVE the dwell window passes (emit)", () => {
    const sinceSimMs = 100 * MS_PER_TICK;
    expect(passesHysteresis(sinceSimMs, sinceSimMs + HYSTERESIS_DWELL_SIM_MS)).toBe(true);
    expect(passesHysteresis(sinceSimMs, sinceSimMs + HYSTERESIS_DWELL_SIM_MS + MS_PER_TICK)).toBe(
      true,
    );
  });

  it("updateHysteresisMarker: metric below ⇒ null; first breach ⇒ now; continuing breach ⇒ retained", () => {
    const now = 50 * MS_PER_TICK;
    // below threshold ⇒ reset to null (transient spike clears the dwell)
    expect(updateHysteresisMarker(now - MS_PER_TICK, false, now)).toBe(null);
    // first breach with no prior marker ⇒ starts now
    expect(updateHysteresisMarker(null, true, now)).toBe(now);
    // continuing breach with an earlier marker ⇒ the marker is RETAINED (accrues)
    const earlier = now - 3 * MS_PER_TICK;
    expect(updateHysteresisMarker(earlier, true, now)).toBe(earlier);
  });

  it("a spike that clears resets the dwell so the NEXT breach must dwell afresh", () => {
    let marker: number | null = null;
    const t0 = 0;
    marker = updateHysteresisMarker(marker, true, t0); // breach starts at t0
    marker = updateHysteresisMarker(marker, false, t0 + 2 * MS_PER_TICK); // spike clears
    expect(marker).toBe(null);
    const t1 = t0 + 5 * MS_PER_TICK;
    marker = updateHysteresisMarker(marker, true, t1); // new breach starts at t1
    expect(marker).toBe(t1);
    // it has NOT dwelled yet from t1
    expect(passesHysteresis(marker, t1 + MS_PER_TICK)).toBe(false);
    expect(passesHysteresis(marker, t1 + HYSTERESIS_DWELL_SIM_MS)).toBe(true);
  });
});

describe("GUARD 2 — seeded-jitter exponential backoff (nextBackoffUntil / inBackoff)", () => {
  it("rejectionCount ≤ 0 ⇒ no backoff (returns nowSimMs)", () => {
    const rng = makeRng(7);
    expect(nextBackoffUntil(0, 1000, rng)).toBe(1000);
    expect(nextBackoffUntil(-3, 1000, rng)).toBe(1000);
  });

  it("the base delay is monotonically EXPONENTIAL in rejectionCount (capped)", () => {
    const now = 0;
    // Subtract the jitter to isolate the deterministic base delay (each draw from a
    // fresh same-seed rng is identical for the same call index — so compare deltas
    // against the known base*2^(n-1) using a jitter-free probe via cap saturation).
    const delays: number[] = [];
    for (let n = 1; n <= 6; n += 1) {
      // Fresh rng each iteration ⇒ same first draw ⇒ jitter is a constant offset.
      const rng = makeRng(123);
      delays.push(nextBackoffUntil(n, now, rng));
    }
    // Strictly non-decreasing (exponential growth dominates the constant jitter).
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    // The first step is BASE + jitter; the second is 2*BASE + jitter ⇒ a gap of BASE.
    expect(delays[1]! - delays[0]!).toBe(BACKOFF_BASE_SIM_MS);
    // The third is 4*BASE + jitter ⇒ a gap of 2*BASE from the second.
    expect(delays[2]! - delays[1]!).toBe(2 * BACKOFF_BASE_SIM_MS);
  });

  it("the delay is CAPPED (a huge rejectionCount saturates at the cap + jitter)", () => {
    const rng = makeRng(99);
    const until = nextBackoffUntil(40, 0, rng);
    // delay ≤ CAP + max jitter
    expect(until).toBeLessThanOrEqual(BACKOFF_CAP_SIM_MS + BACKOFF_JITTER_SIM_MS);
    // and ≥ CAP (it saturated)
    expect(until).toBeGreaterThanOrEqual(BACKOFF_CAP_SIM_MS);
  });

  it("the jitter is SEEDED: same seed ⇒ identical, different seeds ⇒ (generally) differ", () => {
    const a = nextBackoffUntil(2, 0, makeRng(1000));
    const b = nextBackoffUntil(2, 0, makeRng(1000));
    expect(a).toBe(b); // deterministic
    const c = nextBackoffUntil(2, 0, makeRng(2000));
    // The base delay is identical; only the seeded jitter differs ⇒ the totals differ.
    expect(c).not.toBe(a);
  });

  it("inBackoff suppresses until backoffUntil, then allows", () => {
    expect(inBackoff(null, 500)).toBe(false);
    expect(inBackoff(1000, 999)).toBe(true);
    expect(inBackoff(1000, 1000)).toBe(false);
    expect(inBackoff(1000, 1001)).toBe(false);
  });
});

describe("GUARD 3 — sim-time TTL (isExpired)", () => {
  it("a suggestion younger than the TTL is NOT expired", () => {
    const issued = 100 * MS_PER_TICK;
    expect(isExpired(issued, issued + SUGGESTION_TTL_SIM_MS - MS_PER_TICK)).toBe(false);
  });

  it("a suggestion AT/PAST the TTL is expired (self-destructs)", () => {
    const issued = 100 * MS_PER_TICK;
    expect(isExpired(issued, issued + SUGGESTION_TTL_SIM_MS)).toBe(true);
    expect(isExpired(issued, issued + SUGGESTION_TTL_SIM_MS + MS_PER_TICK)).toBe(true);
  });

  it("honors a per-suggestion ttlSimMs override", () => {
    const issued = 0;
    expect(isExpired(issued, 4 * MS_PER_TICK, 5 * MS_PER_TICK)).toBe(false);
    expect(isExpired(issued, 5 * MS_PER_TICK, 5 * MS_PER_TICK)).toBe(true);
  });
});

describe("GUARD 4 — single-owner lease (leaseAvailable / acquireLease)", () => {
  it("no lease ⇒ available to anyone", () => {
    expect(leaseAvailable(null, "C1", 1000)).toBe(true);
  });

  it("a live lease held by ANOTHER coordinator suppresses", () => {
    const lease = acquireLease("C1", 1000);
    expect(leaseAvailable(lease, "C2", 1000)).toBe(false);
    expect(leaseAvailable(lease, "C2", 1000 + LEASE_SIM_MS - MS_PER_TICK)).toBe(false);
  });

  it("the OWNING coordinator may re-advise its own leased target", () => {
    const lease = acquireLease("C1", 1000);
    expect(leaseAvailable(lease, "C1", 1000)).toBe(true);
  });

  it("an EXPIRED lease is reclaimable by any coordinator", () => {
    const lease = acquireLease("C1", 1000);
    expect(lease.expiresAtSimMs).toBe(1000 + LEASE_SIM_MS);
    expect(leaseAvailable(lease, "C2", 1000 + LEASE_SIM_MS)).toBe(true);
    expect(leaseAvailable(lease, "C2", 1000 + LEASE_SIM_MS + MS_PER_TICK)).toBe(true);
  });
});

describe("GUARD 5 — reject-path pruning (isPruned / recordReject / clearPruneOnZoneChange)", () => {
  it("an option is pruned only after K rejections", () => {
    let count = 0;
    expect(isPruned(count)).toBe(false);
    for (let i = 0; i < REJECT_COOLDOWN_K - 1; i += 1) {
      count = recordReject(count);
      expect(isPruned(count)).toBe(false);
    }
    count = recordReject(count); // the K-th
    expect(count).toBe(REJECT_COOLDOWN_K);
    expect(isPruned(count)).toBe(true);
  });

  it("recordReject is a pure +1", () => {
    expect(recordReject(0)).toBe(1);
    expect(recordReject(5)).toBe(6);
  });

  it("a zone change CLEARS the prune (resets the count to 0)", () => {
    let count = REJECT_COOLDOWN_K + 2;
    expect(isPruned(count)).toBe(true);
    count = clearPruneOnZoneChange();
    expect(count).toBe(0);
    expect(isPruned(count)).toBe(false);
  });
});

describe("PURITY (DET-03) — no Date.now / Math.random in the guard leaf", () => {
  // Strip block (/* … */) and line (// …) comments so the structural check matches
  // only EXECUTABLE source — a guard's doc comment legitimately NAMES the banned
  // APIs ("…never `Date.now`…") to document the determinism contract.
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (rel: string): string =>
    stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

  it("guards.ts and constants.ts contain NO Date.now / Math.random in code", () => {
    for (const rel of ["./guards.ts", "./constants.ts"]) {
      const src = read(rel);
      expect(src).not.toMatch(/Date\.now/);
      expect(src).not.toMatch(/Math\.random/);
    }
  });

  it("every guard is referentially transparent: same inputs ⇒ same output", () => {
    expect(passesHysteresis(10, 100)).toBe(passesHysteresis(10, 100));
    expect(isExpired(0, 100, 50)).toBe(isExpired(0, 100, 50));
    expect(isPruned(3)).toBe(isPruned(3));
    expect(leaseAvailable(acquireLease("C", 0), "C", 0)).toBe(
      leaseAvailable(acquireLease("C", 0), "C", 0),
    );
    expect(nextBackoffUntil(2, 0, makeRng(5))).toBe(nextBackoffUntil(2, 0, makeRng(5)));
  });
});
