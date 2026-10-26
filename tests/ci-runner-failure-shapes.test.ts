// #3665: unit coverage for the CI runner's failed-phase classifier
// (scripts/ci-failure-shapes.mjs), which decides whether a red shard gets its
// one bounded full-retry or fails hard. Gate discipline (#3617): every
// recoverable shape asserts BOTH directions — "retried when it should" AND
// "NOT retried when it should not". The synthetic TAP mirrors the exact shapes
// observed in the windows-latest flakes: the file-level 'test failed' silent
// death (#3029) and the fail-0/cancelled>0 event-loop-drain tail (#3665).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classifyPhaseFailure,
    countNotOkEntries,
    describeDrainPass,
    describeRetryOutcome,
    extractDrainCancelledTests,
    extractSwallowedFiles,
    extractTapCounts,
    shouldDrainPass,
} from "../scripts/ci-failure-shapes.mjs";

const baseToFile = new Map([
    ["issue1993-preflight-400.test.ts", "tests/issue1993-preflight-400.test.ts"],
    ["lane-decisions-matrix.test.ts", "tests/lane-decisions-matrix.test.ts"],
]);

const CONCRETE_TAP = [
    "TAP version 13",
    "# Subtest: preflight rejects malformed proxy args",
    "not ok 1 - preflight rejects malformed proxy args",
    "  ---",
    "  duration_ms: 12.3",
    "  failureType: 'testCodeError'",
    "  code: 'ERR_ASSERTION'",
    "  error: 'expected 400, got 200'",
    "  operator: 'strictEqual'",
    "  stack: |-",
    "    TestContext.<anonymous> (file:///tests/x.test.ts:10:15)",
    "  ...",
    "1..1",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 4567",
].join("\n");

// The exact #3665 signature: subtests lost to event-loop drain, zero assertion
// failures, non-zero exit.
const DRAIN_TAP = [
    "TAP version 13",
    "ok 1 - preflight accepts well-formed proxy args",
    "  ---",
    "  duration_ms: 4812.1",
    "  ...",
    "not ok 2 - preflight rejects malformed proxy args",
    "  ---",
    "  duration_ms: 0",
    "  failureType: 'cancelledByParent'",
    "  error: 'Promise resolution is still pending but the event loop has already resolved'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "1..5",
    "# pass 4352",
    "# fail 0",
    "# cancelled 5",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 612345",
].join("\n");

// The exact #3029 signature: a file-level entry whose only payload is
// 'test failed' — the child died before reporting any of its subtests.
const SWALLOWED_TAP = [
    "TAP version 13",
    "ok 1 - some surviving top-level test",
    "  ---",
    "  duration_ms: 3.2",
    "  ...",
    "not ok 2 - issue1993-preflight-400.test.ts",
    "  ---",
    "  duration_ms: 61000.4",
    "  timing:",
    "    enqueue: 0.01",
    "    start: 1.0",
    "    end: 61001.4",
    "  performance: false",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "1..2",
    "# pass 100",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 90000",
].join("\n");

