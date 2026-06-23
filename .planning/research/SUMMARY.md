# v1.2 Research Summary — Driver HOS & Hub Detail

> Supersedes prior-milestone research (the v1.1 version is in git history; `STACK.md`/`FEATURES.md`/`ARCHITECTURE.md`/`PITFALLS.md` in this dir are v1.1-era). Full v1.2 detail: `v1.2-DRIVER-HOS-GROUNDING.md` and `v1.2-HUB-DETAIL-GROUNDING.md` (adversarially-verified codebase + FMCSA analysis, 31 agents).

## Scope (locked)

A single v1.2 milestone delivering, end-to-end: **driver Hours-of-Service, fully enforced in sim + optimizer, full FMCSA rules, with driver relay/swap at hubs** — plus authoritative load/unload phase events and a **Hub Detail panel** surfacing live hub operations including driver duty.

## Verified reality (drives phase build-order)

- **No driver/crew/tractor concept exists today** — the twin moves bare trailers. Driver is net-new across every layer: `@mm/domain` (entity + events) → `@mm/simulation` (duty clocks, rest injection) → `@mm/projections` (driver read-model) → `@mm/optimizer` (HOS feasibility) → `@mm/api`/`@mm/web` (panel).
- **13 domain events today, zero driver events**; the closed union + `contract.assert.ts` + every exhaustive reducer switch change in lockstep.
- **Simulation has 4 isolated seeded RNG substreams** (salts `0x5f1da7c3`, `0x3ca71d5f`, `0x00007717`); HOS adds a 5th, collision-asserted.
- **The optimizer is currently pure (never draws RNG).** HOS enforcement folds cleanly as `restMin → serviceMin` (rest-as-time, **no new graph edge kind**); the hard legal-drive gate reuses the proven **Phase-2 LIFO validation pattern**.
- **One pure forward-labeling HOS engine in `@mm/domain`, shared by sim + optimizer** (DRY). The FMCSA 14h window is **elapsed wall-clock** (absolute deadline; must NOT pause for breaks) — the prime correctness trap.

## 🔑 Keystone constraint — determinism

Byte-identical golden-replay guards the whole project. **HOS-off must stay byte-identical to the pre-v1.2 golden; HOS-on gets a new golden.** Every HOS draw flows through the new substream in deterministic queue order; reducers key off `occurredAt`, never wall-clock. Any drift breaks the gate — the highest-risk thread; lock it in early (HOS engine + sim phases) with goldens before the optimizer touches HOS.

## Hub Detail panel — data availability (verified)

Most data is already in the twin but needs a new **`GET /api/hubs/:id/detail`** REST endpoint (ws can't carry the heavy DTO). Reuse: `trailer_state` projection (trailers-at-hub), `plan-detail.ts` `planLoad` reconstruction (cargo/util), VIZ-05 `TrailerDetail.tsx` (panel pattern), `MapView`/`layers.ts` (hub features already clickable). Corrections baked into REQUIREMENTS: dwell from `audit_timeline` (NOT `last_event_at`); utilization is slice-based `Σ usedVolume/Σ capacityVolume`; ws exception `entityId` carries only `trailerId`; an index on `trailer_state(current_hub_id)` is needed.

## Suggested phase shape (≈10 phases, continue from Phase 8)

Domain (driver + HOS config + events) → shared HOS engine → sim enforcement + relay + load/unload events + goldens → driver-status projection → hub-detail endpoint + ws buckets → optimizer HOS-aware → optimizer HOS-enforced → Hub Detail panel UI + map styling → README + screenshots. Order so domain + HOS engine + deterministic sim land before optimizer enforcement (highest risk) and before the UI (consumes the endpoint).

## Effort & risk

Adversarial verification rated the full build **EPIC (~3–5 weeks)**; optimizer HOS-enforcement is the single riskiest slice. No-MILP constraint holds — HOS as heuristic feasibility checks (Goel & Kok forward-labeling is polynomial).

## Requirement categories

`DRV-*` driver model · `HOS-*` clock engine · `EVT-*` duty + phase events · `SIM-HOS-*` sim enforcement + relay + goldens · `PRJ-*` driver projection · `OPT-HOS-*` optimizer awareness + enforcement · `HUBQ-*` hub-detail read/API · `VIZ-07..11` panel + map · `DOC-*` README + screenshots. (See `REQUIREMENTS.md`.)
