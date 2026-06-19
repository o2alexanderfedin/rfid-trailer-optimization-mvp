import type { DomainEvent } from "@mm/domain";

/**
 * Shared reducer contract for the operational-twin read models (FND-05/06/07).
 *
 * Every operational reducer is a PURE function of `(state, OccurredEvent)`:
 *
 *   type Reducer<S> = (state: S, event: OccurredEvent) => S
 *
 * Purity (PITFALLS P3) is the whole point: the only time/order inputs are the
 * event payload and `occurredAt` (the domain clock the store records). No
 * reducer reads the wall clock, calls into an RNG, or relies on `Map`/object
 * iteration order for correctness. That is what makes the live fold and the
 * rebuild-from-`global_seq=0` fold produce byte-identical state (FND-04).
 */

/**
 * A domain event paired with the domain timestamp the store recorded for it.
 * Reducers read time exclusively from `occurredAt`, never the wall clock.
 */
export interface OccurredEvent {
  readonly event: DomainEvent;
  /** Domain time of the event (ISO-8601), supplied by the event store. */
  readonly occurredAt: string;
}

/** The pure reducer signature every operational projection implements. */
export type Reducer<S> = (state: S, event: OccurredEvent) => S;

/**
 * Exhaustiveness guard for a `switch` over the closed `DomainEvent` union.
 * Mirrors `@mm/domain`'s `assertNever`: adding a new event member without a
 * matching `case` makes `event` no longer assignable to `never`, so the
 * reducer STOPS COMPILING. At runtime it throws, refusing to silently ignore
 * an unmodeled event.
 */
export function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled DomainEvent in reducer: ${JSON.stringify(event)}`);
}
