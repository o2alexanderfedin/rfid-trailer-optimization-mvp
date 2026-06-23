import type { z } from "zod";
import { assertNever, type DomainEvent } from "./domain-event.js";
import type { domainEventSchema } from "./schemas.js";

/**
 * COMPILE-TIME CONTRACT FIXTURE (no runtime behavior).
 *
 * This module is part of the package's `tsc -b` build (NOT a test), so the
 * build gate FAILS if either contract below is violated. It encodes the two
 * guarantees the plan requires as compile errors:
 *
 *  1. Closed-union exhaustiveness — a `switch` over every `DomainEvent["type"]`
 *     whose `default` is `assertNever`. Add a union member without a case and
 *     this stops compiling.
 *  2. zod/union type-equality — the type inferred from `domainEventSchema` and
 *     the hand-written `DomainEvent` union are mutually assignable. Drift in
 *     either direction is a compile error.
 *
 * Keeping the proof in `src/` (not just in `*.test.ts`, which the build
 * excludes) means the contract is enforced by `pnpm -r build`, not only at
 * test time.
 */

/** Exhaustiveness proof: every discriminant has a case; `default` is `never`. */
function assertExhaustive(event: DomainEvent): void {
  switch (event.type) {
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDeparted":
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
      return;
    default:
      assertNever(event);
  }
}
void assertExhaustive;

/**
 * Type-equality proof. `Exact<A, B>` is `true` only when `A` and `B` are
 * mutually assignable. Assigning `true` to `Exact<Inferred, DomainEvent>`
 * compiles only if the zod-inferred union and the hand-written union match.
 */
type Inferred = z.infer<typeof domainEventSchema>;
type IfEquals<A, B, Then, Else> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? Then
    : Else;
type Exact<A, B> = IfEquals<A, B, true, false>;

const _zodMatchesHandWrittenUnion: Exact<Inferred, DomainEvent> = true;
void _zodMatchesHandWrittenUnion;
