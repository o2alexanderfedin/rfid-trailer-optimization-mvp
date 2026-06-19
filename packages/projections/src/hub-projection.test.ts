import { describe, expect, it } from "vitest";
import type { HubRegistered } from "@mm/domain";
import { projectHub } from "./index.js";

const event: HubRegistered = {
  type: "HubRegistered",
  schemaVersion: 1,
  payload: { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
};

describe("projectHub (FND-04 deterministic, idempotent projection)", () => {
  it("maps HubRegistered to a single hubs upsert", () => {
    const writes = projectHub(event);
    expect(writes).toEqual([{ table: "hubs", row: event.payload }]);
  });

  it("is deterministic: identical input -> identical output", () => {
    expect(projectHub(event)).toEqual(projectHub(event));
  });

  it("is a pure no-op for events it does not project", () => {
    // The union only has HubRegistered today; assert the default branch via cast.
    const unknownEvent = { type: "SomethingElse" } as unknown as HubRegistered;
    expect(projectHub(unknownEvent)).toEqual([]);
  });
});
