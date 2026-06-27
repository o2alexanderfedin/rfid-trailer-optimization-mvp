import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * FND-07 read model: per-hub inventory, bucketed inbound / outbound / staged.
 *
 * Each hub tracks three disjoint sets of package ids:
 *   - inbound : packages received at the hub, awaiting processing
 *               (`PackageArrivedAtHub`, or a `PackageScanned` with
 *               scanType="inbound").
 *   - staged  : packages unloaded from a trailer and staged in the yard
 *               (`PackageScanned` scanType="unload").
 *   - outbound: packages staged at the outbound dock, about to depart
 *               (`PackageScanned` scanType="outbound").
 *
 * A package occupies AT MOST ONE (hub, bucket) at any time: the placement
 * implied by its most recent location event. To keep the fold pure and
 * deterministic, the state carries a `placement` index (packageId -> current
 * {hubId, bucket}) so a move can deterministically REMOVE the package from its
 * prior bucket before adding it to the new one — no leakage, no double-count
 * (P5a-friendly), and no reliance on iteration order (P3).
 *
 * `scanType` "load" means the package was loaded onto a trailer that is leaving:
 * it is removed from hub inventory entirely (its location moves to the trailer).
 * `TrailerDeparted` additionally removes EVERY package in its `packageIds`
 * manifest from the source hub (FND-07 / M-3): the manifest is the authoritative
 * record of what left, so a departure without explicit per-package `load` scans
 * still decrements source-hub inventory. The two paths are idempotent — removing
 * an already-removed package is a no-op.
 *
 * Bucket contents are exposed as id arrays SORTED by id, so the serialized /
 * persisted form is byte-stable regardless of insertion order (P3 → FND-04).
 */

/** The three inventory buckets a hub tracks (FND-07). */
export type InventoryBucket = "inbound" | "outbound" | "staged";

/** One hub's inventory: disjoint id sets per bucket. */
export interface HubInventory {
  readonly hubId: string;
  readonly inbound: readonly string[];
  readonly outbound: readonly string[];
  readonly staged: readonly string[];
}

/** Where a package currently sits, for deterministic removal on move. */
interface Placement {
  readonly hubId: string;
  readonly bucket: InventoryBucket;
}

/**
 * The hub-inventory read model. `hubs` is the projected, queryable state; the
 * `placement` index is internal bookkeeping that makes moves deterministic.
 * Both are immutable snapshots replaced on each fold step.
 */
export interface HubInventoryState {
  readonly hubs: ReadonlyMap<string, HubInventory>;
  readonly placement: ReadonlyMap<string, Placement>;
}

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyHubInventoryState: HubInventoryState = {
  hubs: new Map(),
  placement: new Map(),
};

/** Total, stable string comparator (code-unit order) — locale-independent (P3). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const EMPTY_HUB = (hubId: string): HubInventory => ({
  hubId,
  inbound: [],
  outbound: [],
  staged: [],
});

/** Return a hub inventory with `packageId` removed from every bucket. */
function withoutPackage(hub: HubInventory, packageId: string): HubInventory {
  return {
    hubId: hub.hubId,
    inbound: hub.inbound.filter((id) => id !== packageId),
    outbound: hub.outbound.filter((id) => id !== packageId),
    staged: hub.staged.filter((id) => id !== packageId),
  };
}

/** Return a hub inventory with `packageId` added to `bucket` (sorted, deduped). */
function withPackage(
  hub: HubInventory,
  bucket: InventoryBucket,
  packageId: string,
): HubInventory {
  const merged = [...hub[bucket].filter((id) => id !== packageId), packageId].sort(
    compareIds,
  );
  return { ...hub, [bucket]: merged };
}

/**
 * Move `packageId` to `(hubId, bucket)`, removing it from wherever it currently
 * sits. A `null` target removes the package from inventory entirely (e.g. it was
 * loaded onto a departing trailer). Returns the next immutable state.
 */
function placePackage(
  state: HubInventoryState,
  packageId: string,
  target: Placement | null,
): HubInventoryState {
  const hubs = new Map(state.hubs);
  const placement = new Map(state.placement);

  // Remove from prior location, if any.
  const prior = placement.get(packageId);
  if (prior !== undefined) {
    const priorHub = hubs.get(prior.hubId);
    if (priorHub !== undefined) {
      hubs.set(prior.hubId, withoutPackage(priorHub, packageId));
    }
    placement.delete(packageId);
  }

  // Add to the new location, if any.
  if (target !== null) {
    const hub = hubs.get(target.hubId) ?? EMPTY_HUB(target.hubId);
    hubs.set(target.hubId, withPackage(hub, target.bucket, packageId));
    placement.set(packageId, target);
  }

  return { hubs, placement };
}

