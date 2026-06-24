import { beforeAll, describe, expect, it } from "vitest";

/**
 * CONT-03 — sim-day derivation unit tests.
 *
 * Wave 0 stub: RED until plan-05 exports a pure `deriveSimDay(simMs)` helper from
 * `../src/ws/snapshots.ts` (or a ws helper module). `simDay` is derived from the
 * deterministic virtual-clock `simMs` parameter — NEVER `Date.now()` — so it is
 * replay-stable. EPOCH must match the engine's `EPOCH_ISO`
 * ("2026-04-01T00:00:00.000Z").
 *
 * Loaded via dynamic import so the file compiles before plan-05's export exists.
 */
const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let deriveSimDay: (simMs: number) => number;

beforeAll(async () => {
  const mod = (await import("../src/ws/snapshots.js")) as {
    deriveSimDay?: (simMs: number) => number;
  };
  if (mod.deriveSimDay === undefined) {
    throw new Error("snapshots.ts must export deriveSimDay(simMs) (plan-05)");
  }
  deriveSimDay = mod.deriveSimDay;
});

describe("simDay derivation from simMs (CONT-03)", () => {
  it("simMs at the epoch is day 0", () => {
    expect(deriveSimDay(EPOCH_MS)).toBe(0);
  });

  it("2.5 days after the epoch is day 2 (floor)", () => {
    expect(deriveSimDay(EPOCH_MS + MS_PER_DAY * 2.5)).toBe(2);
  });

  it("just under one day after the epoch is still day 0", () => {
    expect(deriveSimDay(EPOCH_MS + MS_PER_DAY - 1)).toBe(0);
  });

  it("exactly one day after the epoch is day 1", () => {
    expect(deriveSimDay(EPOCH_MS + MS_PER_DAY)).toBe(1);
  });

  it("the initial-connect simMs (0) never yields a negative day", () => {
    // The connect snapshot sends simMs=0; the derived day must be clamped to >= 0
    // so the operator UI never shows a negative "Sim Day".
    expect(deriveSimDay(0)).toBeGreaterThanOrEqual(0);
  });
});
