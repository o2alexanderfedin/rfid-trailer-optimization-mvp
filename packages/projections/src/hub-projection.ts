import type { DomainEvent, Hub } from "@mm/domain";

/**
 * A pure description of a projection write. The projection reducer NEVER
 * touches a database, clock, or RNG (PITFALLS P3 determinism); it maps an
 * event to the set of upserts an applier must perform. The applier (in
 * `event-store`) executes these in the SAME transaction as the append, so
 * reads are read-your-writes consistent.
 *
 * Idempotency (PITFALLS P5a): a `hubs` upsert keyed by `hubId` makes
 * re-applying the same event a no-op, so replay/restart never inflates state.
 */
export interface HubUpsert {
  readonly table: "hubs";
  readonly row: Hub;
}

export type HubProjectionWrite = HubUpsert;

/**
 * Pure reducer: given a domain event, return the projection writes it implies.
 * Deterministic — identical input always yields identical output. Events that
 * the `hubs` projection does not care about yield no writes.
 */
export function projectHub(event: DomainEvent): readonly HubProjectionWrite[] {
  switch (event.type) {
    case "HubRegistered":
      return [{ table: "hubs", row: event.payload }];
    default:
      return [];
  }
}
