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
//
// #3356: second retryable shape — drain-cancelled. node:test cancels any test
// still pending when the event loop drains with ZERO live handles (win22 under
// load: a teardown await whose server 'close' never fires — the whole file
// then reports `failureType: 'cancelledByParent'` + "Promise resolution is
// still pending but the event loop has already resolved", no assertion at all).
// The leg shows `# fail 0` with every not-ok entry cancelled. Same recovery as
// above: isolated attribution re-run + ONE full-phase retry, exit 0 only if
// the retry is green. ANY real assertion failure (summary fail > 0 or even one
// non-cancel not-ok entry) voids the shape → hard fail, so a genuine
// regression is never masked by either path. Shape detection lives in
// ci-tap-shapes.mjs (pure functions, unit-tested by tests/ci-tap-shapes.test.ts).
import { execFileSync, spawn } from "node:child_process";
import { LIVE_FILES } from "./live-files.mjs";
import { extractDrainCancelledFiles, extractSwallowedFiles } from "./ci-tap-shapes.mjs";
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
// LIVE_FILES lives in scripts/live-files.mjs so the zone-slot preload can
// share the exact same table (#3182: per-file zone port bands).

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

// #3143: shard parsing + balanced partitioning. CI_TEST_SHARD="i/N" selects this
// leg's slice; absent means "run everything" (local / back-compat, unchanged).
// The partition is DETERMINISTIC and TOTAL: LPT bin-packing over a line-count
// weight (cheap, runtime-derived, self-maintaining for new files) puts every file
// in exactly ONE shard, so the union of all shards == allFiles and NOTHING is ever
// skipped. Same input => same partition; a newly-added file only re-partitions the
// bins, it never drops another. Balance targets the HEAVIEST shard (the wall clock),
// not equal file counts — the one 7k-line monster must not pile onto one leg.
function parseShard() {
    const raw = (process.env.CI_TEST_SHARD ?? "").trim();
    if (raw === "") return null;
    const m = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) die(`CI_TEST_SHARD must look like "<i>/<N>" (got "${raw}")`);
    const i = Number(m[1]);
    const n = Number(m[2]);
    if (n < 1 || i < 1 || i > n) die(`CI_TEST_SHARD "${raw}" out of range (need 1 <= i <= N)`);
    return { i, n };
}

function partitionAll(files, n) {
    const weight = new Map();
    for (const f of files) {
        let txt = "";
        try { txt = readFileSync(join(root, f), "utf8"); } catch { /* unreadable => weight floor 1 */ }
        weight.set(f, Math.max(1, txt.split("\n").length));
    }
    const order = [...files].sort(
        (a, b) => weight.get(b) - weight.get(a) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const bins = Array.from({ length: n }, () => []);
    const load = new Array(n).fill(0);
    for (const f of order) {
        let best = 0;
        for (let k = 1; k < n; k++) if (load[k] < load[best]) best = k; // lowest index breaks ties
        bins[best].push(f);
        load[best] += weight.get(f);
    }
    return bins;
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

// #3143: select this leg's slice AFTER the global tripwire above (which still scans
// the FULL set in every shard, so an unregistered spawner fails whichever shard you
// inspect). Unsharded => the whole suite, exactly as before.
const shard = parseShard();
let selectedFiles = allFiles;
if (shard) {
    selectedFiles = partitionAll(allFiles, shard.n)[shard.i - 1];
    console.log(
        `[ci-tests] shard ${shard.i}/${shard.n}: ${selectedFiles.length}/${allFiles.length} files ` +
            `(union of all shards == allFiles — nothing skipped)`,
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
const PRELOAD_ARGS = ["--import", "./tests/preload-storage-baseline.mjs", "--import", "./tests/preload-zone-slot.mjs", "--import", "tsx"];

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
    const first = await runNodeTest(selectedFiles, 4, "all");
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
    const swallowed = extractSwallowedFiles(first.out, baseToFile);
    const drained = extractDrainCancelledFiles(first.out, baseToFile);
    if (swallowed.length === 0 && drained === null) {
        console.error(
            "[ci-tests] failure carries concrete sub-test assertions (neither the swallowed 'test failed' nor the drain-cancelled shape) " +
                "-> failing WITHOUT auto-retry so a real regression is never masked.",
        );
        process.exit(first.code ?? 1);
    }
    const shapes = [
        swallowed.length > 0 ? `swallowed: ${swallowed.join(", ")}` : null,
        drained !== null ? `drain-cancelled: ${drained.length > 0 ? drained.join(", ") : "(no location resolved)"}` : null,
    ].filter((s) => s !== null);
    console.error(`[ci-tests] retryable flake shape(s): ${shapes.join("; ")} (#3029/#3356)`);
    const targets = [...new Set([...swallowed, ...(drained ?? [])])];
    if (targets.length > 0) {
        for (const rel of targets) {
            const r = await runIsolated(rel);
            console.error(
                `[ci-tests] isolated re-run ${rel}: exit=${r.code} signal=${r.signal} (${(r.ms / 1000).toFixed(1)}s) -> ` +
                    (r.code === 0
                        ? "PASSED in isolation (transient / concurrency flake likely)"
                        : "REPRODUCED in isolation (deterministic break)"),
            );
        }
    } else {
        console.error("[ci-tests] drain-cancelled matched but no file locations resolved -> skipping isolated attribution");
    }
    console.error("[ci-tests] retrying full phase once to confirm flake (#3029/#3356)");
    const retry = await runNodeTest(selectedFiles, 4, "all (retry)");
    if (retry.code === 0) {
        console.log(
            `[ci-tests] FLAKE CONFIRMED: first run failed (${shapes.join("; ")}), full retry green in ` +
                `${(retry.ms / 1000).toFixed(1)}s -> treating as transient (#3029/#3356). If it recurs, check ` +
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
