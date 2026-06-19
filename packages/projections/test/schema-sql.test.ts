import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROJECTIONS_SCHEMA_SQL } from "../src/index.js";

/**
 * The canonical, reviewable DDL lives in `src/schema.sql`; the runtime-embedded
 * `PROJECTIONS_SCHEMA_SQL` string must stay byte-identical to it. This guard
 * fails the moment the two drift (same convention as the event-store schema).
 */
describe("PROJECTIONS_SCHEMA_SQL mirrors schema.sql exactly", () => {
  it("is byte-identical to src/schema.sql", () => {
    const sqlPath = fileURLToPath(new URL("../src/schema.sql", import.meta.url));
    const fileContents = readFileSync(sqlPath, "utf8");
    expect(PROJECTIONS_SCHEMA_SQL).toBe(fileContents);
  });

  it("declares the three operational projection tables (FND-05/06/07)", () => {
    expect(PROJECTIONS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS package_location");
    expect(PROJECTIONS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS trailer_state");
    expect(PROJECTIONS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS hub_inventory");
  });
});
