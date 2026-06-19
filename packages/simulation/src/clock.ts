/**
 * SIM-02 determinism primitive: a virtual (domain) clock, decoupled from the
 * wall clock (PITFALLS Anti-Pattern 5 / "Sim clock" check).
 *
 * Time NEVER comes from `Date.now()`. The clock starts at a seeded epoch and
 * advances ONLY when the engine injects ticks; `occurredAt` for every emitted
 * event is read from here. Because the epoch and tick size are inputs, two runs
 * with the same configuration produce identical timestamps — a precondition for
 * the byte-identical event stream (threat T-01-15).
 */

/** Milliseconds since the Unix epoch — the clock's internal representation. */
type EpochMillis = number;

export class VirtualClock {
  /** Domain time as ms since the Unix epoch. Mutated only by {@link advance}. */
  private currentMs: EpochMillis;

  /** Milliseconds advanced per tick (the engine's quantum of sim time). */
  private readonly msPerTick: number;

  /**
   * @param epochIso     ISO-8601 start instant (domain epoch). Parsed once; the
   *                     wall clock is never read.
   * @param msPerTick    Domain milliseconds advanced per `advance(1)`. Must be a
   *                     positive integer so timestamps stay byte-stable.
   */
  constructor(epochIso: string, msPerTick: number) {
    const epoch = Date.parse(epochIso);
    if (Number.isNaN(epoch)) {
      throw new RangeError(`VirtualClock: invalid epoch ISO string "${epochIso}"`);
    }
    if (!Number.isInteger(msPerTick) || msPerTick <= 0) {
      throw new RangeError(`VirtualClock: msPerTick must be a positive integer, got ${msPerTick}`);
    }
    this.currentMs = epoch;
    this.msPerTick = msPerTick;
  }

  /** Advance the domain clock by `ticks` ticks (default 1). */
  advance(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`VirtualClock.advance: ticks must be a non-negative integer, got ${ticks}`);
    }
    this.currentMs += ticks * this.msPerTick;
  }

  /** Current domain time as a `Date` (a fresh copy — callers cannot mutate state). */
  now(): Date {
    return new Date(this.currentMs);
  }

  /** Current domain time as an ISO-8601 string — the `occurredAt` for events. */
  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }
}
