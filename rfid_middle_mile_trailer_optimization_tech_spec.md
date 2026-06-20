# Technical Specification: RFID-Assisted Middle-Mile Trailer Loading and Hub-to-Hub Optimization Platform

## 1. Executive Summary

This document specifies a logistics optimization platform for a hub-and-spoke truck delivery network operating in the middle-mile segment. The system is designed for parcel/package movement between hubs using long trailers with a single rear door. The primary operational problem is that packages destined for an earlier hub may become physically blocked by packages destined for later hubs, causing costly unloading/reloading operations, driver delays, dock congestion, service-level failures, and inefficient trailer utilization.

The proposed solution combines:

- Event-sourced operational state tracking.
- RFID/barcode/camera-assisted package visibility.
- Trailer state modeling as a rear-to-nose ordered structure.
- Load block aggregation instead of per-package optimization.
- Rolling-horizon optimization.
- LIFO/partial-LIFO trailer loading rules.
- Rehandle risk scoring.
- Min-cost flow for freight movement across hubs.
- VRP/VRPTW-style planning for trailer/truck routing.
- Optional future simulation/digital twin for what-if analysis.

The recommended first implementation should not attempt a full 3D digital twin of every package inside every trailer. Instead, it should implement a practical operational twin: a continuously updated, event-driven representation of packages, load blocks, trailers, hubs, routes, and confidence-scored location observations.

The system should initially optimize at the level of load blocks and trailer zones, not individual package geometry. Individual package tracking remains available for execution, audit, and exception handling.

---

## 2. Problem Statement

A logistics company operates a network of hubs connected by truck routes. Packages are collected from customers, moved between hubs, and eventually delivered through last-mile operations. Long trailers typically have only one rear door. During hub-to-hub transportation, packages may need to be unloaded at intermediate hubs.

The core problem is that a package or load group needed at the next hub may be physically located deeper inside the trailer, behind freight intended for later hubs. This creates a blocking problem:

- Driver must unload unrelated freight.
- Driver must reload unrelated freight.
- Trailer departure is delayed.
- Dock door is occupied longer.
- Packages are touched more times, increasing damage risk.
- SLA windows may be missed.
- Trailer utilization and routing decisions become suboptimal.

The company wants to keep trailers approximately 80% utilized while minimizing unnecessary package handling, missed hub connections, empty miles, dock waiting time, and SLA violations.

The solution must support a 24/7 hub network and should be able to replan dynamically as packages arrive, trailers are delayed, hubs become congested, or sensor observations contradict planned loading.

---

## 3. Business Goals

### 3.1 Primary Goals

1. Reduce package rehandling.
2. Reduce driver time spent searching, unloading, and reloading freight.
3. Improve trailer utilization, with a soft target around 80%.
4. Improve on-time departure and arrival performance.
5. Reduce wrong-trailer and missed-unload errors.
6. Improve visibility of package and load-block location.
7. Optimize hub-to-hub freight flow under capacity and SLA constraints.
8. Provide explainable load and route planning decisions.
9. Support real-time exception handling and rolling re-optimization.
10. Create a foundation for future simulation/digital twin capabilities.

### 3.2 Secondary Goals

1. Improve dock-door throughput.
2. Improve auditability of package movement.
3. Support human override with full traceability.
4. Improve forecasting for hub demand and trailer capacity.
5. Enable future automation using robotics, smart containers, or automated sortation.

---

## 4. Non-Goals for Initial MVP

The initial MVP should not attempt to solve all of the following:

1. Perfect 3D placement of every individual package.
2. Fully autonomous loading.
3. Full national network optimization in one solver run.
4. Real-time centimeter-level localization of all packages.
5. Replacement of all WMS/TMS systems.
6. Fully automated dispatch with no human override.
7. Complex physical simulation of trailer load stability.
8. Optimization of final-mile delivery routes.

These can be considered later, once operational data is collected and basic planning loops are proven.

---

## 5. Key Assumptions

1. Trailers are long containers with a single rear door.
2. Access to freight is mostly rear-to-front.
3. Loading order strongly affects unloading efficiency.
4. Packages can be grouped into logical load blocks.
5. A load block is the practical unit of optimization.
6. Individual package-level visibility is still needed for audit and exceptions.
7. RFID can provide useful identification and approximate zone-level observations.
8. RFID should be treated as sensor evidence, not absolute truth.
9. Some routing decisions may intentionally allow over-carry, delayed transfer, or reassignment to another trailer.
10. Trailer utilization target should be soft, not hard.
11. The network operates continuously and requires rolling re-optimization.

