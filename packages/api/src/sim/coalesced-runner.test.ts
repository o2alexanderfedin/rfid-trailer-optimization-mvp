/**
 * Unit tests for the single-flight / dirty-flag coalesced optimizer runner
 * (TDD RED → GREEN).
 *
 * The coalescer wraps a `SimTickRunner` so the accumulator driver can FIRE the
 * optimizer non-blocking (spec §5 single-flight + dirty coalescing): at most one
 * job in flight; concurrent triggers accumulate their events + remember the
 * latest simMs and run ONCE after the in-flight job settles. No events are ever
 * dropped, and a rejecting runner never wedges the coalescer.
 */

import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";
import type { SimTickRunner } from "./driver.js";
import { makeCoalescedRunner } from "./coalesced-runner.js";

/** A trivial domain event carrying a distinguishable trailerId for union checks. */
function evt(trailerId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, tripId: "t", fromHubId: "A", toHubId: "B", packageIds: [] },
  };
}

const RESULT: EpochResult = {
  epochId: "e",
  scopeHash: "h",
  accepted: null,
  generated: null,
  recommendations: [],
};

/**
 * A manually-controlled runner: each invocation records its args and returns a
 * promise the test resolves/rejects by hand — so we can hold a job "in flight".
 */
function deferredRunner(): {
  readonly runner: SimTickRunner;
  readonly calls: Array<{ events: readonly DomainEvent[]; simMs: number }>;
  /** Settle the Nth (0-based) outstanding call's promise. */
  resolve: (index: number) => void;
  reject: (index: number) => void;
} {
  const calls: Array<{ events: readonly DomainEvent[]; simMs: number }> = [];
  const settlers: Array<{ resolve: () => void; reject: () => void }> = [];
  const runner: SimTickRunner = (events, simMs) => {
    calls.push({ events, simMs });
    return new Promise<EpochResult | undefined>((res, rej) => {
      settlers.push({ resolve: () => res(RESULT), reject: () => rej(new Error("boom")) });
    });
  };
  return {
    runner,
    calls,
    resolve: (i) => settlers[i]!.resolve(),
    reject: (i) => settlers[i]!.reject(),
  };
}

/** Let the microtask queue drain so settled-promise continuations run. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("makeCoalescedRunner — single-flight + dirty coalescing", () => {
  it("invokes the runner at most once while a job is in flight", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);

    c.trigger([evt("A")], 1000);
    c.trigger([evt("B")], 2000);
    c.trigger([evt("C")], 3000);
    await flush();

    // Only the first job started; the rest coalesced into a pending buffer.
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.events.map((e) => e.payload.trailerId)).toEqual(["A"]);
  });

  it("runs a second job after settle carrying the UNION of pending events + LATEST simMs", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);

    c.trigger([evt("A")], 1000); // starts job 0
    c.trigger([evt("B")], 2000); // pending
    c.trigger([evt("C")], 3000); // pending, latest simMs = 3000
    await flush();
    expect(d.calls).toHaveLength(1);

    d.resolve(0); // settle job 0 → coalescer starts job 1 with the pending union
    await flush();

    expect(d.calls).toHaveLength(2);
    expect(d.calls[1]!.events.map((e) => e.payload.trailerId)).toEqual(["B", "C"]);
    expect(d.calls[1]!.simMs).toBe(3000); // the LATEST simMs, not the first
  });

  it("whenIdle resolves only after the last coalesced job settles", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);

    c.trigger([evt("A")], 1000);
    c.trigger([evt("B")], 2000);
    await flush();

    let idle = false;
    const idlePromise = c.whenIdle().then(() => {
      idle = true;
    });

    d.resolve(0); // job 0 done → job 1 (pending B) starts; NOT idle yet
    await flush();
    expect(idle).toBe(false);
    expect(d.calls).toHaveLength(2);

    d.resolve(1); // job 1 done, nothing pending → idle
    await idlePromise;
    expect(idle).toBe(true);
  });

  it("preserves the UNION of all triggered events across many coalesced jobs (no drop, no dup)", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);

    // Trigger 5 disjoint events; settle one job at a time and keep triggering.
    c.trigger([evt("A")], 100); // job 0 starts (A)
    c.trigger([evt("B")], 200); // pending {B}
    c.trigger([evt("C")], 300); // pending {B,C}
    await flush();
    d.resolve(0); // job 1 starts with {B,C}
    await flush();
    c.trigger([evt("D")], 400); // pending {D}
    c.trigger([evt("E")], 500); // pending {D,E}
    d.resolve(1); // job 2 starts with {D,E}
    await flush();
    d.resolve(2);
    await c.whenIdle();

    const seen = d.calls.flatMap((call) => call.events.map((e) => e.payload.trailerId));
    expect(seen.sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("a rejecting runner still releases busy, processes pending, and whenIdle resolves (no wedge)", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);

    c.trigger([evt("A")], 1000); // job 0
    c.trigger([evt("B")], 2000); // pending
    await flush();

    d.reject(0); // job 0 REJECTS — coalescer must not wedge; it runs pending next
    await flush();
    expect(d.calls).toHaveLength(2);
    expect(d.calls[1]!.events.map((e) => e.payload.trailerId)).toEqual(["B"]);

    d.reject(1); // even a second rejection drains to idle
    await expect(c.whenIdle()).resolves.toBeUndefined();
  });

  it("whenIdle resolves immediately when nothing was ever triggered", async () => {
    const d = deferredRunner();
    const c = makeCoalescedRunner(d.runner);
    await expect(c.whenIdle()).resolves.toBeUndefined();
  });
});
