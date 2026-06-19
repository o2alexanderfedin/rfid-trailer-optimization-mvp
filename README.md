# RFID-Assisted Middle-Mile Trailer Optimization Platform

A logistics optimization MVP for a hub-and-spoke middle-mile truck network. It models
trailers as rear-to-nose ordered load blocks, treats RFID as probabilistic sensor
evidence, and continuously re-optimizes hub-to-hub freight flow to reduce package
rehandling, blocked freight, and missed connections — while keeping trailers well
utilized.

This repository is the **MVP build**: a simulation-driven system with an event-sourced
operational twin, a rolling-horizon optimizer, and a **realtime USA-map visualization**
of trailers, hubs, and freight flow.

## Scope (v1)

Covers the spec's Phases 1–4:

1. **Operational data foundation** — event sourcing + projections (where is package X / what's on trailer T).
2. **Load planning** — load-block aggregation, route-aware LIFO trailer load planner, rehandle & utilization scoring.
3. **RFID-assisted validation** — confidence-scored location, wrong-trailer & missed-unload detection.
4. **Rolling optimizer** — min-cost flow freight assignment, VRP routing, local repair, freeze windows.

Plus a **simulation engine** that generates realistic events and a **minimal web UI**
centered on a live OpenLayers/OpenStreetMap visualization of the USA network.

See [`rfid_middle_mile_trailer_optimization_tech_spec.md`](rfid_middle_mile_trailer_optimization_tech_spec.md)
for the full technical specification.

## Stack

- **Backend:** TypeScript / Node.js
- **Database:** PostgreSQL
- **Frontend:** TypeScript + OpenLayers (OpenStreetMap tiles)
- **Optimization:** custom greedy + local search, min-cost flow, VRP

## Setup

```bash
git clone <repository-url>
cd intelliswift
```

(Setup instructions are filled in as the project is built.)

## Development

This project uses **git-flow**. Protected branches (`main`, `develop`) reject direct
commits — work happens on `feature/*`, `release/*`, `hotfix/*`, and `bugfix/*` branches.

```bash
git flow feature start <feature-name>
# ...make changes...
git flow feature finish <feature-name>
```

## Planning

Project planning artifacts (managed by GSD) live in [`.planning/`](.planning/):
`PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and research notes.

## License

[Add license information]
