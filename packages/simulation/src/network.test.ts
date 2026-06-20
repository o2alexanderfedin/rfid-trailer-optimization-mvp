import { describe, expect, it } from "vitest";
import { hubSchema } from "@mm/domain";
import { MEMPHIS, USA_HUBS, hubRegisteredEvent } from "./index.js";

describe("USA hub network (SIM-01)", () => {
  it("models ~10 US metro hubs", () => {
    expect(USA_HUBS.length).toBeGreaterThanOrEqual(8);
    expect(USA_HUBS.length).toBeLessThanOrEqual(12);
  });

  it("has valid coordinates and unique ids for every hub", () => {
    const ids = new Set<string>();
    for (const hub of USA_HUBS) {
      expect(() => hubSchema.parse(hub)).not.toThrow();
      ids.add(hub.hubId);
    }
    expect(ids.size).toBe(USA_HUBS.length);
  });

  it("includes Memphis at the canonical skeleton coordinates", () => {
    expect(MEMPHIS).toEqual({
      hubId: "MEM",
      name: "Memphis",
      lat: 35.1495,
      lon: -90.049,
    });
    expect(USA_HUBS).toContainEqual(MEMPHIS);
  });

  it("maps a hub to a deterministic HubRegistered event", () => {
    const a = hubRegisteredEvent(MEMPHIS);
    const b = hubRegisteredEvent(MEMPHIS);
    expect(a).toEqual(b);
    expect(a).toEqual({
      type: "HubRegistered",
      schemaVersion: 1,
      payload: MEMPHIS,
    });
  });
});
