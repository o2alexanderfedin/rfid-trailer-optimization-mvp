/**
 * `@mm/api` — single-flight / dirty-flag coalesced optimizer runner (spec §5).
 *
 * The accumulator driver must FIRE the optimizer non-blocking — never await it
 * inside a frame, or the playback loop stalls at high speed. This wraps a
 * {@link SimTickRunner} so:
 *
 *  - at most ONE job is in flight at a time;
 *  - while busy, further `trigger`s accumulate their events into a pending
 *    buffer and remember the LATEST simMs (dirty);
 *  - when the in-flight job settles (resolve OR reject — it NEVER wedges), if
 *    dirty it immediately starts one more job over the accumulated pending events
 *    at the latest simMs, else it goes idle;
 *  - NO events are dropped: the union of all `trigger` events equals the union of
 *    all events handed to the wrapped runner.
 *
 * This bounds optimizer queue growth at 64× to a single coalesced re-run while
 * keeping the live demo's plan output best-effort current (spec §2 decision).
 */

import type { DomainEvent } from "@mm/domain";
import type { SimTickRunner } from "./driver.js";

/** The non-blocking optimizer trigger surface the accumulator driver uses. */
export interface CoalescedRunner {
  /**
   * Non-blocking: fire the optimizer for these events at `simMs`, or coalesce
   * into the pending buffer if a job is already in flight.
   */
  trigger(events: readonly DomainEvent[], simMs: number): void;
  /** Resolves when no job is in flight AND nothing is pending (drained to idle). */
  whenIdle(): Promise<void>;
}

/**
 * Wrap a {@link SimTickRunner} with single-flight + dirty coalescing. KISS state
 * machine: a `busy` flag, a `pendingEvents` buffer, the latest `pendingSimMs`,
 * and a list of `whenIdle` waiters resolved once the machine reaches idle.
 */
export function makeCoalescedRunner(runner: SimTickRunner): CoalescedRunner {
  let busy = false;
  let pendingEvents: DomainEvent[] = [];
  let pendingSimMs = 0;
  let hasPending = false;
  const idleWaiters: Array<() => void> = [];

  function resolveIdleWaiters(): void {
    // Drain the waiter list (copy-then-clear so a waiter re-arming whenIdle from
    // its own continuation lands in a fresh, empty list).
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const w of waiters) w();
  }

  function start(events: readonly DomainEvent[], simMs: number): void {
    busy = true;
    // Settle on BOTH paths — a rejecting runner must never wedge the coalescer.
    void runner(events, simMs).then(onSettle, onSettle);
  }

  function onSettle(): void {
    if (hasPending) {
      // Flush the accumulated pending batch as exactly one coalesced re-run.
      const events = pendingEvents;
      const simMs = pendingSimMs;
      pendingEvents = [];
      hasPending = false;
      start(events, simMs);
      return;
    }
    busy = false;
    resolveIdleWaiters();
  }

  return {
    trigger(events: readonly DomainEvent[], simMs: number): void {
      if (busy) {
        // Coalesce: accumulate events (union, in order), remember latest simMs.
        for (const e of events) pendingEvents.push(e);
        pendingSimMs = simMs;
        hasPending = true;
        return;
      }
      start(events, simMs);
    },
    whenIdle(): Promise<void> {
      if (!busy && !hasPending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