---

## 6. Core Domain Concepts

### 6.1 Package

A package is the smallest tracked physical item. It has identity, destination, SLA, size, weight, scan history, and possibly RFID tag identity.

Example attributes:

- Package ID
- RFID tag ID
- Origin hub
- Destination hub
- Final delivery zone
- Current known location
- Weight
- Volume
- Dimensions
- SLA class
- Deadline
- Handling class
- Fragile/heavy/oversized flags
- Last reliable observation
- Current state

### 6.2 Load Block

A load block is a group of packages that should move together for planning purposes.

A block is typically grouped by:

- Current hub
- Next destination hub
- Final destination hub
- SLA class
- Deadline bucket
- Handling class
- Size/weight class
- Trailer assignment


Load blocks are the primary optimization unit.

Example:

```text
LoadBlock L742:
  currentHub: Hub A
  nextUnloadHub: Hub C
  finalDestinationHub: Hub D
  packageCount: 420
  volume: 8.2 m³
  weight: 1,300 lb
  SLA: overnight
  deadline: 2026-06-19 08:00
```

### 6.3 Trailer

A trailer is modeled as an ordered rear-to-nose structure.

Because the trailer has one rear door, physical accessibility is primarily determined by depth from the rear.

Conceptual representation:

```text
[rear door]
Slice 0: easiest access
Slice 1
Slice 2
Slice 3
...
Slice N: deepest inside trailer
[nose]
```

A trailer state can be represented as:

```text
TrailerState {
  trailerId
  currentHub
  assignedRoute
  currentTrip
  utilization
  slices: Deque<TrailerSlice>
  lastObservedAt
  confidence
}
```

### 6.4 Trailer Slice

A trailer slice represents a logical depth segment.

```text
TrailerSlice {
  index
  depthFromRear
  loadBlocks[]
  usedVolume
  usedWeight
  rfidObservedTags[]
  confidence
}
```

### 6.5 Hub

A hub is a logistics node with docks, inbound trailers, outbound trailers, staging areas, RFID portals, and package sorting capacity.

```text
Hub {
  hubId
  location
  dockDoors[]
  operatingCalendar
  capacityProfile
  currentCongestion
}
```

### 6.6 Dock Door

A dock door is a constrained resource used for loading and unloading.

```text
DockDoor {
  dockDoorId
  hubId
  status
  assignedTrailerId
  availableFrom
  rfidPortalId
}
```

### 6.7 Route

A route is an ordered list of hub stops.

```text
Route {
  routeId
  hubs: [HubB, HubC, HubD]
  plannedDeparture
  plannedArrival
}
```

### 6.8 Trip

A trip is a concrete trailer/truck movement.

```text
Trip {
  tripId
  trailerId
  tractorId
  driverId
  fromHub
  toHub
  departureTime
  arrivalTime
  status
}
```

---

## 7. Trailer Loading Model

### 7.1 LIFO Principle

For a route:

```text
Hub A → Hub B → Hub C → Hub D
```

freight should be accessible in this order:

```text
[rear door]
Hub B freight
Hub C freight
Hub D freight
[nose]
```

Physically, the trailer is loaded in reverse order:

```text
1. Load Hub D freight deep into the nose.
2. Load Hub C freight in the middle.
3. Load Hub B freight near the rear door.
```

### 7.2 Accessibility Constraint

For any two load blocks A and B:

```text
if unloadOrder(A) < unloadOrder(B):
    depth(A) <= depth(B)
```

Where:

- Lower depth means closer to rear door.
- Earlier unload order means the freight must be accessible sooner.

### 7.3 Partial-LIFO Rule

Strict LIFO is too rigid for real operations. The system should support partial-LIFO with penalties.

A load block may be considered acceptable if the number of blockers is below a configured threshold.

Example:

```text
maxAllowedBlockers = 2
```

If a load block for the next hub has one blocking block in front of it, the system may allow it but assign rehandle cost.

If it has many blockers, the system should mark the plan infeasible or high-risk.

### 7.4 Blockers

A blocker is any load block closer to the rear door that is not supposed to be unloaded before the target block.

```text
blockers(targetBlock) =
  blocks closer to rear door
  where unloadOrder(block) > unloadOrder(targetBlock)
```

### 7.5 Rehandle Cost

