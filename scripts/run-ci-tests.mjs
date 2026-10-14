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
//
// #3029: attribution + bounded flake recovery for "swallowed" file-level
// failures. When a test child dies SILENTLY (non-zero exit, no stderr — OOM
// kill, tsx/esbuild worker death, race exit under concurrency), node --test
// collapses it to one file-level `not ok <file>` whose only payload is
// `error: 'test failed'` and zero subtests; NO reporter can surface an error
// the child never emitted. On failure this runner therefore: captures exit
// code + signal (previously discarded by an empty catch) plus a resource
// snapshot (free/total mem, loadavg, node version, platform); detects the
// swallowed shape (a top-level `not ok … *.test.ts` — successful files promote
// their inner tests to top level by test name and never emit a file-level
// entry); re-runs each such file in ISOLATION for attribution; then retries
// the whole phase ONCE and exits 0 only if that retry is green (a confirmed
// transient). Concrete assertion failures (subtests ran and reported a real
// message) are NOT the swallowed shape → they fail hard immediately, no retry,
// so a real regression is never masked.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
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
    "tests/session-transient-memory.test.ts",
    "tests/auto-restart.test.ts",
    "tests/bounded-storage-scale.test.ts",
    "tests/build-info.test.ts",
    "tests/cache-theorem.test.ts",
    "tests/claude-native.test.ts",
    "tests/e2e-plugin-tool-routing.test.ts",
    "tests/graceful-close.test.ts",
    "tests/hermes-native.test.ts",
    "tests/hook-command.test.ts",
    "tests/hook-graceful-exit.test.ts",
    "tests/index-entry-guard.test.ts",
    "tests/issue1958-routed-warn.test.ts",
    "tests/issue2752-forward-partial-outcome.test.ts",
    // #3059: child proxy binds an ephemeral port (port 0); all XDG dirs and
    // env are per-spawn isolated under tmpdir() — no fixed ports or shared
    // state, safe at c=4 alongside the other live suites.
    "tests/issue3059-watchdog-short-lived-owners.test.ts",
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
    "tests/text-safe.test.ts",
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

const baseToFile = new Map(allFiles.map((f) => [f.split("/").pop(), f]));

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

// Loader chain the suites depend on (storage-baseline preload, #2671/#2803,
// then tsx). Shared by the main phase and the isolated diagnostic re-run so
// the latter sees the SAME environment as the in-phase run.
const PRELOAD_ARGS = ["--import", "./tests/preload-storage-baseline.mjs", "--import", "tsx"];

const MAX_CAPTURE = 32 * 1024 * 1024; // bound in-memory capture; real runs are MB-scale

function runNodeTest(files, concurrency, label) {
    const t0 = Date.now();
    console.log(`[ci-tests] ${label}: ${files.length} files, concurrency=${concurrency}`);
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [...PRELOAD_ARGS, "--test", "--test-concurrency", String(concurrency), "--test-reporter=tap", ...files],
            { cwd: root },
        );
        const out = [];
        const err = [];
        let outLen = 0;
        let errLen = 0;
        child.stdout.on("data", (d) => {
            if (outLen < MAX_CAPTURE) {
                out.push(d);
                outLen += d.length;
            }
            process.stdout.write(d);
        });
        child.stderr.on("data", (d) => {
            if (errLen < MAX_CAPTURE) {
                err.push(d);
                errLen += d.length;
            }
            process.stderr.write(d);
        });
        child.on("error", (e) => {
            console.error(`[ci-tests] ${label}: spawn error: ${e.message}`);
            resolve({ code: -1, signal: null, out: "", err: "", ms: Date.now() - t0 });
        });
        child.on("close", (code, signal) => {
            resolve({
                code,
                signal,
                out: Buffer.concat(out).toString("utf8"),
                err: Buffer.concat(err).toString("utf8"),
                ms: Date.now() - t0,
            });
        });
    });
}

function resourceSnapshot() {
    const mi = (n) => `${Math.round(n / 1048576)}MiB`;
    return (
        `freemem=${mi(freemem())} totalmem=${mi(totalmem())} ` +
        `loadavg=${loadavg().map((x) => x.toFixed(2)).join("/")} ` +
        `node=${process.version} platform=${process.platform}/${process.arch}`
    );
}

