import type { Kysely } from "kysely";
import { append, getHubs, type Database } from "@mm/event-store";
import { MEMPHIS, hubRegisteredEvent } from "@mm/simulation";

/**
 * Seed the canonical Memphis hub via the event store (append -> inline
 * projection). Idempotent: if the `hubs` projection already has Memphis, this
 * is a no-op, so server restarts never duplicate it.
 *
 * `occurredAt` is injected so the caller controls time (determinism); the
 * default is the well-known epoch, never `Date.now()`.
 */
export async function seedHubs(
  db: Kysely<Database>,
  occurredAt: Date = new Date("2026-01-01T00:00:00.000Z"),
): Promise<void> {
  const existing = await getHubs(db);
  if (existing.some((h) => h.hub_id === MEMPHIS.hubId)) return;
  await append(
    db,
    `hub-${MEMPHIS.hubId}`,
    0,
    [hubRegisteredEvent(MEMPHIS)],
    occurredAt,
  );
}