```text
rehandleCost(block) =
  blockersCount * averageUnloadReloadTime
+ blockersVolume * volumeHandlingCost
+ fragilePenalty
+ dockDelayPenalty
+ SLAImpactPenalty
```

### 7.6 Trailer Utilization

Trailer utilization should be treated as a soft target.

Recommended initial target:

```text
targetUtilization = 80%
acceptableRange = 75% to 90%
```

The optimizer should avoid dispatching consistently low-utilization trailers, but it should be allowed to do so when SLA or network recovery requires it.

---

## 8. Sensor Model

### 8.1 Sensor Types

The platform should support multiple observation sources:

1. Barcode scans
2. RFID dock-door portals
3. RFID trailer antennas
4. Driver mobile app scans
5. Dock worker app scans
6. Camera/computer vision at loading dock
7. GPS trailer/tractor telemetry
8. Door open/close sensors
9. Weight sensors, if available

### 8.2 RFID Positioning Philosophy

RFID should not be treated as exact 3D positioning.

RFID observations should be interpreted as probabilistic evidence:

```text
Package P123:
  likelyTrailer: T42
  likelyZone: rear
  confidence: 0.82
```

### 8.3 RFID Observation Event

```json
{
  "eventType": "RfidObserved",
  "timestamp": "2026-06-18T14:05:22Z",
  "tagId": "EPC-123456",
  "readerId": "TRAILER-T42-REAR-ANTENNA-1",
  "antennaId": "rear-left",
  "rssi": -51,
  "phase": 123.4,
  "trailerId": "T42",
  "hubId": "H7",
  "confidence": 0.76
}
```

### 8.4 Estimated Location

```json
{
  "packageId": "P123",
  "trailerId": "T42",
  "estimatedZone": "rear",
  "confidence": 0.84,
  "lastReliableCheckpoint": "H7-DOCK-12",
  "lastObservedAt": "2026-06-18T14:05:22Z"
}
```

### 8.5 Sensor Fusion

Initial implementation can use rule-based Bayesian scoring.

Future versions can use:

- Hidden Markov Models
- Particle filters
- ML classifiers
- RFID phase/RSSI models
- Vision-assisted load confirmation

---

## 9. Event-Sourced Architecture

### 9.1 Why Event Sourcing

Logistics operations require auditability. The system must answer:

- Where was the package last seen?
- Who loaded it?
- Which trailer was assigned?
- Did the system recommend this plan?
- Did a human override the plan?
- Was the package observed after it should have been unloaded?

Event sourcing provides a full operational history.

### 9.2 Core Events

```text
PackageCreated
PackageScanned
PackageArrivedAtHub
PackageAssignedToLoadBlock
LoadBlockCreated
LoadBlockAssignedToTrailer
TrailerArrived
TrailerDocked
PackageLoaded
LoadBlockLoaded
RfidObserved
CameraObserved
TrailerDeparted
TrailerArrivedAtHub
PackageUnloaded
PackageMissing
WrongTrailerDetected
MissedUnloadDetected
RehandleRequired
PlanGenerated
PlanAccepted
PlanRejected
PlanOverridden
```

### 9.3 Event Flow

```text
Sensor / App / Integration
        ↓
Event Bus
        ↓
Event Store
        ↓
Operational Projection
        ↓
Optimization Projection
        ↓
Planning Engine
        ↓
Execution Commands
```

### 9.4 Projections

Recommended projections:

1. Current package location
2. Current trailer state
3. Current hub inventory
4. Current dock schedule
5. Current load plan
6. Current exceptions
7. SLA risk view
8. Optimization input view
9. Audit timeline

---

## 10. Planning and Optimization Architecture

### 10.1 Planning Layers

The optimizer should be decomposed into several smaller planning problems.

```text
Layer 1: Freight aggregation
Layer 2: Network flow assignment
Layer 3: Trailer/truck route planning
Layer 4: Trailer load planning
Layer 5: Cross-dock scheduling
Layer 6: Rolling repair and exception handling
```

This avoids one massive, unsolvable optimization model.

---

## 11. Algorithms

### 11.1 Freight Aggregation

Group packages into load blocks.

```pseudo
for package in availablePackages:
    key = (
        package.currentHub,
        package.destinationHub,
        package.slaClass,
        deadlineBucket(package.deadline),
        package.handlingClass,
        sizeWeightBucket(package)
    )
    loadBlocks[key].add(package)
```

Output:

```text
LoadBlock[]
```

### 11.2 Time-Expanded Network Graph

Represent hub network over time.

Nodes:

```text
Hub A @ 10:00
Hub A @ 10:15
Hub B @ 13:00
Hub B @ 13:15
```

Edges:

```text
TripEdge: A@10:00 → B@13:00
WaitEdge: A@10:00 → A@10:15
CrossDockEdge: inbound → outbound
LoadEdge
UnloadEdge
HoldEdge
```

This supports:

- Waiting at hub
- Catching a later trailer
- Over-carry
- Reassignment
- Missed connection handling
- SLA-aware routing

### 11.3 Min-Cost Flow

Use min-cost flow for assigning freight blocks to route legs.

Objective:

```text
minimize:
  transportation cost
+ waiting cost
+ handling cost
+ SLA lateness cost
+ missed connection risk
```

Constraints:

- Edge capacity
- Hub capacity
- Time window
- SLA deadline
- Trailer availability

### 11.4 VRP / VRPTW Route Planning

Use VRP-style solvers for trailer/truck routing.

Inputs:

- Available trailers
- Available tractors
- Drivers
- Hub stops
- Time windows
- Capacity
- Required departures
- Required arrivals
- Dock availability

Outputs:

- Trailer route
- Departure/arrival plan
- Stop sequence
- Utilization estimate

### 11.5 Trailer Load Planning

Initial greedy algorithm:

```pseudo
function buildLoadPlan(route, loadBlocks):
    orderMap = buildUnloadOrderMap(route)

    sortedBlocks = sort loadBlocks by orderMap[nextUnloadHub] descending

    trailer = empty deque

    for block in sortedBlocks:
        place block from nose toward rear

    score = evaluateTrailerPlan(trailer)

    return trailer, score
```

### 11.6 Load Plan Validation

```pseudo
function validateLoadPlan(trailer):
    violations = []

    for each block in trailer:
        blockers = findBlockers(block, trailer)

        if blockers.count > maxAllowedBlockers:
            violations.add(HardViolation(block, blockers))
        else if blockers.count > 0:
            violations.add(SoftViolation(block, blockers))

    return violations
```

### 11.7 Local Repair

If validation fails:

```pseudo
while plan has high rehandleScore:
    try splitBlock()
    try moveBlockToAnotherTrailer()
    try changeTrailerRoute()
    try holdBlockAtHub()
    try overCarryBlock()
    try scheduleRehandle()
```

### 11.8 Pickup Insertion

When picking up freight at an intermediate hub:

```pseudo
function insertPickupBlock(block, trailer, remainingRoute):
    candidatePositions = trailer.availablePositions()

    best = null

    for position in candidatePositions:
        tempTrailer = trailer.insert(block, position)
        score = evaluateTrailerPlan(tempTrailer, remainingRoute)

        if score is better:
            best = tempTrailer

    if best is acceptable:
        return best
    else:
        return alternativePlan(block)
```

Alternative plan options:

1. Assign to another trailer.
2. Hold at hub.
3. Over-carry through another hub.
4. Split block.
5. Allow controlled rehandle.

### 11.9 Rolling Horizon Re-Optimization

The system should replan periodically and event-triggered.

Recommended interval:

```text
Every 5–15 minutes
```

Planning horizon:

```text
2–6 hours for operational decisions
24 hours for tactical lookahead
7+ days for strategic capacity planning
```

Freeze window:

```text
Do not modify plans for trailers departing within 10–15 minutes unless critical.
```

Pseudo:

```pseudo
every planningEpoch:
    events = readNewEvents()
    updateOperationalTwin(events)

    affectedScope = detectAffectedHubsTrailersBlocks(events)

    planningInput = buildOptimizationInput(affectedScope)

    candidatePlan = optimize(planningInput)

    validatedPlan = validateAndRepair(candidatePlan)

    publishPlan(validatedPlan)
```

---

## 12. Objective Function

The optimizer should minimize a weighted cost function:

```text
TotalCost =
  milesCost
+ driverTimeCost
+ fuelCost
+ dockWaitCost
+ handlingTouchCost
+ rehandleCost
+ lateDeliveryPenalty
+ missedConnectionPenalty
+ lowUtilizationPenalty
+ overUtilizationPenalty
+ overCarryPenalty
+ trailerImbalancePenalty
+ packageDamageRiskPenalty
```

### 12.1 Utilization Penalty