/** Map a `PackageScanned.scanType` to its target bucket, or `null` to remove. */
function bucketForScan(
  scanType: "inbound" | "outbound" | "load" | "unload",
): InventoryBucket | null {
  switch (scanType) {
    case "inbound":
      return "inbound";
    case "outbound":
      return "outbound";
    case "unload":
      return "staged";
    case "load":
      // Loaded onto a departing trailer: leaves hub inventory entirely.
      return null;
    default:
      return assertNeverScan(scanType);
  }
}

function assertNeverScan(scanType: never): never {
  throw new Error(`Unhandled scanType in hubInventoryReducer: ${String(scanType)}`);
}

/** Pure reducer for FND-07. Folds one event into the hub-inventory state. */
export function hubInventoryReducer(
  state: HubInventoryState,
  { event }: OccurredEvent,
): HubInventoryState {
  switch (event.type) {
    case "PackageArrivedAtHub":
      return placePackage(state, event.payload.packageId, {
        hubId: event.payload.hubId,
        bucket: "inbound",
      });
    case "PackageInducted":
      // v2.0 IND-01/Decision 3: externally-induced freight enters the induction
      // hub's INBOUND bucket — the SAME demand path as PackageArrivedAtHub. The
      // optimizer reads inducted freight automatically via this projection (no new
      // demand-source concept needed).
      return placePackage(state, event.payload.packageId, {
        hubId: event.payload.inductionHubId,
        bucket: "inbound",
      });
    case "PackageScanned": {
      const bucket = bucketForScan(event.payload.scanType);
      return placePackage(
        state,
        event.payload.packageId,
        bucket === null ? null : { hubId: event.payload.hubId, bucket },
      );
    }
    case "TrailerDeparted":
      // FND-07 (M-3): the departure's `packageIds` is the AUTHORITATIVE manifest
      // of what physically left the source hub. Decrement source-hub inventory
      // directly from it (removing each package from wherever it currently sits)
      // so a departure without explicit per-package `load` scans cannot leave
      // packages lingering in a source bucket and over-count inventory. This is
      // idempotent with the `load`-scan path: a package already removed is a
      // no-op (`placePackage(..., null)` on an absent package leaves state intact).
      return event.payload.packageIds.reduce(
        (acc, packageId) => placePackage(acc, packageId, null),
        state,
      );
    case "PlanSuperseded":
      // FLOW-04 / D-21-1 (Open-Q1 RESOLVED): `staged` holds BOTH unload-scan
      // freight AND an accepted plan's staged scope. `PlanAccepted` STAYS A NO-OP
      // (below) — its payload carries NO packageIds, so it cannot stage anything.
      // `PlanSuperseded` is the ONLY stage-mutating plan event: a DUMB PURE
      // delete-then-apply that removes the prior plan's HOLISTIC scope
      // (`supersededPackageIds`) from inventory — exactly the `TrailerDeparted`
      // manifest-decrement pattern above. Because the event carries the holistic
      // prior scope, items present in the OLD plan but absent in the NEW are wiped
      // (not stranded), and stale `staged` is never double-counted. The placement
      // index resolves each package's hub automatically, so the wipe spans every
      // hub the prior scope touched. NO epoch/scope comparison lives here — state
      // depends only on the explicit event fact (replay-from-zero clean, D-21-1).
      return event.payload.supersededPackageIds.reduce(
        (acc, packageId) => placePackage(acc, packageId, null),
        state,
      );
    case "PackageDelivered":
      // OUT-04 / D-22-1: hard DELETE via null target. `placePackage(..., null)` is
      // a guaranteed no-op when the package is absent (the `prior === undefined`
      // guard inside placePackage), so this is idempotent and crash-safe on
      // re-apply/replay. Removes the delivered package's inventory contribution.
      return placePackage(state, event.payload.packageId, null);
    // Phase-3 RFID/detection events are no-ops for hub inventory — observed
    // evidence is projected separately (later Phase-3 plans), never folded into
    // the planned inventory read model (anti-P6). Phase-4 plan-lifecycle events
    // (PlanGenerated/PlanAccepted, OPT-04) don't move packages between hubs, so
    // they no-op here too — and per FLOW-04 / Open-Q1 (RESOLVED), `PlanAccepted`
    // STAYS a no-op because its payload carries no packageIds; the staged scope is
    // mutated EXCLUSIVELY by `PlanSuperseded` (the delete-then-apply case above).
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events likewise move no
    // package between hubs, so they no-op as well.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "RfidObserved":
    case "WrongTrailerDetected":
    case "MissedUnloadDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
    case "TrailerDiverted": // Phase-24 OODA-01: a re-route does not move staged inventory (no-op until 24-02 wires it)
    case "ActionSuggested": // Phase-25 COORD-02: advisory suggestion events do not move staged inventory
    case "SuggestionAccepted":
    case "SuggestionRejected":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
