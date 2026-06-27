/**
 * DET-02 CANONICAL HOME — the single auditable source of truth for all v3.0
 * golden SHA-256 constants.
 *
 * IMPORT THIS FILE everywhere a test needs a golden constant.  A refactor typo
 * here will fail EVERY determinism test loudly — "one place to audit" is the
 * keystone of the DET-02 consolidation (Phase 28 plan 01).
 *
 * Rules:
 *   - No imports.  This file is a pure-data leaf so any test can import it
 *     without pulling in engine code.
 *   - No default export.  Only named exports.
 *   - Never edit a constant without running the full determinism suite green
 *     before committing (reproducibility-first protocol below).
 */

/**
 * CAPTURE PROVENANCE
 * ──────────────────
 * Architecture environments where each golden was captured and verified green:
 *
 *   FLAGS_OFF  (3920accc) — x86_64 darwin, 6172 events, node v22 LTS
 *   OODA_ON    (94689f99) — x86_64 darwin, 9170 events, node v22 LTS
 *   CONTINENTAL (8f91b13f) — x86_64 darwin, node v23 (topology artifact,
 *                             NOT a simulate() run hash, centerCount=4 fixture)
 *   COORDINATOR_ON (edfa5a6d) — arm64 darwin; flags-off 3920accc and OODA-on
 *                               94689f99 verified GREEN on this arm64 host
 *                               (Math.exp/Math.log float path is arch-stable).
 *   OPTIMIZER_ON   (162efbd8) — arm64 darwin; prior 3 goldens verified GREEN.
 *
 * Cross-arch contingency (RESEARCH VQ#9 / PITFALLS Pitfall 3):
 *   `sampleLogNormal` uses `Math.exp`/`Math.log`, which are implementation-
 *   defined and could diverge by 1 ULP after thousands of iterations.  If a
 *   multi-arch CI run produces a DIFFERENT hash, the contingency is to replace
 *   the log-normal sampler with an integer lookup table (LUT).  Do NOT do this
 *   unless the hash actually fails on CI — the float path is empirically
 *   arch-stable on x86_64 + arm64 darwin so far.
 *
 * Reproducibility-first protocol (mandatory before baking any new golden):
 *   1. Run the scenario TWICE IN THE SAME PROCESS and assert the two hashes
 *      match (guards module-level state leaks).
 *   2. Run the scenario ACROSS TWO SEPARATE node PROCESSES and assert they
 *      match (guards any process-level state initialisation).
 *   3. Only after both in-process AND cross-process agreement, commit the
 *      literal.  Never commit a non-reproducible golden.
 *
 * Per-golden capture configs (brief):
 *   FLAGS_OFF   — simulate({ seed: 42, durationTicks: 10000 }), no v3.0 flags
 *   OODA_ON     — same + oodaAgentsEnabled/hos/fuel/induction/consolidation
 *   COORDINATOR_ON — same as OODA_ON + coordinatorsEnabled (rule-based)
 *   OPTIMIZER_ON   — same as COORDINATOR_ON + coordinatorUsesOptimizer: true
 *   CONTINENTAL    — continentalArtifact() over a 14-hub fixture (not simulate())
 */

/**
 * FLAGS_OFF_GOLDEN_SHA256
 *
 * Phase 19 / DET-02 (plan 19-03 GREEN).
 * Config: simulate({ seed: 42, durationTicks: 10000 }) — no v3.0 flags.
 * Captured on x86_64 darwin; 6172 events.
 * This is the keystone "flags-off" constant that EVERY new flag's two-part
 * gate asserts byte-identical to when the flag is absent or explicitly false.
 */
export const FLAGS_OFF_GOLDEN_SHA256 =
  "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861";

/**
 * OODA_ON_GOLDEN_SHA256
 *
 * Phase 24 / OODA-04 (plan 24-04 GREEN).
 * Config: simulate({ seed: 42, durationTicks: 10000, oodaAgentsEnabled: true,
 *   hosEnabled: true, fuel: FUEL_ON, inductionEnabled: true,
 *   consolidationEnabled: true }) — full Phase-24 all-on stack.
 * Captured on x86_64 darwin; 9170 events.
 * Differs from FLAGS_OFF (the OODA model changed the decisions).
 */
export const OODA_ON_GOLDEN_SHA256 =
  "94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608";

/**
 * COORDINATOR_ON_GOLDEN_SHA256
 *
 * Phase 25 / COORD-04 (plan 25-02 GREEN).
 * Config: Phase-24 all-on stack + coordinatorsEnabled: true (rule-based reroute).
 * Captured on arm64 darwin; 61128 events.
 * Differs from FLAGS_OFF and OODA_ON (the coordinator advise/accept/reject
 * handshake changed the decisions).
 */
export const COORDINATOR_ON_GOLDEN_SHA256 =
  "edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc";

/**
 * OPTIMIZER_ON_GOLDEN_SHA256
 *
 * Phase 26 / COORD-06, updated P27-A (plan 27-04 GREEN — 3 pins removed).
 * Config: Phase-25 all-on coordinator stack + coordinatorUsesOptimizer: true.
 * Captured on arm64 darwin.
 * Differs from COORDINATOR_ON (route-aware divergence after pin removal in P27-04:
 * the optimizer now chooses a genuinely different least-congested relief spoke and
 * can DECLINE over-capacity reroutes — reroute 7378 vs rule-based 9553).
 */
export const OPTIMIZER_ON_GOLDEN_SHA256 =
  "162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233";

/**
 * CONTINENTAL_GOLDEN_SHA256
 *
 * Phase 23 / DET-01 (plan 23-05 GREEN).
 * Config: continentalArtifact() over a fixed 14-hub fixture (centerCount=4).
 * This is NOT a simulate() run hash — it is the pure continental topology
 * artifact (centers + spoke→center assignment + near-full-mesh backbone +
 * Route[] + per-leg transit params).
 * Captured on x86_64 darwin, node v23.
 */
export const CONTINENTAL_GOLDEN_SHA256 =
  "8f91b13f06e8481b5d80f0beb3c36b9307abad21242bdc1696b8769175db6644";