```text
lowUtilizationPenalty =
  max(0, 0.75 - utilization)^2 * lowUtilizationWeight

highUtilizationPenalty =
  max(0, utilization - 0.90)^2 * highUtilizationWeight
```

### 12.2 SLA Penalty

```text
lateDeliveryPenalty =
  minutesLate * slaClassMultiplier
```

### 12.3 Rehandle Penalty

```text
rehandlePenalty =
  blockersCount * estimatedMinutesPerBlock
+ blockersVolume * volumePenalty
+ fragilePenalty
+ dockCongestionMultiplier
```

---

## 13. System Architecture

### 13.1 Logical Components

```text
1. Package Service
2. Hub Service
3. Trailer Service
4. RFID/Sensor Ingestion Service
5. Operational Twin Service
6. Load Block Aggregation Service
7. Optimization Service
8. Load Planning Service
9. Dock Scheduling Service
10. Exception Management Service
11. Driver/Dock Mobile API
12. Analytics Service
13. Integration API
```

### 13.2 High-Level Architecture

```text
RFID / Barcode / Camera / GPS
        ↓
IoT Gateway / Mobile API
        ↓
Event Bus
        ↓
Event Store
        ↓
Operational Twin
        ↓
Optimization Input Builder
        ↓
Optimizer
        ↓
Plan Validator
        ↓
Execution Plan
        ↓
Driver App / Dock App / WMS / TMS
```

---

## 14. Recommended Technology Stack

### 14.1 Core Backend

Recommended:

- Java/Kotlin, C#, Go, or Rust for backend services.
- Python acceptable for optimization prototypes.
- PostgreSQL for transactional state.
- PostGIS for geospatial hub/lane queries.
- Redis for live operational state.
- Kafka, Redpanda, Pulsar, or NATS for event streaming.
- ClickHouse, TimescaleDB, or InfluxDB for telemetry and analytics.

### 14.2 Optimization

Initial:

- OR-Tools for routing prototype.
- Custom greedy + local search for trailer loading.
- Min-cost flow implementation for freight assignment.

Later:

- Gurobi for MILP benchmark and smaller exact subproblems.
- Timefold for constraint-based planning if JVM stack is preferred.
- Custom ALNS/tabu search for large-scale production optimization.
- Simulation engine for what-if scenarios.

### 14.3 IoT / Sensor Infrastructure

Options:

- AWS IoT Core
- Azure IoT Hub
- MQTT broker
- Edge gateway in trailer or hub
- RFID readers and dock-door portals
- Trailer antennas
- Camera at loading dock
- Mobile scanning apps

### 14.4 Digital Twin Options

Recommended initial approach:

- Build custom operational twin using domain entities and event projections.

Optional later:

- AWS IoT TwinMaker
- Azure Digital Twins
- Custom graph model
- Simulation/digital twin for what-if analysis

---

## 15. APIs and Contracts

### 15.1 Package Scan Event

```json
{
  "eventType": "PackageScanned",
  "packageId": "P123",
  "hubId": "H7",
  "locationType": "dock_door",
  "locationId": "DOCK-12",
  "timestamp": "2026-06-18T14:00:00Z",
  "scanSource": "barcode"
}
```

### 15.2 Trailer Departure Event

```json
{
  "eventType": "TrailerDeparted",
  "trailerId": "T42",
  "fromHub": "H7",
  "toHub": "H9",
  "tripId": "TRIP-991",
  "timestamp": "2026-06-18T15:00:00Z"
}
```

### 15.3 Load Plan

```json
{
  "planId": "LP-10001",
  "trailerId": "T42",
  "route": ["H7", "H8", "H9", "H10"],
  "targetUtilization": 0.80,
  "estimatedUtilization": 0.83,
  "slices": [
    {
      "sliceIndex": 0,
      "zone": "rear",
      "loadBlocks": ["LB-H8-001", "LB-H8-002"]
    },
    {
      "sliceIndex": 1,
      "zone": "middle",
      "loadBlocks": ["LB-H9-001"]
    },
    {
      "sliceIndex": 2,
      "zone": "nose",
      "loadBlocks": ["LB-H10-001"]
    }
  ],
  "violations": [],
  "score": {
    "rehandleCost": 0,
    "utilizationPenalty": 0.01,
    "slaRisk": 0.02
  }
}
```

### 15.4 Exception Event

