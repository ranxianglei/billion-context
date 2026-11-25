/**
 * #5940 regression: the background quick_check worker's stderr must not leak
 * into the host terminal (the agent's Pi TUI in inline mode). Node emits
 * "ExperimentalWarning: SQLite is an experimental feature" once per thread on
 * first node:sqlite use; with default worker stdio that notice printed
 * straight into the interactive surface mid-session while the check itself
 * passed. The fix captures the worker stderr (stderr: true) and drops only
 * the known notice block; everything else is routed to loggerLog diagnostics
 * (file-only in the inline lane, whose stderr leg is muted against the TUI).
 *
 * Facets covered:
 *   1. filter unit tests, BOTH directions (#3617 gate discipline): the known
 *      SQLite notice block (header + hint/stack trailer) is dropped whole —
 *      with and without the "(node:<pid>)" prefix — while unrelated
 *      warnings/errors/stacks are kept, including another feature's
 *      ExperimentalWarning (the filter must stay narrow);
 *   2. wiring: the REAL scheduleBackgroundIntegrityCheck on a fixture DB run
 *      in a child process — verdict "ok" delivered, nothing leaks to the
 *      child's own stderr, no hang (a captured pipe with no consumer would
 *      backpressure the worker);
 *   3. teeth probe: whether THIS runtime still emits the notice (Node may
 *      stabilize node:sqlite someday) — recorded via t.diagnostic so the
 *      no-leak assertion is known to have teeth where the bug can manifest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIntegrityWorkerStderrFilter, scheduleBackgroundIntegrityCheck } from "../src/storage/integrity-check.js";
import { openSqliteDatabase, probeBuiltinSqlite } from "../src/storage/driver.js";

const NOTICE_HEADER = "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time";
const TRACE_HINT = "(Use `node --trace-warnings ...` to show where the warning was created)";

// --- facet 1: the line filter, both directions ------------------------------

test("#5940 filter: the known SQLite notice block is dropped whole", () => {
    const keep = createIntegrityWorkerStderrFilter();
    const block = [
        NOTICE_HEADER,
        TRACE_HINT,
        "    at require (node:internal/modules/helpers:152:16)",
        "    at openReadOnly ([worker eval]:19:19)",
        "    at [worker eval]:21:16",
        "",
    ];
    for (const line of block) assert.equal(keep(line), false, `must drop: ${line}`);
});

test("#5940 filter: header without the process prefix is dropped too", () => {
    const keep = createIntegrityWorkerStderrFilter();
    assert.equal(keep("ExperimentalWarning: SQLite is an experimental feature and might change at any time"), false);
    assert.equal(keep(TRACE_HINT), false);
});

test("#5940 filter: unrelated warnings and errors are KEPT", () => {
    const keep = createIntegrityWorkerStderrFilter();
    // A different feature's experimental notice must NOT be swallowed — the
    // filter is scoped to the SQLite notice only (narrowness gate).
    assert.equal(keep("(node:123) ExperimentalWarning: SomeOtherFeature is an experimental feature and might change at any time"), true);
    assert.equal(keep("(node:123) DeprecationWarning: legacyApi() is deprecated"), true);
    assert.equal(keep("Error: something broke"), true);
    assert.equal(keep("    at boom (app.js:1:1)"), true); // stack frame OUTSIDE a notice block stays
    assert.equal(keep("plain informational line"), true);
});

test("#5940 filter: keeping resumes once the notice block ends", () => {
    const keep = createIntegrityWorkerStderrFilter();
    assert.equal(keep(NOTICE_HEADER), false);
    assert.equal(keep(TRACE_HINT), false);
    assert.equal(keep("    at require (node:internal/modules/helpers:152:16)"), false);
    assert.equal(keep("real error line after the block"), true);
    assert.equal(keep("    at another frame (app.js:2:2)"), true);
});

test("#5940 filter: a near-miss name does not trigger the block", () => {
    const keep = createIntegrityWorkerStderrFilter();
    // "SQLiteFoo" contains neither the full notice phrase nor its trailer —
    // it must pass through untouched.
    assert.equal(keep("(node:123) ExperimentalWarning: SQLiteFoo is an experimental feature and might change at any time"), true);
});

// --- facet 2: real worker path in a child process ---------------------------

const HAS_BUILTIN_SQLITE = probeBuiltinSqlite();
const SKIP_NO_BUILTIN_SQLITE = HAS_BUILTIN_SQLITE ? undefined : "no node:sqlite builtin on this host — the background worker path cannot run";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-issue5940-"));
}

function seedValidDb(dbPath: string): void {
    const { db } = openSqliteDatabase(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO seed (v) VALUES (?)");
    for (let i = 0; i < 50; i++) ins.run(`row-${i}-${"x".repeat(100)}`);
    db.close();
}

/** Does THIS node runtime still print the SQLite experimental notice? (Node
 * may stabilize node:sqlite someday; then facet 2's assertion holds
 * trivially and the probe says so.) */
function runtimeEmitsSqliteNotice(): boolean {
    const r = spawnSync(process.execPath, ["-e", 'new (require("node:sqlite").DatabaseSync)(":memory:").close()'], { encoding: "utf8", timeout: 30000 });
    return (r.stderr ?? "").includes("ExperimentalWarning: SQLite");
}

test("#5940 wiring: the background worker's stderr never reaches the host terminal", { skip: SKIP_NO_BUILTIN_SQLITE }, (t) => {
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        seedValidDb(dbPath);

        // Child script: drive the REAL scheduleBackgroundIntegrityCheck on the
        // fixture and report the verdict. Its own stderr is what a host TUI
        // would see in this scenario — so anything leaking there is the bug.
        const srcUrl = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "src/storage/integrity-check.ts")).href;
        const childScript = `${dir}/child.mjs`;
        writeFileSync(childScript, [
            `import { scheduleBackgroundIntegrityCheck } from "${srcUrl}";`,
            "scheduleBackgroundIntegrityCheck(process.argv[2], (ok) => {",
            '    console.log(ok ? "VERDICT_OK" : "VERDICT_FAIL");',
            "    // let trailing captured-stderr data flush through the pipe before exit",
            "    setTimeout(() => process.exit(ok ? 0 : 1), 750);",
            "});",
            'setTimeout(() => { console.error("CHILD_WATCHDOG_TIMEOUT"); process.exit(3); }, 30000);',
            "",
        ].join("\n"));

        const res = spawnSync(process.execPath, ["--import", "tsx", childScript, dbPath], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });

        t.diagnostic(`runtime ${runtimeEmitsSqliteNotice() ? "EMITS" : "does not emit"} the SQLite experimental notice — the no-leak assertion ${runtimeEmitsSqliteNotice() ? "has teeth here" : "holds trivially (node:sqlite stabilized?)"}; child exit=${res.status}`);
        assert.equal(res.status, 0, `child failed (status ${res.status}): stdout=${res.stdout}\nstderr=${res.stderr}`);
        assert.ok(res.stdout.includes("VERDICT_OK"), `verdict ok expected, stdout=${res.stdout}`);
        // The module's own logger routing reached the child's stderr in proxy
        // mode — proof the diagnostics channel is alive for kept lines.
        assert.ok(res.stderr.includes("background quick_check started"), `logger routing missing, stderr=${res.stderr}`);
        // THE regression: the worker's notice must not land on the host terminal.
        assert.ok(!res.stderr.includes("ExperimentalWarning: SQLite"), `SQLite experimental notice leaked to the host terminal:\n${res.stderr}`);
        assert.ok(!res.stderr.includes("--trace-warnings"), `notice-trailer fragment leaked to the host terminal:\n${res.stderr}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