// The exact #4347 signature, mirroring the windows-22-1 log byte-for-byte in
// shape: every failing subtest is a teardown unlink that hit a transient OS
// lock — EBUSY from an external AV/indexer hold, stack through Node's internal
// rimraf (rmSync teardown). The second entry's stack is truncated by node's
// own frame cap and carries NO tmp-rm.ts frame, only rimraf ones — detection
// must anchor on rimraf, not on tmp-rm (#4347 evidence).
const LOCK_TAP = [
    "TAP version 13",
    "# Subtest: storage engine: corrupt index.db degrades to legacy-only instead of bricking construction (\\#2771)",
    "not ok 3202 - storage engine: corrupt index.db degrades to legacy-only instead of bricking construction (\\#2771)",
    "  ---",
    "  duration_ms: 10176.31",
    "  type: 'test'",
    "  location: 'D:\\\\a\\\\billion-context\\\\tests\\\\storage-engine-proofs.test.ts:1:10941'",
    "  failureType: 'testCodeFailure'",
    '  error: "EBUSY: resource busy or locked, unlink \'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\bili-engproof-corrupt-duJDYw\\\\index.db\'"',
    "  code: 'EBUSY'",
    "  stack: |-",
    "    unlinkSync (node:fs:1948:11)",
    "    _unlinkSync (node:internal/fs/rimraf:215:14)",
    "    rimrafSync (node:internal/fs/rimraf:196:7)",
    "    _rmdirSync (node:internal/fs/rimraf:251:7)",
    "    rmSync (node:fs:1239:10)",
    "    defaultRm (D:\\\\a\\\\billion-context\\\\tests\\\\tmp-rm.ts:30:5)",
    "    rmrf (D:\\\\a\\\\billion-context\\\\tests\\\\tmp-rm.ts:45:13)",
    "  ...",
    "# Subtest: \\#3040 corrupt index.db (guard #2771): degraded with the open-failure reason",
    "not ok 3568 - \\#3040 corrupt index.db (guard #2771): degraded with the open-failure reason",
    "  ---",
    "  duration_ms: 12824.03",
    "  type: 'test'",
    "  location: 'D:\\\\a\\\\billion-context\\\\tests\\\\web-storage-banner.test.ts:1:10067'",
    "  failureType: 'testCodeFailure'",
    '  error: "EBUSY: resource busy or locked, unlink \'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\bili-storage-banner-T5MXdY\\\\sessions\\\\index.db\'"',
    "  code: 'EBUSY'",
    "  stack: |-",
    "    unlinkSync (node:fs:1948:11)",
    "    _unlinkSync (node:internal/fs/rimraf:215:14)",
    "    rimrafSync (node:internal/fs/rimraf:196:7)",
    "    _rmdirSync (node:internal/fs/rimraf:251:7)",
    "  ...",
    "1..3568",
    "# pass 3566",
    "# fail 2",
    "# cancelled 0",
    "# skipped 12",
    "# todo 0",
    "# duration_ms 612345",
].join("\n");

// The exact #4161 waitFor-budget signature, mirroring the windows-latest
// node-22 shard flake of 2026-10-21 (run 39593321008, job 119199725034: two
// consecutive subtests in tests/issue760-percall-conversation.test.ts, ~5030ms
// each): a poll-until-deadline helper threw on deadline expiry — runner load
// starved the event loop past the fixed 5s budget while the mechanism under
// test was intact. Shape verified against node's TAP reporter locally: a
// thrown Error carries failureType 'testCodeFailure' + code 'ERR_TEST_FAILURE'
// and the raw message in the YAML error field.
const TIMING_WAITFOR_TAP = [
    "TAP version 13",
    "# Subtest: shared shim, no env/meta id: per-call ids route two sessions independently and flip them to plugin mode",
    "not ok 1944 - shared shim, no env/meta id: per-call ids route two sessions independently and flip them to plugin mode",
    "  ---",
    "  duration_ms: 5031.2",
    "  type: 'test'",
    "  location: 'D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\issue760-percall-conversation.test.ts:1:8412'",
    "  failureType: 'testCodeFailure'",
    "  error: 'timeout waiting for initialize + tools/list responses'",
    "  code: 'ERR_TEST_FAILURE'",
    "  stack: |-",
    "    waitFor (D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\issue760-percall-conversation.test.ts:135:46)",
    "    async Test.run (node:internal/test_runner/test:1208:7)",
    "  ...",
    "# Subtest: shim: per-call id strips the forwarded arg, routes on the body field, never registers or adopts for per-call ids",
    "not ok 1945 - shim: per-call id strips the forwarded arg, routes on the body field, never registers or adopts for per-call ids",
    "  ---",
    "  duration_ms: 5028.7",
    "  type: 'test'",
    "  location: 'D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\issue760-percall-conversation.test.ts:1:10456'",
    "  failureType: 'testCodeFailure'",
    "  error: 'timeout waiting for per-call X'",
    "  code: 'ERR_TEST_FAILURE'",
    "  stack: |-",
    "    waitFor (D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\issue760-percall-conversation.test.ts:135:46)",
    "    async Test.run (node:internal/test_runner/test:1208:7)",
    "  ...",
    "1..1945",
    "# pass 1942",
    "# fail 2",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 612345",
].join("\n");

