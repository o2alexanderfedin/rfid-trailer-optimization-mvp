#!/usr/bin/env tsx
/**
 * DET-02 — Reproducibility-first golden capture protocol.
 *
 * Runs the target scenario in-process twice AND forks 2 separate node/tsx child
 * processes, asserts all 4 SHA-256 hashes match, then prints the confirmed hash
 * ready to paste into goldens.ts.
 *
 * Usage:
 *   pnpm exec tsx scripts/capture-golden.ts [seed] [durationTicks]
 *   pnpm exec tsx scripts/capture-golden.ts 42 10000
 *
 * Default: seed=42, durationTicks=10000 (the FLAGS_OFF canonical config).
 * When both defaults are used, a self-test asserts the FLAGS_OFF golden matches.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { simulate } from "../packages/simulation/src/engine.js";
import { FLAGS_OFF_GOLDEN_SHA256 } from "../packages/simulation/test/goldens.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sha(stream: ReturnType<typeof simulate>): string {
  return createHash("sha256").update(JSON.stringify(stream)).digest("hex");
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const seed = parseInt(process.argv[2] ?? "42", 10);
const durationTicks = parseInt(process.argv[3] ?? "10000", 10);
const opts = { seed, durationTicks } as const;

// ---------------------------------------------------------------------------
// WORKER MODE — child process emits only the hash and exits
// ---------------------------------------------------------------------------

if (process.env["CAPTURE_WORKER"] === "1") {
  process.stdout.write(sha(simulate(opts)) + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// PARENT MODE — 4-way reproducibility check
// ---------------------------------------------------------------------------

console.log(`[capture-golden] seed=${seed} durationTicks=${durationTicks}`);
console.log("[capture-golden] running in-process ×2 …");

const h1 = sha(simulate(opts));
const h2 = sha(simulate(opts));

// Self-invocation path for child processes
const scriptPath = fileURLToPath(import.meta.url);
const workerEnv = { ...process.env, CAPTURE_WORKER: "1" };
const args = [scriptPath, String(seed), String(durationTicks)];

console.log("[capture-golden] spawning child process ×2 …");

const r1 = spawnSync(process.execPath, ["--import", "tsx/esm", ...args], { env: workerEnv, encoding: "utf8" });
const r2 = spawnSync(process.execPath, ["--import", "tsx/esm", ...args], { env: workerEnv, encoding: "utf8" });

if (r1.status !== 0 || r1.error !== undefined) {
  console.error("[capture-golden] child process 1 failed:", r1.stderr ?? r1.error);
  process.exit(1);
}
if (r2.status !== 0 || r2.error !== undefined) {
  console.error("[capture-golden] child process 2 failed:", r2.stderr ?? r2.error);
  process.exit(1);
}

const h3 = r1.stdout.trim();
const h4 = r2.stdout.trim();

// Assert all 4 match
const hashes: [string, string][] = [
  ["in-process run 1", h1],
  ["in-process run 2", h2],
  ["child process 1", h3],
  ["child process 2", h4],
];

let allMatch = true;
for (const [label, h] of hashes) {
  if (h !== h1) {
    console.error(`[capture-golden] MISMATCH: ${label} hash differs`);
    console.error(`  expected: ${h1}`);
    console.error(`  got:      ${h}`);
    allMatch = false;
  }
}

if (!allMatch) {
  console.error("[capture-golden] REPRODUCIBILITY FAILURE — do NOT bake this hash as a golden");
  process.exit(1);
}

// Self-test: when using the canonical FLAGS_OFF config, assert the committed golden
if (seed === 42 && durationTicks === 10000) {
  if (h1 !== FLAGS_OFF_GOLDEN_SHA256) {
    console.error("[capture-golden] SELF-TEST FAILED — hash does not match FLAGS_OFF_GOLDEN_SHA256");
    console.error(`  expected: ${FLAGS_OFF_GOLDEN_SHA256}`);
    console.error(`  got:      ${h1}`);
    process.exit(1);
  }
  console.log("[capture-golden] self-test: matches FLAGS_OFF golden — capture tooling is wired correctly");
}

console.log(`[capture-golden] CONFIRMED SHA-256: ${h1}`);
