# Phase 18: README features + screenshots - Context

**Gathered:** 2026-06-22
**Status:** Ready for planning
**Mode:** Auto-generated (final phase; includes the live-demo HOS enablement needed for the feature to be visible)

<domain>
## Phase Boundary

Make the v1.2 driver-HOS feature **visible in the running demo**, then document it: enable HOS in the live app, capture real screenshots of the live map + Hub Detail panel showing driver duty, and update `README.md` with the supported-features list + those screenshots.

**In scope:** the live-demo HOS enablement (prerequisite), DOC-01 (features list), DOC-02 (screenshots). **OUT of scope:** none — this is the last phase.
</domain>

<decisions>
## Implementation Decisions

### Prerequisite — enable HOS in the LIVE demo (so the feature is visible)
- HOS was built **opt-in, default OFF** (to keep the unit determinism golden byte-identical). The **running app** (`packages/api/src/main.ts` → `driveSimulationPaced` → `buildServer`/sim engine) currently runs with HOS OFF, so the demo produces **no driver data** and the Hub Detail panel shows no driver duty. **Enable `hosEnabled: true` (+ `DEFAULT_HOS_CONFIG`) on the LIVE demo path** so driver assignment, HOS accrual, relay, and load/unload events flow → `driver_status` populated → `GET /api/hubs/:id/detail` + ws driver buckets carry real data → the panel + map show the v1.2 hero feature.
- **Do NOT touch the unit determinism golden tests** — they explicitly pass the default (HOS-off) config and MUST stay byte-identical. Only the live runnable demo turns HOS on. Fix any `chromium-real` e2e / api-integration assertions that change because the live stream now contains driver events (update them to reflect HOS-on; keep them green).

### DOC-01 — README features
- Update `README.md` (currently ~95 lines) with a **Supported Features** section spanning v1.0–v1.2: event-sourced operational twin + deterministic replay; route-aware LIFO load planner + independent validator; probabilistic RFID validation; rolling-horizon optimizer (min-cost-flow + VRPTW + HOS-enforced); realistic ORS time model; **driver Hours-of-Service (full FMCSA) with relay/swap at hubs**; live USA-map visualization; **clickable Hub Detail panel** (trucks at hub: status, dwell, cargo, next hop, driver duty + remaining legal drive time). Keep it accurate to the shipped code.

### DOC-02 — screenshots (real, from the running UI)
- Capture real PNG screenshots and embed them in the README: (a) the **live USA map** with trailers animating + hubs colored by driver duty; (b) the **Hub Detail panel** opened on a hub click, showing the compact rows with driver duty + remaining legal drive time; (c) (nice-to-have) a row's click-through to the VIZ-05 trailer plan.
- **Preferred capture path:** the existing `chromium-real` Playwright harness (`packages/web/playwright.config.ts`, gated `MM_E2E_REAL=1` — its `globalSetup` boots the real backend; webServer builds + `preview:real`). Add a Playwright spec that navigates the running app, waits for live data, clicks a hub, and `page.screenshot()`s the map + panel into `docs/screenshots/` (or `images/`).
- **Fallback (if full-stack capture is too fragile in this environment):** render the `MapView` (with duty coloring) and `HubDetail` panel via the existing vitest **browser** (Chromium) harness with representative driver-HOS data (the `MapView.browser.test.tsx` + MSW pattern) and screenshot those — still genuine UI renders. Document which path was used.

### Claude's Discretion
Screenshot dir name, exact README structure, whether the live-HOS flag is an env var (e.g. `HOS_ENABLED`) or hardcoded-on for the demo — follow project conventions. Prefer a clear, simple toggle.
</decisions>

<code_context>
## Existing Code Insights

### Reuse / integration points
- `packages/api/src/main.ts` (~L78 calls `driveSimulationPaced({...})`), `packages/api/src/sim/driver.ts` (`driveSimulationPaced` ~L431), `packages/api/src/server.ts` (`buildServer` — passes sim config) — where to enable `hosEnabled`.
- `packages/simulation` `hosEnabled`/`hosConfig` flag (Phase 11) + `@mm/domain` `DEFAULT_HOS_CONFIG`.
- `packages/web/playwright.config.ts` (`chromium-real` project, `MM_E2E_REAL=1`, `globalSetup` boots backend), `vite.preview-real.config.ts`, the web e2e specs — the real-stack screenshot harness.
- `GET /api/hubs/:id/detail` + ws driver buckets (Phase 14); `HubDetail.tsx` panel + duty coloring (Phase 17).
- `docker-compose.yml` (postgres:17) — the live stack's DB.

### Established Patterns
- `main.ts` migrates both schemas, listens, then drives the paced deterministic demo + rolling optimizer; deterministic event generation (seed) with wall-clock pacing only for broadcast; the `chromium-real` e2e is the one real web↔server test.
</code_context>

<specifics>
## Specific Ideas

Reqs: **DOC-01, DOC-02**. The **most important** part is the prerequisite: enabling HOS on the live demo path so the v1.2 feature is actually visible (otherwise screenshots show nothing new). Keep the unit determinism goldens untouched/green. Grounding for the run topology: `packages/api/src/main.ts` docstring.

**Note:** Do NOT edit `.planning/ROADMAP.md` or `.planning/REQUIREMENTS.md` — the orchestrator manages those.
</specifics>

<deferred>
## Deferred Ideas
- None — final phase of v1.2.
</deferred>