// The exact #4161 same-tick write-window signature, mirroring the MASTER run
// 39597779204 / job 119214420409 log byte-for-byte in shape (not ok 1903,
// duration 4858ms): the #3818 ⑥ assert.ok message — under writerOff the
// disabling tick must land a JSON envelope within the settle budget, and the
// runner's event-loop delay pushed the debounce tick past it on green code.
const TIMING_WRITETICK_TAP = [
    "TAP version 13",
    "# Subtest: \\#3818 \\u2466 writerOff save that disables the sidecar still lands JSON the same tick (\\#3135 \\u2460)",
    "not ok 1903 - \\#3818 \\u2466 writerOff save that disables the sidecar still lands JSON the same tick (\\#3135 \\u2460)",
    "  ---",
    "  duration_ms: 4858.6166",
    "  type: 'test'",
    "  location: 'D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\storage-full-flip.test.ts:1:7046'",
    "  failureType: 'testCodeFailure'",
    "  error: 'the disabling tick must land a JSON write \\u2014 no window where the save exists on neither copy'",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    "  expected: true",
    "  actual: ~",
    "  operator: '=='",
    "  stack: |-",
    "    TestContext.<anonymous> (D:\\a\\\\billion-context\\\\billion-context\\\\tests\\\\storage-full-flip.test.ts:296:16)",
    "    async Test.run (node:internal/test_runner/test:1054:7)",
    "  ...",
    "1..1903",
    "# pass 1901",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 612345",
].join("\n");

test("concrete assertion failure -> concrete (never retried)", () => {
    const v = classifyPhaseFailure(CONCRETE_TAP, baseToFile);
    assert.equal(v.kind, "concrete");
});

// #4161 timing-window family, both directions (#3617): retried when every
// failure carries an observed timing signature, NOT retried the moment any
// other assertion rides along.
test("waitFor budget timeouts only -> timing-window (retried once, #4161)", () => {
    const v = classifyPhaseFailure(TIMING_WAITFOR_TAP, baseToFile);
    assert.equal(v.kind, "timing-window");
    assert.equal(v.timing, 2);
    assert.deepEqual(countNotOkEntries(TIMING_WAITFOR_TAP), { lock: 0, timing: 2, other: 0 });
});

test("#3818 same-tick write-window literal -> timing-window (retried once, #4161)", () => {
    const v = classifyPhaseFailure(TIMING_WRITETICK_TAP, baseToFile);
    assert.equal(v.kind, "timing-window");
    assert.equal(v.timing, 1);
});

test("#3818 safety-valve literal (historical \\u2469 signature, reworked away by #4242) -> timing-window", () => {
    const historical = TIMING_WRITETICK_TAP.replace(
        "error: 'the disabling tick must land a JSON write \\u2014 no window where the save exists on neither copy'",
        "error: 'the safety valve lands a JSON envelope even under writerOff'",
    );
    const v = classifyPhaseFailure(historical, baseToFile);
    assert.equal(v.kind, "timing-window");
});

