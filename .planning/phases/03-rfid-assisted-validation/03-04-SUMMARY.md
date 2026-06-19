---
phase: 03-rfid-assisted-validation
plan: 04
type: tdd
status: complete
requirements: [SNS-04, SNS-05]
---

# Plan 03-04 Summary — Detection predicates (pure, anti-P6)

Added the PURE detection predicates to `@mm/sensor-fusion` as a SEPARATE module
(`detection.ts`) with a strict ONE-WAY dependency on fusion: detection consumes
the fusion output (`ZoneEstimate`) but fusion NEVER imports detection — rule
decisions are never fed back into the likelihood engine (detection/fusion
separation, per the Phase-3 consult).

## Signatures (Plan 06 assembles the PLANNED layer + wraps candidates into events)

```ts
// PLANNED/KNOWN layer (typed locally so the predicate is pure & testable)
interface PlannedAssignment {
  packageId: string;
  plannedTrailerId: string | null; // null = not assigned to any trailer
  destHubId: string;
}

type SlaImpact = "low" | "medium" | "high";

interface DetectionConfig {
  confidenceThreshold: number;      // strict gate; default 0.6
  highConfidenceThreshold: number;  // escalation gate; default 0.8
  severityFor: (confidence: number, slaImpact: SlaImpact) => Severity; // @mm/domain Severity
}

// candidate outputs = the @mm/domain event payloads MINUS the envelope
interface WrongTrailerCandidate {
  packageId; observedTrailerId; plannedTrailerId; confidence;
  severity: Severity; recommendedAction: string;
}
interface MissedUnloadCandidate {
  packageId; trailerId; hubId; confidence;
  severity: Severity; recommendedAction: string;
}

detectWrongTrailer(planned: readonly PlannedAssignment[], observed: readonly ZoneEstimate[], config): WrongTrailerCandidate[]
detectMissedUnload(planned: readonly PlannedAssignment[], observed: readonly ZoneEstimate[], departedHub: string, config): MissedUnloadCandidate[]

DEFAULT_DETECTION_CONFIG // confidenceThreshold 0.6, highConfidenceThreshold 0.8, default severityFor
```

The OBSERVED layer is the fusion engine's `ZoneEstimate` (consumed one-way): the
detector reads `packageId`, `trailerId`, `confidence`.

## Behavior (truth tables)

- **Wrong-trailer (SNS-04):** fires ONE candidate per OBSERVED package seen
  (confidence STRICTLY > `confidenceThreshold`) in a trailer ≠ its
  `plannedTrailerId`. Correct trailer ⇒ none. Below/at threshold ⇒ none. No plan
  / `plannedTrailerId === null` ⇒ none (cannot disagree with a non-existent plan).
  High confidence (> `highConfidenceThreshold`) ⇒ severity `critical` + action
  `block_departure`; otherwise `recheck_before_departure`.
- **Missed-unload (SNS-05):** fires ONE candidate per package whose `destHubId`
  is the just-departed hub that is STILL observed (> threshold) aboard a trailer.
  No longer observed ⇒ none. Not for the departed hub ⇒ none. Below threshold ⇒
  none. Action `return_to_hub` (high) / `cross_dock` (otherwise).
- Both: deterministic ordering by `packageId`; pure (no clock, no RNG).

## Anti-P6 keystone (`absence-not-missing.keystone.test.ts`)

The structural defense: both predicates iterate the OBSERVED layer and consult
the plan by id — they NEVER iterate the planned set. A package with no read can
therefore never appear in the output, and there is no "missing"/"vanished"
candidate kind at all. Proven: empty observed ⇒ empty output; partially-observed
plan ⇒ only the observed-and-disagreeing fire; candidate count ≤ observation
count (observation-driven, not plan-driven); removing all observations ⇒ empty
output for any plan (absence monotonic).

## Touched files

- `packages/sensor-fusion/src/detection.ts` (NEW — the predicates + types)
- `packages/sensor-fusion/src/index.ts` (re-export the detection surface)
- `packages/sensor-fusion/test/detection.unit.test.ts` (NEW — truth tables)
- `packages/sensor-fusion/test/absence-not-missing.keystone.test.ts` (NEW — anti-P6)
- `packages/domain/src/events/{domain-event,index}.ts`, `packages/domain/src/index.ts`
  (export the existing closed `Severity` taxonomy as a TYPE, inferred from
  `severitySchema` — one source of truth; no new event/runtime surface).

## Gates

`pnpm install` ok · turbo `pnpm build` ok (9/9, no workspace cycles) ·
`pnpm -r build` ok · `pnpm lint` ok · `pnpm test:all` ok (412 passed, incl. the
26 new detection/keystone tests; zero prior-test regressions).

## Carried for Plan 06

Plan 06 assembles `PlannedAssignment[]` from the Phase-2 plan + trailer-state
assignment, gates `detectMissedUnload` to fire only POST-`TrailerDeparted`, and
wraps `WrongTrailerCandidate` / `MissedUnloadCandidate` into the
`WrongTrailerDetected` / `MissedUnloadDetected` domain events for the inline
exceptions projection + `GET /exceptions` feed.
