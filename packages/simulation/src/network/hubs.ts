import type { Hub, HubRegistered } from "@mm/domain";

/**
 * SIM-01: the Phase-1 USA hub network. Ten real US metro sort hubs with WGS84
 * coordinates inside the continental-USA envelope (lat ∈ [24,49],
 * lon ∈ [-125,-66]). Memphis is the canonical Phase-1 skeleton hub (the world's
 * busiest cargo airport / classic middle-mile sort hub) and the hub-and-spoke
 * center.
 *
 * This list is a static, declarative constant — no clock, no RNG — so the
 * resulting event stream is reproducible (SIM-02 determinism). IATA codes are
 * used as stable hub ids.
 */
export const USA_HUBS: readonly Hub[] = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { hubId: "DFW", name: "Dallas-Fort Worth", lat: 32.7767, lon: -96.797 },
  { hubId: "ATL", name: "Atlanta", lat: 33.749, lon: -84.388 },
  { hubId: "LAX", name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { hubId: "JFK", name: "New York", lat: 40.7128, lon: -74.006 },
  { hubId: "DEN", name: "Denver", lat: 39.7392, lon: -104.9903 },
  { hubId: "PHX", name: "Phoenix", lat: 33.4484, lon: -112.074 },
  { hubId: "SEA", name: "Seattle", lat: 47.6062, lon: -122.3321 },
  { hubId: "IND", name: "Indianapolis", lat: 39.7684, lon: -86.1581 },
] as const;

/** The canonical single hub the Phase-1 walking skeleton renders + the spoke center. */
export const MEMPHIS: Hub = {
  hubId: "MEM",
  name: "Memphis",
  lat: 35.1495,
  lon: -90.049,
};

/**
 * Pure mapping from a hub to its `HubRegistered` event. Deterministic — no
 * ambient time/randomness; the persistence boundary assigns `occurred_at`.
 */
export function hubRegisteredEvent(hub: Hub): HubRegistered {
  return { type: "HubRegistered", schemaVersion: 1, payload: hub };
}
