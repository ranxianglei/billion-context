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
// #3665: a SECOND recoverable shape rides the same bounded-retry guarantee: TAP
// tail `fail 0` with `cancelled > 0` — every loss is an event-loop-drain
// cancellation ("Promise resolution is still pending but the event loop has
// already resolved"), i.e. ZERO assertion failures. Observed 5+ times across 4
// branches / 2 windows lanes / 2 files, always alongside contaminated-runner
// signals (a leaked process holding a zone port, ENOSPC at job start); the same
// lane ran green on master concurrently. Shape classification lives in
// ci-failure-shapes.mjs (unit-tested there); the action mirrors #3029 minus the
// isolated re-runs: retry the whole shard once, exit 0 only if that retry is
// green. A deterministic hang reproduces on the retry and still fails.
//
// #4347: a THIRD recoverable shape rides the same bounded-retry guarantee: every
// failing subtest carries an OS transient-lock errno (EBUSY/EPERM/EACCES/
// ENOTEMPTY/EMFILE) on an unlink/rmdir inside a rimraf teardown stack — the
// #2799/#2908 family, where Windows AV/indexer briefly locks a freshly-written
// index.db past tests/tmp-rm.ts' ~9.6s retry ladder (observed twice in 24h on
// the windows-22-1 lane: PR #4334 head job + master 9e2d2170, byte-identical
// signatures, both runs failing the two corrupt-index.db tests). An EBUSY
// unlink is never an assertion regression; the action mirrors #3029 minus the
// isolated re-runs: retry the whole shard once, exit 0 only if green. A
// DETERMINISTIC lock (a genuine handle leak) reproduces on the retry and still
// fails, so no regression can be masked. Raw user-code unlinkSync EBUSY (no
// rimraf frames) stays concrete and unretried — see ci-failure-shapes.mjs.
//
// #4212 (#3665 round 3): the same-runner retry provably cannot recover a
// persistent drain (it reproduced 8/8 across jobs in a 30-min window on
// 2026-10-21, then a fresh-runner full matrix went green). So a TWICE-drained
// phase on a merge-gating event (pull_request/merge_group) now passes WITH a
// loud ::warning naming the cancelled tests instead of going red and waiting
// for a human to draw a fresh runner (PR #4206 sat red ~40 min with zero
// assertion failures). push/schedule/dispatch — the fresh-runner probes — and
// every non-drain shape fail exactly as before, so a genuinely deterministic
// drain is still caught within one push run / the 30-min scheduled cadence.
//
// #4161: a FOURTH recoverable shape rides the same bounded-retry guarantee:
// every failing subtest carries one of the strict timing-assertion signatures
// observed failing GREEN code on windows-latest node-22 shards under runner
// load (2026-10-21, victims rotating across runs, master itself hit it): the
// waitFor-budget timeout idiom ('timeout waiting for …') and the #3818
// same-tick write-window literals ('the disabling tick must land a JSON
// write…' / 'the safety valve lands a JSON envelope…'). Load starves the
// event loop past the fixed ~5s/400ms budgets while the mechanism under test
// is intact. One full retry, exit 0 only if green — a DETERMINISTIC break (a
// genuinely dead fallback path) reproduces on the retry and still fails, so
// no regression can be masked. The victim budgets are ALSO widened in their
// own files (tests/issue760-percall-conversation.test.ts,
// tests/storage-full-flip.test.ts) — classifier and widening are belt and
// suspenders, not alternatives.
import { execFileSync, spawn } from "node:child_process";
import { LIVE_FILES } from "./live-files.mjs";
import { classifyPhaseFailure, describeDrainPass, describeRetryOutcome, extractDrainCancelledTests, shouldDrainPass } from "./ci-failure-shapes.mjs";
import { partitionAll as partitionFiles } from "./ci-shard-partition.mjs";
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
// The partition is DETERMINISTIC and TOTAL: every file lands in exactly ONE
// shard, so the union of all shards == allFiles and NOTHING is ever skipped.
// Same input => same partition; a newly-added file only re-partitions the
// bins, it never drops another. Since #4360 the weight is the file's MEASURED
// duration (scripts/ci-shard-partition.mjs + ci-shard-weights.json; new files
// fall back to line-count × msPerLineFallback) — line-count balancing proved
// blind to process-spawning suites and produced 5min..37min legs out of
// "perfectly balanced" byte counts.
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

