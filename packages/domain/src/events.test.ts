import { describe, expect, it } from "vitest";
import { parseDomainEvent, type HubRegistered } from "./index.js";

const validHubRegistered: HubRegistered = {
  type: "HubRegistered",
  schemaVersion: 1,
  payload: { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
};

describe("parseDomainEvent (FND-03 typed ingestion)", () => {
  it("accepts a valid HubRegistered event and round-trips it", () => {
    const parsed = parseDomainEvent(validHubRegistered);
    expect(parsed).toEqual(validHubRegistered);
    expect(parsed.type).toBe("HubRegistered");
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseDomainEvent({ type: "Nope", schemaVersion: 1, payload: {} }),
    ).toThrow();
  });

  it("rejects an out-of-range latitude", () => {
    expect(() =>
      parseDomainEvent({
        type: "HubRegistered",
        schemaVersion: 1,
        payload: { hubId: "X", name: "Bad", lat: 999, lon: 0 },
      }),
    ).toThrow();
  });

  it("rejects a missing hubId", () => {
    expect(() =>
      parseDomainEvent({
        type: "HubRegistered",
        schemaVersion: 1,
        payload: { hubId: "", name: "Bad", lat: 0, lon: 0 },
      }),
    ).toThrow();
  });
});