```json
{
  "eventType": "LoadPlanViolationDetected",
  "trailerId": "T42",
  "packageId": "P123",
  "expectedZone": "rear",
  "observedZone": "middle",
  "confidence": 0.78,
  "severity": "warning",
  "recommendedAction": "recheck_before_departure"
}
```

---

## 16. Driver and Dock Worker UX

### 16.1 Dock Loading View

The dock worker should see:

```text
Trailer T42
Route: H7 → H8 → H9 → H10

Load order:
1. Nose: H10 freight
2. Middle: H9 freight
3. Rear: H8 freight
```

### 16.2 Alert Examples

```text
Warning:
Package P123 is assigned to Hub H8 but appears to be in middle zone.
Expected rear zone.
Please verify before departure.
```

```text
Critical:
LoadBlock LB-H8-001 is blocked by H10 freight.
Estimated rehandle time: 18 minutes.
Recommended action: move H10 block deeper or reassign H8 block to rear.
```

### 16.3 Human Override

A human operator can override:

- Load assignment
- Trailer assignment
- Hold/ship decision
- Rehandle acceptance
- Over-carry decision

Every override must capture:

```text
who
when
what changed
reason
system recommendation at the time
```

---

## 17. Exception Handling

### 17.1 Wrong Trailer

Detected when RFID/barcode scan shows package in trailer not assigned by plan.

Action:

1. Alert dock worker.
2. Block departure if severity high.
3. Create exception event.
4. Recompute affected load block.

### 17.2 Missed Unload

Detected when package destined for current hub remains observed in trailer after departure.

Action:

1. Mark missed unload.
2. Compute downstream recovery plan.
3. Decide whether to return, cross-dock, over-carry, or transfer.
4. Update SLA risk.

### 17.3 Low Utilization

Detected when trailer is below target utilization.

Action:

1. Search for compatible additional load blocks.
2. Check SLA and LIFO feasibility.
3. Add blocks if cost-positive.
4. Otherwise allow departure with penalty.

### 17.4 Blocked Freight

Detected during planning or sensor validation.

Action options:

1. Reorder load.
2. Split load block.
3. Assign to another trailer.
4. Hold at hub.
5. Allow controlled rehandle.
6. Over-carry to later hub.

---

## 18. Digital Twin Strategy

### 18.1 Operational Twin

Required from MVP.

Purpose:

- Current state of packages, trailers, hubs, docks, and load blocks.
- Updated by event stream.
- Used by optimization engine.
- Used by dashboards and exception handling.

### 18.2 Planning Twin

Required from MVP.

Purpose:

- Sandbox copy of operational state.
- Allows optimizer to test candidate plans.
- No direct operational side effects until plan is accepted.

### 18.3 Simulation Twin

Recommended after MVP.

Purpose:

- What-if simulation.
- Policy testing.
- Hub congestion modeling.
- Trailer utilization policy testing.
- RFID reliability simulation.
- SLA impact analysis.

### 18.4 3D Visual Twin

Optional later.

Purpose:

- Visual inspection.
- Training.
- High-fidelity loading simulation.
- Robotics or automated loading support.

Not required for initial business value.

---

## 19. MVP Scope

### 19.1 MVP Features

1. Package and load block data model.
2. Trailer rear-to-nose slice model.
3. Event ingestion for scans and trailer movements.
4. Basic operational twin projection.
5. Load block aggregation.
6. Simple route-aware LIFO load planning.
7. Rehandle risk scoring.
8. Trailer utilization scoring.
9. Dock-door RFID/barcode validation.
10. Driver/dock loading instructions.
11. Exception alerts.
12. Human override with audit.
13. Basic dashboard.

### 19.2 MVP Exclusions

1. Full 3D packing.
2. Full national optimization.
3. Real-time precise package localization.
4. ML-based sensor fusion.
5. Full simulation twin.
6. Fully automated routing dispatch.
7. Complex dock scheduling optimization.

---

## 20. Recommended Implementation Phases

## Phase 0: Discovery and Data Audit

Duration: 2–4 weeks

Goals:

- Understand current hub operations.
- Map package lifecycle.
- Identify current WMS/TMS integration points.
- Collect trailer dimensions and loading practices.
- Collect historical shipment and route data.
- Define SLA classes.
- Define utilization and rehandle KPIs.
- Identify pilot hubs and routes.

Deliverables:

- Current process map.
- Data availability report.
- Initial domain model.
- Pilot scope.
- Baseline KPIs.
- RFID/barcode feasibility assessment.