// Weighted LPT lives in scripts/ci-shard-partition.mjs (unit-tested via its
// .d.mts; this script has top-level side effects and cannot be imported).
function partitionAll(files, n) {
    return partitionFiles(files, n);
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
    const verdict = classifyPhaseFailure(first.out, baseToFile);
    if (verdict.kind === "concrete") {
        console.error(
            "[ci-tests] failure carries concrete sub-test assertions (not the #3029 swallowed 'test failed' shape, " +
                "not the #3665 fail-0/cancelled>0 drain shape, not the #4347 teardown-lock shape, " +
                "not the #4161 timing-window shape) -> failing WITHOUT " +
                "auto-retry so a real regression is never masked.",
        );
        process.exit(first.code ?? 1);
    }
    if (verdict.kind === "swallowed") {
        console.error(
            `[ci-tests] swallowed file-level failure(s) — zero subtests, payload only 'test failed': ` +
                `${verdict.files.join(", ")} (#3029)`,
        );
        for (const rel of verdict.files) {
            const r = await runIsolated(rel);
            console.error(
                `[ci-tests] isolated re-run ${rel}: exit=${r.code} signal=${r.signal} (${(r.ms / 1000).toFixed(1)}s) -> ` +
                    (r.code === 0
                        ? "PASSED in isolation (transient / concurrency flake likely)"
                        : "REPRODUCED in isolation (deterministic break)"),
            );
        }
    } else if (verdict.kind === "cancelled-drain") {
        const c = verdict.counts;
        console.error(
            `[ci-tests] TAP tail pass=${c.pass} fail=${c.fail} cancelled=${c.cancelled}: zero assertion failures — ` +
                `every loss is an event-loop-drain cancellation ('Promise resolution is still pending but the event ` +
                `loop has already resolved'). Infrastructure-level drain (runner contamination or deterministic ` +
                `in-process hang), not an assertion regression (#3665).`,
        );
    } else if (verdict.kind === "timing-window") {
        console.error(
            `[ci-tests] all ${verdict.timing} failing subtest(s) carry strict timing-assertion signatures ` +
                `(waitFor-budget 'timeout waiting for …' timeouts or #3818 same-tick write-window literals): the ` +
                `#4161 family — windows-latest runner load starves the event loop past the fixed budget while the ` +
                `mechanism under test is intact. A deterministic break still reproduces on the retry and fails.`,
        );
    } else {
        console.error(
            `[ci-tests] all ${verdict.locks} failing subtest(s) are teardown-path transient OS locks ` +
                `(EBUSY/EPERM/... on unlink/rmdir through rimraf): the #2799/#2908 family — an external ` +
                `AV/indexer hold on freshly-written files outliving the tests/tmp-rm.ts retry ladder, never an ` +
                `assertion regression (#4347).`,
        );
    }
    const retryIssue = { swallowed: "#3029", "cancelled-drain": "#3665", "cleanup-lock": "#4347", "timing-window": "#4161" }[verdict.kind];
    console.error(`[ci-tests] retrying full phase once to confirm flake (${retryIssue})`);
    const retry = await runNodeTest(selectedFiles, 4, "all (retry)");
    if (retry.code === 0) {
        const firstSummary =
            verdict.kind === "swallowed"
                ? `failed on ${verdict.files.join(", ")}`
                : verdict.kind === "cancelled-drain"
                  ? `lost ${verdict.counts.cancelled} tests to event-loop drain`
                  : verdict.kind === "timing-window"
                    ? `hit ${verdict.timing} strict timing-window assertion(s)`
                    : `hit ${verdict.locks} transient teardown lock(s)`;
        console.log(
            `[ci-tests] FLAKE CONFIRMED: first run ${firstSummary}, full retry green in ${(retry.ms / 1000).toFixed(1)}s ` +
                `-> treating as transient (#3029/#3665/#4347/#4161). If it recurs, check ` +
                `node${process.version.replace(/^v/, "").split(".")[0]}-${process.platform} + tsx load ` +
                `+ concurrency=4 (see snapshot above).`,
        );
        process.exit(0);
    }
    // The retry ran on the SAME runner: its failure shape decides the verdict.
    // A reproduced drain signature is a persistent infrastructure condition, NOT
    // a code regression — the old fixed "genuine failure" line mislabelled it
    // (#3665 round-2 log). Reclassify before printing the conclusion.
    const retryVerdict = classifyPhaseFailure(retry.out, baseToFile);
    // #4212 (#3665 round 3): twice-drained + merge-gating event = zero
    // assertion failures on both attempts on this runner — pass with a loud
    // warning instead of blocking merges on a runner-pool condition no repo
    // change can fix. push/schedule/dispatch (fresh-runner probes), local runs
    // (no GITHUB_EVENT_NAME), and every non-drain shape fail exactly as before.
    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    if (shouldDrainPass(verdict, retryVerdict, eventName)) {
        const cancelledTests = extractDrainCancelledTests(retry.out);
        console.error(
            `::warning::DRAIN-PASS (#3665/#4212): both attempts on this runner lost tests to event-loop ` +
                `drain with ZERO assertion failures — merge gate not blocked. Cancelled: ` +
                `${cancelledTests.join("; ") || "see TAP above"}`,
        );
        console.error(`[ci-tests] ${describeDrainPass(verdict, retryVerdict, cancelledTests, eventName)}`);
        process.exit(0);
    }
    console.error(
        `[ci-tests] full retry also FAILED (exit=${retry.code} signal=${retry.signal}) -> ` +
            describeRetryOutcome(retryVerdict),
    );
    process.exit(retry.code ?? 1);
})().catch((e) => {
    console.error(`[ci-tests] runner crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
});
