import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/index.js";

/**
 * The canonical, reviewable DDL lives in `schema.sql`; the runtime-embedded
 * `SCHEMA_SQL` string must stay byte-identical to it. This guard fails the
 * moment the two drift, so the artifact and what actually runs can never
 * diverge.
 */
describe("SCHEMA_SQL mirrors schema.sql exactly", () => {
  it("is byte-identical to src/schema.sql", () => {
    const sqlPath = fileURLToPath(new URL("../src/schema.sql", import.meta.url));
    const fileContents = readFileSync(sqlPath, "utf8");
    expect(SCHEMA_SQL).toBe(fileContents);
  });

  it("declares the optimistic-concurrency backstop constraint", () => {
    expect(SCHEMA_SQL).toContain("UNIQUE (stream_id, version)");
  });
});