---

## Phase 1: Operational Data Foundation

Duration: 4–8 weeks

Goals:

- Implement event model.
- Implement core entities.
- Build package/trailer/hub state projections.
- Integrate barcode scans and existing package events.
- Implement basic dashboard.

Deliverables:

- Event store.
- Package state service.
- Trailer state service.
- Hub inventory projection.
- Basic API.
- Audit timeline.

Success Criteria:

- System can answer “where was package last seen?”
- System can answer “what is currently assigned to trailer T?”
- System can reconstruct package movement history.

---

## Phase 2: Load Block and Trailer Slice MVP

Duration: 4–8 weeks

Goals:

- Implement load block aggregation.
- Implement trailer slice model.
- Implement basic LIFO load planner.
- Implement rehandle score.
- Implement utilization score.
- Generate loading instructions.

Deliverables:

- LoadBlock service.
- Trailer load planner.
- LIFO validator.
- Loading plan API.
- Dock/driver load view.

Success Criteria:

- System generates route-aware trailer loading plan.
- System identifies blocked freight before departure.
- System scores trailer utilization.
- Operators can follow loading sequence.

---

## Phase 3: RFID-Assisted Validation

Duration: 6–10 weeks

Goals:

- Install RFID portals at selected dock doors.
- Optionally install trailer-zone antennas.
- Ingest RFID observations.
- Map RFID tag IDs to package IDs.
- Validate planned vs observed loading.

Deliverables:

- RFID ingestion service.
- Sensor observation schema.
- Package location confidence model.
- Wrong-trailer detection.
- Wrong-zone warning.
- Missed-unload detection.

Success Criteria:

- System catches wrong-trailer events.
- System detects packages that should have been unloaded.
- System provides confidence-scored zone observations.

---

## Phase 4: Rolling Optimizer

Duration: 8–12 weeks

Goals:

- Implement rolling-horizon planning.
- Add min-cost flow freight assignment.
- Add simple VRP/trailer assignment.
- Add local repair logic.
- Add freeze windows.
- Add over-carry/hold/reassign decisions.

Deliverables:

- Optimization input builder.
- Rolling planning service.
- Candidate plan evaluator.
- Plan validation and repair engine.
- Operator approval workflow.

Success Criteria:

- System recommends trailer assignment changes.
- System recommends hold/reassign/over-carry actions.
- System improves rehandle and utilization KPIs in pilot.

---

## Phase 5: Simulation and Advanced Optimization

Duration: 12+ weeks

Goals:

- Build simulation twin.
- Run what-if policy tests.
- Train demand forecasts.
- Improve ETA forecasts.
- Add ALNS/tabu/local search for large-scale optimization.
- Add ML-based RFID confidence scoring.

Deliverables:

- Simulation engine.
- Forecasting models.
- Advanced optimizer.
- Scenario dashboard.
- KPI impact reports.

Success Criteria:

- System can simulate operational policy changes.
- System predicts hub congestion.
- System optimizes larger hub subnetworks.
- System reduces SLA failures and rehandle at scale.

---

## 21. KPIs

### 21.1 Operational KPIs

- Trailer utilization
- Empty miles
- On-time departure
- On-time arrival
- Dock dwell time
- Driver unload/reload time
- Average packages touched per shipment
- Rehandle count
- Rehandle minutes
- Missed unload count
- Wrong trailer count
- SLA violation rate

### 21.2 Optimization KPIs

- Plan score
- Rehandle score
- Utilization penalty
- SLA risk score
- Solver runtime
- Plan acceptance rate
- Human override rate
- Forecast accuracy
- RFID confidence accuracy

### 21.3 Financial KPIs

- Cost per package moved
- Cost per trailer trip
- Labor minutes saved
- Damage claims reduction
- SLA penalty reduction
- Fuel/miles reduction
- Dock throughput improvement

---

## 22. Risks and Mitigations

### Risk 1: RFID Read Reliability

RFID may fail due to package orientation, liquids, metals, occlusion, or multipath.

Mitigation:

- Treat RFID as probabilistic.
- Use dock-door portals first.
- Use barcode and camera as fallback.
- Use confidence scoring.
- Do not depend on exact package coordinates.

### Risk 2: Optimization Complexity

Full network optimization may be computationally intractable.

Mitigation:

- Decompose problem.
- Optimize load blocks, not individual packages.
- Use rolling horizon.
- Use heuristics and local repair.
- Use exact solvers only for small subproblems or benchmarks.

