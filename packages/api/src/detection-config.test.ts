import { describe, expect, it } from "vitest";
import { resolveDemoHosEnabled } from "./detection-config.js";

/**
 * Phase 18 — the LIVE driver-HOS toggle. `resolveDemoHosEnabled` decides whether
 * the running demo (`main.ts`) drives Hours-of-Service modeling ON. It DEFAULTS
 * ON so the v1.2 hero feature is visible, and accepts a small set of falsey
 * env spellings to force the legacy HOS-off stream. Pure (env passed in), so it
 * is hermetically testable with no process mutation.
 */
describe("resolveDemoHosEnabled — live demo HOS toggle (HOS_ENABLED)", () => {
  it("defaults ON when HOS_ENABLED is unset (demo visibility)", () => {
    expect(resolveDemoHosEnabled({})).toBe(true);
  });

  it("defaults ON when HOS_ENABLED is the empty string", () => {
    expect(resolveDemoHosEnabled({ HOS_ENABLED: "" })).toBe(true);
  });

  it("is ON for affirmative / arbitrary values", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes", "anything"]) {
      expect(resolveDemoHosEnabled({ HOS_ENABLED: v })).toBe(true);
    }
  });

  it("is OFF for the recognized falsey spellings (case/space-insensitive)", () => {
    for (const v of ["0", "false", "FALSE", "off", "no", "  off  ", "No"]) {
      expect(resolveDemoHosEnabled({ HOS_ENABLED: v })).toBe(false);
    }
  });
});
