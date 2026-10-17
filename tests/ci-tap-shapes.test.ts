import assert from "node:assert/strict";
import test from "node:test";
import { extractDrainCancelledFiles, extractSwallowedFiles, parseTapSummary } from "../scripts/ci-tap-shapes.mjs";

// #3356: the runner's retry gate must recognize EXACTLY two flake shapes and
// hard-fail on everything else. Fixtures below are modeled on real red legs
// (run 39024457776 drain-cancel; the #3029 swallowed shape), including the
// TAP-shaped noise lines suites print themselves (`# \# tests 39`).

const baseToFile = new Map<string, string>([
    ["pi-omp-fork-adopt.test.ts", "tests/pi-omp-fork-adopt.test.ts"],
    ["stream-keepalive.test.ts", "tests/stream-keepalive.test.ts"],
    ["auto-fold-backoff.test.ts", "tests/auto-fold-backoff.test.ts"],
]);

const DRAIN_CANCELLED = [
    "1..2952",
    "ok 627 - clientError: malformed body yields a 400, not a crash",
    "not ok 1581 - full chain: omp lane adopts behind its own identity register (#2399 stage 2 / B-plan)",
    "  ---",
    "    duration_ms: 5139.500123",
    "    type: 'test'",
    "    location: 'D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\pi-omp-fork-adopt.test.ts:1:17355'",
    "    failureType: 'cancelledByParent'",
    "    error: 'Promise resolution is still pending but the event loop has already resolved'",
    "    code: 'ERR_TEST_FAILURE'",
    "  ...",
    "not ok 1582 - full chain: pi lane resolves a path-shaped parentSession header and adopts (#2399 stage 2)",
    "  ---",
    "    duration_ms: 0",
    "    type: 'test'",
    "    location: 'D:\\\\a\\\\billion-context\\\\billion-context\\\\tests\\\\pi-omp-fork-adopt.test.ts:1:18211'",
    "    failureType: 'cancelledByParent'",
    "    code: 'ERR_TEST_FAILURE'",
    "  ...",
    "# \\# tests 39",
    "# tests 2989",
    "# suites 17",
    "# pass 2968",
    "# fail 0",
    "# cancelled 9",
    "# skipped 12",
    "# todo 0",
].join("\n");

const SWALLOWED = [
    "1..10",
    "ok 41 - keep-alive idle socket reaps after the configured budget",
    "not ok 42 - tests/stream-keepalive.test.ts",
    "  ---",
    "    duration_ms: 1234.5",
    "    type: 'test'",
    "    location: 'tests/stream-keepalive.test.ts:1:1'",
    "    failureType: 'testCodeFailure'",
    "    error: 'test failed'",
    "  ...",
    "# tests 10",
    "# pass 9",
    "# fail 1",
    "# cancelled 0",
].join("\n");

const REAL_FAILURE_WITH_CASCADE = [
    "1..12",
    "not ok 10 - auto-fold backoff: a pure queue-drop does NOT arm the cooldown",
    "  ---",
    "    duration_ms: 88.2",
    "    type: 'test'",
    "    location: 'tests/auto-fold-backoff.test.ts:1:4412'",
    "    failureType: 'testCodeFailure'",
    "    error: 'Expected values to be strictly equal'",
    "    code: 'ERR_ASSERTION'",
    "  ...",
    "not ok 11 - sibling test in the same file",
    "  ---",
    "    duration_ms: 0",
    "    type: 'test'",
    "    failureType: 'cancelledByParent'",
    "    code: 'ERR_TEST_FAILURE'",
    "  ...",
    "# tests 12",
    "# pass 10",
    "# fail 1",
    "# cancelled 1",
].join("\n");

test("parseTapSummary: last summary block wins, escaped noise lines are ignored", () => {
    const s = parseTapSummary(DRAIN_CANCELLED);
    assert.ok(s);
    assert.equal(s.tests, 2989);
    assert.equal(s.pass, 2968);
    assert.equal(s.fail, 0);
    assert.equal(s.cancelled, 9);
});

test("drain-cancelled shape: fail 0 + every not-ok cancelledByParent -> affected files", () => {
    assert.deepEqual(extractDrainCancelledFiles(DRAIN_CANCELLED, baseToFile), ["tests/pi-omp-fork-adopt.test.ts"]);
});

test("drain-cancelled shape: CRLF line endings (windows) classify identically", () => {
    assert.deepEqual(extractDrainCancelledFiles(DRAIN_CANCELLED.replace(/\n/g, "\r\n"), baseToFile), ["tests/pi-omp-fork-adopt.test.ts"]);
});

test("swallowed shape: file-level not ok with only 'test failed' payload -> affected files", () => {
    assert.deepEqual(extractSwallowedFiles(SWALLOWED, baseToFile), ["tests/stream-keepalive.test.ts"]);
});

test("real assertion failure voids the drain-cancelled shape even with cancels present", () => {
    assert.equal(extractDrainCancelledFiles(REAL_FAILURE_WITH_CASCADE, baseToFile), null);
});

test("real assertion failure is not the swallowed shape either", () => {
    assert.deepEqual(extractSwallowedFiles(REAL_FAILURE_WITH_CASCADE, baseToFile), []);
});

test("swallowed output is not the drain-cancelled shape (fail > 0)", () => {
    assert.equal(extractDrainCancelledFiles(SWALLOWED, baseToFile), null);
});

test("summary-less output classifies as neither shape", () => {
    const noSummary = "not ok 1 - some test\n  ---\n    failureType: 'cancelledByParent'\n  ...\n";
    assert.equal(parseTapSummary(noSummary), null);
    assert.equal(extractDrainCancelledFiles(noSummary, baseToFile), null);
});

test("fail 0 + cancel count but a non-cancel not-ok entry voids the drain-cancelled shape", () => {
    const mixed = [
        "1..2",
        "not ok 1 - a test that died without the cancel marker",
        "  ---",
        "    duration_ms: 5.0",
        "    failureType: 'otherKindOfBadness'",
        "  ...",
        "# tests 2",
        "# pass 0",
        "# fail 0",
        "# cancelled 1",
    ].join("\n");
    assert.equal(extractDrainCancelledFiles(mixed, baseToFile), null);
});