test("timing-window failure alongside a REAL assertion failure -> concrete (regression never masked)", () => {
    const mixed = TIMING_WAITFOR_TAP + "\n" + CONCRETE_TAP.replace("TAP version 13\n", "");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("timing-window failure alongside a teardown lock -> concrete (recoverable families never mix)", () => {
    const mixed = TIMING_WRITETICK_TAP + "\n" + LOCK_TAP.replace("TAP version 13\n", "");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("an assertion failure from the SAME victim files without a timing signature stays concrete", () => {
    // storage-full-flip's own 'writerOff leaves no JSON files' (an assert.equal
    // message, not the write-window literal) and issue760's own prefix-cache
    // anchor message: real failures in these files that are NOT the observed
    // timing shapes must never ride the retry.
    const flipSibling = TIMING_WRITETICK_TAP.replace(
        "error: 'the disabling tick must land a JSON write \\u2014 no window where the save exists on neither copy'",
        "error: 'writerOff leaves no JSON files'",
    );
    assert.equal(classifyPhaseFailure(flipSibling, baseToFile).kind, "concrete");
    const percallSibling = TIMING_WAITFOR_TAP.replace(
        "error: 'timeout waiting for initialize + tools/list responses'",
        "error: 'system bytes stable across turns (prefix-cache anchor)'",
    ).replace("error: 'timeout waiting for per-call X'", "error: 'system bytes stable across turns (prefix-cache anchor)'");
    assert.equal(classifyPhaseFailure(percallSibling, baseToFile).kind, "concrete");
});

// The #4161 waitFor-budget timeout lives in 15 e2e suites' shared
// poll-until-deadline helper — one of them (not a #4161-named victim file)
// failing with the SAME idiom classifies the same way: the signature is the
// idiom, not the file name.
test("the waitFor idiom in a non-victim suite classifies as timing-window too (idiom, not filename)", () => {
    const sibling = TIMING_WAITFOR_TAP.replace(
        "error: 'timeout waiting for initialize + tools/list responses'",
        "error: 'timeout waiting for tracked conversations map to settle'",
    ).replace(
        "error: 'timeout waiting for per-call X'",
        "error: 'timeout waiting for tracked conversations map to settle'",
    );
    const v = classifyPhaseFailure(sibling, baseToFile);
    assert.equal(v.kind, "timing-window");
    assert.equal(v.timing, 2);
});

test("event-loop-drain tail (fail 0, cancelled > 0) -> cancelled-drain (retried once)", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    assert.equal(v.kind, "cancelled-drain");
    assert.deepEqual(v.counts, { pass: 4352, fail: 0, cancelled: 5 });
});

test("swallowed file-level death -> swallowed with the exact file list", () => {
    const v = classifyPhaseFailure(SWALLOWED_TAP, baseToFile);
    assert.equal(v.kind, "swallowed");
    assert.deepEqual(v.files, ["tests/issue1993-preflight-400.test.ts"]);
});

test("real failure alongside drain cancellations -> concrete (a real regression is never masked)", () => {
    const mixed = CONCRETE_TAP.replace("# cancelled 0", "# cancelled 3");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("swallowed death alongside drain cancellations -> swallowed (existing path keeps priority)", () => {
    const mixed = SWALLOWED_TAP.replace("# cancelled 0", "# cancelled 2");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "swallowed");
});

test("no TAP tail at all (child died before summarizing) -> concrete (no evidence, no retry)", () => {
    assert.equal(classifyPhaseFailure("", baseToFile).kind, "concrete");
    assert.equal(classifyPhaseFailure("garbage without any summary\n", baseToFile).kind, "concrete");
});

test("green-looking tail (fail 0, cancelled 0) is NOT a recoverable shape on its own", () => {
    const v = classifyPhaseFailure(DRAIN_TAP.replace("# cancelled 5", "# cancelled 0"), baseToFile);
    assert.equal(v.kind, "concrete");
});

test("teardown transient-lock failures only -> cleanup-lock (retried once, #4347)", () => {
    const v = classifyPhaseFailure(LOCK_TAP, baseToFile);
    assert.equal(v.kind, "cleanup-lock");
    assert.equal(v.locks, 2);
    const entries = countNotOkEntries(LOCK_TAP);
    assert.deepEqual(entries, { lock: 2, timing: 0, other: 0 });
});

test("skipped not-ok entries (# SKIP directive) are not failures: still cleanup-lock", () => {
    const withSkips =
        "not ok 3489 - generic append-only stability: small models (no SMT solver available) # SKIP no SMT solver available\n" +
        "not ok 3490 - induction: sketch (no SMT solver available) # SKIP no SMT solver available\n" +
        LOCK_TAP;
    const v = classifyPhaseFailure(withSkips, baseToFile);
    assert.equal(v.kind, "cleanup-lock");
    assert.equal(v.locks, 2);
});

test("teardown lock alongside a REAL assertion failure -> concrete (regression never masked)", () => {
    const mixed = LOCK_TAP + "\n" + CONCRETE_TAP.replace("TAP version 13\n", "");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("EBUSY unlink WITHOUT rimraf frames (raw user-code unlink) -> concrete, not the tmp-rm family", () => {
    const leaked = LOCK_TAP.replace(
        '  error: "EBUSY: resource busy or locked, unlink \'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\bili-engproof-corrupt-duJDYw\\\\index.db\'"',
        '  error: "EBUSY: resource busy or locked, unlink \'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\store-export\\\\sessions\\\\index.db\'"',
    ).replace(
        [
            "  stack: |-",
            "    unlinkSync (node:fs:1948:11)",
            "    _unlinkSync (node:internal/fs/rimraf:215:14)",
            "    rimrafSync (node:internal/fs/rimraf:196:7)",
            "    _rmdirSync (node:internal/fs/rimraf:251:7)",
            "    rmSync (node:fs:1239:10)",
            "    defaultRm (D:\\\\a\\\\billion-context\\\\tests\\\\tmp-rm.ts:30:5)",
            "    rmrf (D:\\\\a\\\\billion-context\\\\tests\\\\tmp-rm.ts:45:13)",
            "  ...",
            "# Subtest: \\#3040 corrupt index.db (guard #2771): degraded with the open-failure reason",
        ].join("\n"),
        [
            "  stack: |-",
            "    unlinkSync (node:fs:1948:11)",
            "    SessionStore.deleteSession (D:\\\\a\\\\billion-context\\\\src\\\\store.ts:88:9)",
            "  ...",
            "# Subtest: \\#3040 corrupt index.db (guard #2771): degraded with the open-failure reason",
        ].join("\n"),
    );
    const v = classifyPhaseFailure(leaked, baseToFile);
    assert.equal(v.kind, "concrete");
});

test("swallowed file-level death keeps priority over cleanup-lock entries", () => {
    const mixed = SWALLOWED_TAP + "\n" + LOCK_TAP.replace("TAP version 13\n", "");
    const v = classifyPhaseFailure(mixed, baseToFile);
    assert.equal(v.kind, "swallowed");
});

test("countNotOkEntries: an entry whose block carries no matching error counts as other", () => {
    const noYaml = "TAP version 13\nnot ok 1 - mystery failure with no detail\n1..1\n# pass 0\n# fail 1";
    assert.deepEqual(countNotOkEntries(noYaml), { lock: 0, timing: 0, other: 1 });
});

test("reproduced teardown lock on retry -> fresh-runner + handle-leak message (#4347)", () => {
    const v = classifyPhaseFailure(LOCK_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /2 teardown-lock failure/);
    assert.match(msg, /fresh runner/);
    assert.match(msg, /handle leak/);
    assert.match(msg, /#4347/);
    assert.doesNotMatch(msg, /genuine failure/);
});

test("reproduced timing-window on retry -> dual-hypothesis message, never 'genuine failure' (#4161)", () => {
    const v = classifyPhaseFailure(TIMING_WAITFOR_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /2 timing-window failure/);
    assert.match(msg, /load condition persists/);
    assert.match(msg, /fresh runner/);
    assert.match(msg, /regression hypothesis is primary/);
    assert.match(msg, /#4161/);
    assert.doesNotMatch(msg, /genuine failure/);
});

test("extractSwallowedFiles ignores file-level entries whose basename is not a known test file", () => {
    const out = SWALLOWED_TAP.replace("issue1993-preflight-400.test.ts", "some-random-name.test.ts");
    assert.deepEqual(extractSwallowedFiles(out, baseToFile), []);
});

// The retry runs on the SAME runner, so a reproduced drain signature must be
// reported as a persistent infrastructure condition (rerun draws a fresh
// runner), never as "genuine failure" — the #3665 round-2 log mislabelled it.
test("reproduced drain on retry -> persistent-condition message, NOT 'genuine failure'", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /persistent condition on this runner/);
    assert.match(msg, /pass=4352 fail=0 cancelled=5/);
    assert.match(msg, /fresh runner \(#3665\)/);
    assert.doesNotMatch(msg, /genuine failure/);
});

test("swallowed death on retry -> genuine failure naming the files, no fresh-runner hint", () => {
    const v = classifyPhaseFailure(SWALLOWED_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /genuine failure, not a flake/);
    assert.match(msg, /issue1993-preflight-400\.test\.ts/);
    assert.doesNotMatch(msg, /fresh runner/);
});

test("concrete assertion failures on retry -> genuine failure with the count, no fresh-runner hint", () => {
    const v = classifyPhaseFailure(CONCRETE_TAP, baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /1 concrete assertion failure\(s\)/);
    assert.match(msg, /genuine failure, not a flake/);
    assert.doesNotMatch(msg, /fresh runner/);
    assert.doesNotMatch(msg, /persistent condition/);
});

test("retry with no recognizable TAP shape at all -> genuine failure (no evidence of drain)", () => {
    const v = classifyPhaseFailure("", baseToFile);
    const msg = describeRetryOutcome(v);
    assert.match(msg, /genuine failure, not a flake/);
    assert.doesNotMatch(msg, /fresh runner/);
});

test("extractTapCounts: missing '# cancelled' line defaults to 0; indented lookalikes are not metadata", () => {
    const noCancelled = DRAIN_TAP.split("\n").filter((l) => l !== "# cancelled 5").join("\n");
    assert.deepEqual(extractTapCounts(noCancelled), { pass: 4352, fail: 0, cancelled: 0 });
    const indented = "ok 1 - x\n  # fail 9\n  # pass 8\n" + DRAIN_TAP;
    // the real tail still wins: first column-0 match per label
    const c = extractTapCounts(indented);
    assert.ok(c !== null && c.fail === 0 && c.pass === 4352);
    assert.equal(extractTapCounts("no summary here"), null);
});

// #4212 (#3665 round 3): the twice-drained merge-gate downgrade. Gate
// discipline (#3617): both directions asserted — downgraded when it should be,
// strict everywhere else.
test("shouldDrainPass: twice-drained + merge-gating event -> downgraded to warning-pass", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    assert.equal(shouldDrainPass(v, v, "pull_request"), true);
    assert.equal(shouldDrainPass(v, v, "merge_group"), true);
});

test("shouldDrainPass: fresh-runner probe events and local runs stay strict", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    for (const ev of ["push", "schedule", "workflow_dispatch", ""]) {
        assert.equal(shouldDrainPass(v, v, ev), false, `event=${JSON.stringify(ev)}`);
    }
});

test("shouldDrainPass: only the TWICE-drained signature downgrades — any other shape pair fails (any event)", () => {
    const drain = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    const swallowed = classifyPhaseFailure(SWALLOWED_TAP, baseToFile);
    const concrete = classifyPhaseFailure(CONCRETE_TAP, baseToFile);
    const timing = classifyPhaseFailure(TIMING_WRITETICK_TAP, baseToFile);
    assert.equal(shouldDrainPass(swallowed, drain, "pull_request"), false);
    assert.equal(shouldDrainPass(drain, swallowed, "pull_request"), false);
    assert.equal(shouldDrainPass(drain, concrete, "pull_request"), false);
    assert.equal(shouldDrainPass(concrete, drain, "pull_request"), false);
    // #4161: a timing-window retry failure never downgrades — the drain-pass
    // carve-out is exclusive to the zero-assertion drain shape.
    assert.equal(shouldDrainPass(drain, timing, "pull_request"), false);
    assert.equal(shouldDrainPass(timing, drain, "pull_request"), false);
});

test("extractDrainCancelledTests: names the drain-cancelled top-level tests", () => {
    assert.deepEqual(extractDrainCancelledTests(DRAIN_TAP), [
        "preflight rejects malformed proxy args",
    ]);
});

test("extractDrainCancelledTests: concrete failures and swallowed file deaths are not drain names", () => {
    assert.deepEqual(extractDrainCancelledTests(CONCRETE_TAP), []);
    assert.deepEqual(extractDrainCancelledTests(SWALLOWED_TAP), []);
    // #4161: timing-window failures carry failureType 'testCodeFailure' with a
    // real error message, never the cancelledByParent marker.
    assert.deepEqual(extractDrainCancelledTests(TIMING_WAITFOR_TAP), []);
    assert.deepEqual(extractDrainCancelledTests(TIMING_WRITETICK_TAP), []);
});

test("describeDrainPass: counts both attempts, names the lost tests, never claims a genuine failure", () => {
    const v = classifyPhaseFailure(DRAIN_TAP, baseToFile);
    if (v.kind !== "cancelled-drain") {
        assert.fail("fixture must classify as cancelled-drain");
        return;
    }
    const msg = describeDrainPass(v, v, ["preflight rejects malformed proxy args"], "pull_request");
    assert.match(msg, /DRAIN-PASS/);
    assert.match(msg, /pass=4352 fail=0 cancelled=5/);
    assert.match(msg, /preflight rejects malformed proxy args/);
    assert.match(msg, /pull_request/);
    assert.match(msg, /fresh runners and stay strict/);
    assert.doesNotMatch(msg, /genuine failure/);
});