### Risk 3: Human Workflow Resistance

Drivers and dock workers may reject complex instructions.

Mitigation:

- Keep instructions simple.
- Use clear trailer zones.
- Provide explainable alerts.
- Allow human override.
- Measure override reasons.

### Risk 4: Bad Data Quality

Incorrect dimensions, missing scans, or delayed events can degrade planning.

Mitigation:

- Confidence scoring.
- Exception handling.
- Data quality dashboards.
- Conservative planning rules.
- Reconciliation jobs.

### Risk 5: Integration Complexity

Existing WMS/TMS systems may be incomplete or inconsistent.

Mitigation:

- Start with pilot lanes.
- Use event adapters.
- Avoid replacing legacy systems initially.
- Provide read-only integration first.
- Gradually introduce command APIs.

---

## 23. Recommended Pilot

### Pilot Scope

Start with:

- 2–4 hubs
- 5–10 recurring linehaul routes
- 20–50 trailers
- One or two SLA classes
- RFID/barcode validation at dock doors
- Trailer loading modeled by zones, not full 3D

### Pilot Goals

1. Establish baseline KPIs.
2. Generate load plans.
3. Compare planned vs actual loading.
4. Detect wrong-trailer events.
5. Detect blocked freight before departure.
6. Reduce rehandle events.
7. Improve utilization without hurting SLA.

### Pilot Duration

Recommended:

```text
8–16 weeks
```

### Pilot Exit Criteria

- 10%+ reduction in rehandle events.
- 5%+ improvement in trailer utilization or maintained utilization with lower rehandle.
- 20%+ reduction in wrong-trailer or missed-unload events on pilot lanes.
- Operator acceptance rate above 70%.
- Plan generation within operational time limits.
- Full package audit trail available.

---

## 24. Recommended MVP Backlog

### Epic 1: Domain Model

- Package entity
- Hub entity
- Trailer entity
- Dock door entity
- Load block entity
- Trailer slice entity
- Route/trip entity

### Epic 2: Event Platform

- Event schema
- Event ingestion API
- Event store
- Package projection
- Trailer projection
- Hub projection

### Epic 3: Load Block Aggregation

- Group packages by destination/SLA/deadline
- Compute volume/weight
- Split oversized or incompatible blocks
- Assign block priority

### Epic 4: Trailer Load Planner

- Route unload order map
- Rear-to-nose trailer model
- LIFO validation
- Partial-LIFO scoring
- Utilization scoring
- Load plan output

### Epic 5: Execution UI

- Dock loading view
- Driver unload view
- Exception alerts
- Human override
- Audit reason capture

### Epic 6: RFID/Barcode Validation

- RFID event ingestion
- Tag-to-package mapping
- Dock-door validation
- Trailer-zone observation
- Wrong-trailer alert
- Missed-unload alert

### Epic 7: Rolling Optimization

- Optimization input builder
- Local scope detection
- Freight assignment
- Trailer reassignment
- Hold/reassign/over-carry recommendations
- Freeze window logic

### Epic 8: Analytics

- KPI dashboard
- Rehandle dashboard
- Utilization dashboard
- SLA risk dashboard
- Sensor confidence dashboard
- Override analysis

---

## 25. Strategic Evolution

### Stage 1: Visibility

Know what is where.

### Stage 2: Validation

Know whether reality matches the plan.

### Stage 3: Recommendation

Suggest better load and route decisions.

### Stage 4: Optimization

Continuously optimize trailer usage and hub flows.

### Stage 5: Simulation

Test policies before operational rollout.

### Stage 6: Automation

Integrate with robotic loading, autonomous yard management, and advanced forecasting.

---

## 26. Final Recommendation

The recommended approach is to build a practical operational twin and rolling optimizer before investing in a full high-fidelity digital twin.

The system should model trailers as ordered rear-to-nose sequences of load blocks. It should treat RFID as probabilistic sensor evidence. It should optimize freight flow through a time-expanded hub network, use route-aware LIFO loading, and continuously repair plans as reality changes.

The first business value should come from:

1. Reducing wrong-trailer loading.
2. Reducing blocked freight.
3. Reducing rehandle time.
4. Improving trailer utilization.
5. Improving visibility and auditability.
6. Giving operators explainable, actionable load plans.

A full digital twin becomes valuable later, once the operational data foundation is strong enough to support simulation, forecasting, and scenario testing.