// A top-level `not ok N - <path ending .test.ts>` can only come from a file
// whose child DIED: successful files promote their inner tests to top level by
// test name and never emit a file-level entry. Pairing that with the YAML
// `error: 'test failed'` marker isolates the swallowed/silent-death shape from
// real assertion failures (named by test name, carrying a real message).
function extractSwallowedFiles(output) {
    const lines = output.split(/\r?\n/);
    const found = new Set();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^not ok \d+ - (.+?)\s*$/);
        if (!m) continue;
        const window = lines.slice(i, i + 20).join("\n");
        if (!/error:\s*'test failed'/.test(window)) continue;
        const base = m[1].trim().split(/[\\/]/).pop();
        const rel = baseToFile.get(base);
        if (rel) found.add(rel);
    }
    return [...found];
}

function runIsolated(fileRel) {
    const t0 = Date.now();
    console.log(`[ci-tests] DIAGNOSTIC isolated re-run (serial): ${fileRel} — full output below`);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [...PRELOAD_ARGS, "--test", "--test-reporter=tap", fileRel], { cwd: root });
        child.stdout.on("data", (d) => process.stdout.write(d));
        child.stderr.on("data", (d) => process.stderr.write(d));
        child.on("error", (e) => {
            console.error(`[ci-tests] isolated re-run ${fileRel}: spawn error: ${e.message}`);
            resolve({ code: -1, signal: null, ms: Date.now() - t0 });
        });
        child.on("close", (code, signal) => resolve({ code, signal, ms: Date.now() - t0 }));
    });
}

(async () => {
    const first = await runNodeTest(allFiles, 4, "all");
    if (first.code === 0) {
        console.log(`[ci-tests] all ok in ${(first.ms / 1000).toFixed(1)}s`);
        return;
    }
    console.error(`[ci-tests] all FAILED after ${(first.ms / 1000).toFixed(1)}s (exit=${first.code} signal=${first.signal})`);
    console.error(`[ci-tests] resource snapshot: ${resourceSnapshot()}`);
    const errTrim = first.err.replace(/\s+/g, " ").trim();
    if (errTrim) {
        console.error(
            `[ci-tests] child stderr captured (${first.err.length} chars) — may carry a V8/native fatal (e.g. OOM 'Reached heap limit'): ` +
                `${errTrim.slice(0, 2000)}`,
        );
    } else {
        console.error(
            "[ci-tests] child wrote nothing to stderr (node --test reports test failures on the TAP stdout above; nothing extra to surface here)",
        );
    }
    const swallowed = extractSwallowedFiles(first.out);
    if (swallowed.length === 0) {
        console.error(
            "[ci-tests] failure carries concrete sub-test assertions (not the swallowed 'test failed' shape) " +
                "-> failing WITHOUT auto-retry so a real regression is never masked.",
        );
        process.exit(first.code ?? 1);
    }
    console.error(
        `[ci-tests] swallowed file-level failure(s) — zero subtests, payload only 'test failed': ` +
            `${swallowed.join(", ")} (#3029)`,
    );
    for (const rel of swallowed) {
        const r = await runIsolated(rel);
        console.error(
            `[ci-tests] isolated re-run ${rel}: exit=${r.code} signal=${r.signal} (${(r.ms / 1000).toFixed(1)}s) -> ` +
                (r.code === 0
                    ? "PASSED in isolation (transient / concurrency flake likely)"
                    : "REPRODUCED in isolation (deterministic break)"),
        );
    }
    console.error("[ci-tests] retrying full phase once to confirm flake (#3029)");
    const retry = await runNodeTest(allFiles, 4, "all (retry)");
    if (retry.code === 0) {
        console.log(
            `[ci-tests] FLAKE CONFIRMED: first run failed on ${swallowed.join(", ")}, full retry green in ` +
                `${(retry.ms / 1000).toFixed(1)}s -> treating as transient (#3029). If it recurs, check ` +
                `node${process.version.replace(/^v/, "").split(".")[0]}-${process.platform} + tsx load + concurrency=4 (see snapshot above).`,
        );
        process.exit(0);
    }
    console.error(`[ci-tests] full retry also FAILED (exit=${retry.code} signal=${retry.signal}) -> genuine failure, not a flake`);
    process.exit(retry.code ?? 1);
})().catch((e) => {
    console.error(`[ci-tests] runner crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
});
