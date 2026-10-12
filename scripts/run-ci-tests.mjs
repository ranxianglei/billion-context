#!/usr/bin/env node
// #2816: CI test scheduling. Baseline logs prove the old runner default
// (availableParallelism()-1) was ALREADY concurrent: the sum of per-test
// durations (~630s ubuntu / ~1110s windows) fits inside the step wall
// (373s / 688s) only if several files ran at once. This pins concurrency=4
// explicitly. A two-phase prototype (serial "live" phase + concurrent pool)
// was measured first: the serial phase idled the other cores for 3-4 min
// without buying stability — live/process suites have run mixed with the rest
// on dedicated runners for months without #1248-class flakes (#1248 gates
// loaded local sandboxes via env, not CI), and 4 slots dilute live-live
// pairing (P(two live in flight) ≈ C(4,2)·(32/613)² ≈ 5%, vs ≈ 8% at the old
// c=3). Same tests, assertions and env as `npm test` — only the scheduler
// changes. Local `npm test` is untouched (this script is CI-only).
//
// LIVE_FILES is a tripwire, not a gate: every process-spawning suite must be
// registered there so adding a new one fails the job until someone reviews
// its concurrency assumptions (#1248) instead of silently riding c=4.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const testsDir = join(root, "tests");

// Process-spawning suites (grep ground truth: spawn/exec*/child_process/Worker
// references below). Conservative by design — a false positive just costs a
// registration entry; an unregistered spawner fails the job by design. New
// spawning suites MUST be added here after reviewing their concurrency
// assumptions.
const LIVE_FILES = [
    "tests/auto-restart.test.ts",
    "tests/build-info.test.ts",
    "tests/cache-theorem.test.ts",
    "tests/claude-native.test.ts",
    "tests/e2e-plugin-tool-routing.test.ts",
    "tests/graceful-close.test.ts",
    "tests/hermes-native.test.ts",
    "tests/hook-command.test.ts",
    "tests/index-entry-guard.test.ts",
    "tests/issue1958-routed-warn.test.ts",
    "tests/issue2752-forward-partial-outcome.test.ts",
    "tests/issue760-percall-conversation.test.ts",
    "tests/issue927-opencode-install.test.ts",
    "tests/kimi-native.test.ts",
    "tests/launcher-plugin-mode.test.ts",
    "tests/launcher-sqlite-overlay.test.ts",
    "tests/launcher.test.ts",
    "tests/logger-epipe.test.ts",
    "tests/mcp-native-thread.test.ts",
    "tests/multi-instance-live.test.ts",
    "tests/omp-native.test.ts",
    "tests/opencode-native.test.ts",
    "tests/overlay-busy-lock.test.ts",
    "tests/pi-native.test.ts",
    "tests/plugin-fork.test.ts",
    "tests/port-zone-live.test.ts",
    "tests/port-zone.test.ts",
    "tests/release-ci-gate.test.ts",
    "tests/watchdog-health-daemon.test.ts",
    "tests/watchdog-health.test.ts",
    "tests/win-cmd-argv.test.ts",
    "tests/zcode-mcp-degraded.test.ts",
    "tests/zcode-real-cli.test.ts",
];

const SPAWN_RE = /\bspawn[A-Za-z]*\s*\(|child_process|execFile|execSync|spawnSync|new Worker\(/;

const allFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `tests/${f}`);

function die(msg) {
    console.error(`::error::${msg}`);
    console.error(`[ci-tests] ${msg}`);
    process.exit(1);
}

for (const f of LIVE_FILES) {
    if (!allFiles.includes(f)) die(`LIVE_FILES entry ${f} does not exist`);
}
const unregistered = allFiles.filter(
    (f) => !LIVE_FILES.includes(f) && SPAWN_RE.test(readFileSync(join(root, f), "utf8")),
);
if (unregistered.length > 0) {
    die(
        `process-spawning test files missing from LIVE_FILES in scripts/run-ci-tests.mjs: ` +
            `${unregistered.join(", ")}. Register them there after reviewing their ` +
            `concurrency assumptions (#1248).`,
    );
}

// Parity with the old `npm test` step: its pretest hook builds kernel/ and
// pi-subagents/ dist bundles that the suites import. On Windows npm is a .cmd
// batch file, which CreateProcess cannot exec directly (EINVAL) — route it
// through cmd.exe via shell:true; the args are fixed literals, so there is no
// quoting surface.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
console.log("[ci-tests] pretest (kernel + pi-subagents build)");
execFileSync(npmCmd, ["run", "pretest"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

function runPhase(label, files, concurrency) {
    const t0 = Date.now();
    console.log(`[ci-tests] ${label}: ${files.length} files, concurrency=${concurrency}`);
    try {
        execFileSync(
            process.execPath,
            ["--import", "tsx", "--test", "--test-concurrency", String(concurrency), ...files],
            { cwd: root, stdio: "inherit" },
        );
    } catch {
        console.error(`[ci-tests] ${label} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        process.exit(1);
    }
    console.log(`[ci-tests] ${label} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

runPhase("all", allFiles, 4);
