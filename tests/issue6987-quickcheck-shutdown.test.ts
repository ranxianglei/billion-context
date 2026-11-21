/**
 * #6987 regression: a clean shutdown must not wait for a running background
 * quick_check. The scan is one synchronous sqlite3_step that nothing can
 * interrupt, and process.exit() joins every worker thread before it returns,
 * so a relay stopped during the ~45 min scan of a 10 GB store hung in exit
 * until the supervisor's SIGKILL. The test holds the scan inside one endless
 * sqlite3_step (recursive CTE through the SQL seam), calls process.exit(0),
 * and requires the process to exit promptly and the scan to be gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSqliteDatabase, isBunRuntime, probeBuiltinSqlite } from "../src/storage/driver.js";

const SKIP = !probeBuiltinSqlite() ? "no node:sqlite builtin on this host" : isBunRuntime() ? "bun keeps the worker-thread scan" : undefined;

const ENDLESS_SCAN = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS quick_check FROM c";

function processGone(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
}

test("#6987: process.exit during a running background quick_check exits promptly and stops the scan", { skip: SKIP }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-issue6987-"));
    try {
        const dbPath = join(dir, "index.db");
        const { db } = openSqliteDatabase(dbPath);
        db.exec("CREATE TABLE seed (id INTEGER PRIMARY KEY, v TEXT)");
        db.close();

        const root = fileURLToPath(new URL("..", import.meta.url));
        const srcUrl = pathToFileURL(join(root, "src/storage/integrity-check.ts")).href;
        const childScript = join(dir, "child.mjs");
        writeFileSync(childScript, [
            `import * as check from "${srcUrl}";`,
            `check.setIntegrityCheckSqlForTests(${JSON.stringify(ENDLESS_SCAN)});`,
            'check.scheduleBackgroundIntegrityCheck(process.argv[2], () => console.log("VERDICT"));',
            "setTimeout(() => {",
            '    console.log(`PID ${check.integrityCheckPidForTests?.(process.argv[2]) ?? "none"}`);',
            "    process.exit(0);",
            "}, 1500);",
            "",
        ].join("\n"));

        const started = Date.now();
        const res = spawnSync(process.execPath, ["--import", "tsx", childScript, dbPath], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
        const elapsedMs = Date.now() - started;

        assert.equal(res.signal, null, `process.exit(0) hung until the test killed it after ${elapsedMs} ms; stderr=${res.stderr}`);
        assert.equal(res.status, 0, `child failed (status ${res.status}): stdout=${res.stdout}\nstderr=${res.stderr}`);
        assert.ok(!res.stdout.includes("VERDICT"), `the endless scan cannot have produced a verdict: ${res.stdout}`);

        const pid = Number(/PID (\d+)/.exec(res.stdout)?.[1]);
        assert.ok(Number.isInteger(pid) && pid > 0, `scan process pid missing: ${res.stdout}`);
        const deadline = Date.now() + 5_000;
        while (!processGone(pid) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(processGone(pid), `scan process ${pid} still running after the relay exited`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
