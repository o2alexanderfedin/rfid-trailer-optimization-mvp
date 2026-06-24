import { beforeAll, describe, expect, it } from "vitest";

/**
 * CONT-04c — LruMap eviction unit tests.
 *
 * Wave 0 stub: RED until plan-06 creates `../src/optimizer/lru-map.ts`. The
 * module is loaded via a dynamic import in `beforeAll` so the file COMPILES
 * before the source exists (a static `import` of a missing module would be a
 * hard TypeScript/resolve error). When the module is absent the import rejects
 * and every test fails with a clear "cannot find module" — the intended RED.
 *
 * The local `LruMapLike` interface mirrors the contract plan-06 implements; once
 * the real class lands it satisfies this shape structurally.
 */
interface LruMapLike<K, V> {
  get(k: K): V | undefined;
  set(k: K, v: V): void;
  readonly size: number;
}

interface LruMapCtor {
  new <K, V>(cap: number): LruMapLike<K, V>;
}

let LruMap: LruMapCtor;

beforeAll(async () => {
  // Wave 0: the module does not exist until plan-06 creates it. Suppress the
  // resolve error so `pnpm typecheck` stays green; the runtime import rejects
  // (cannot find module) — the intended RED until plan-06.
  // @ts-expect-error -- ../src/optimizer/lru-map.js is created in plan-06
  const mod = (await import("../src/optimizer/lru-map.js")) as {
    LruMap: LruMapCtor;
  };
  LruMap = mod.LruMap;
});

describe("LruMap (CONT-04c)", () => {
  it("get returns undefined for a missing key", () => {
    const m = new LruMap<string, number>(2);
    expect(m.get("x")).toBeUndefined();
  });

  it("set and get round-trip", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    expect(m.get("a")).toBe(1);
  });

  it("evicts the least-recently-used entry when cap is exceeded", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // evicts "a" (LRU)
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("get moves the accessed key to MRU (evicts the other when cap exceeded)", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a"); // "a" is now MRU; "b" is LRU
    m.set("c", 3); // evicts "b" (LRU)
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBe(1);
    expect(m.get("c")).toBe(3);
  });

  it("size reflects current entry count (capped at cap)", () => {
    const m = new LruMap<string, number>(2);
    expect(m.size).toBe(0);
    m.set("a", 1);
    expect(m.size).toBe(1);
    m.set("b", 2);
    m.set("c", 3);
    expect(m.size).toBe(2);
  });

  it("set on existing key updates the value and moves it to MRU", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 11); // update + promote "a" to MRU; "b" is now LRU
    m.set("c", 3); // evicts "b"
    expect(m.get("a")).toBe(11);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("c")).toBe(3);
  });
});
