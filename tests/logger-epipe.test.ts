import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isStreamWriteError } from "../src/logger.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

test("isStreamWriteError classifies write-family stream codes only", () => {
    assert.equal(isStreamWriteError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
    for (const code of ["EIO", "EBADF", "ERR_STREAM_DESTROYED"]) {
        assert.equal(isStreamWriteError(Object.assign(new Error(code), { code })), true);
    }
    assert.equal(isStreamWriteError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), false);
    assert.equal(isStreamWriteError(new Error("plain")), false);
    assert.equal(isStreamWriteError("EPIPE"), false);
    assert.equal(isStreamWriteError(null), false);
    assert.equal(isStreamWriteError(undefined), false);
});

// #1233: on Linux stderr over a pipe is an async stream — EPIPE arrives as an
// 'error' event, not a sync throw, so the old try/catch around write() never
// saw it. Unhandled, each event rethrew as uncaughtException, the top-level
// handler logged it through the logger, and the feedback loop spammed the log
// file (77MB observed) until rotation wiped the forensic window.
test("closed stderr pipe: no uncaughtException storm, file-only logging, one warn (#1233)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-epipe-"));
    const logFile = path.join(dir, "bili.log");
    const childScript = path.join(dir, "child.ts");
    const loggerPath = path.join(root, "src", "logger.ts");

    fs.writeFileSync(childScript, [
        `import { configureLogger, closeLogger, log, isStreamWriteError } from ${JSON.stringify(loggerPath)};`,
        `configureLogger(process.env.BILI_EPIPE_LOG_FILE!);`,
        `let fired = 0;`,
        `let suppressedWriteErrors = 0;`,
        `process.on("uncaughtException", (err) => {`,
        `    fired++;`,
        `    if (isStreamWriteError(err)) {`,
        `        if (suppressedWriteErrors === 0) log("error", \`uncaughtException (stream-write; suppressing repeats): \${String(err?.stack ?? err)}\`);`,
        `        else suppressedWriteErrors += 1;`,
        `        return;`,
        `    }`,
        `    log("error", \`uncaughtException: \${String(err?.stack ?? err)}\`);`,
        `});`,
        // #1445: count-based ticks — the durable record must hold exactly 25
        // lines whatever the scheduler does to the 50ms period (a fixed-time
        // window flaked at 16 ticks on a loaded CI runner). closeLogger()
        // drains before exit so no final line is lost to process.exit.
        `let n = 0;`,
        `const timer = setInterval(() => {`,
        `    n++;`,
        `    log("info", \`tick \${n}\`);`,
        `    if (n >= 25) { clearInterval(timer); closeLogger().then(() => { process.stdout.write(\`FIRED \${fired}\\n\`); process.exit(0); }); }`,
        `}, 50);`,
        `setTimeout(() => { process.stdout.write(\`FIRED \${fired} TIMEOUT\\n\`); process.exit(3); }, 60000);`,
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", "tsx", childScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BILI_EPIPE_LOG_FILE: logFile },
    });

    let out = "";
    let earlyErr = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (earlyErr += d));

    await new Promise<void>((resolve, reject) => {
        const fail = setTimeout(() => reject(new Error(`child did not start: ${earlyErr.slice(0, 500)}`)), 15000);
        child.stderr.once("data", () => { clearTimeout(fail); resolve(); });
        child.on("exit", (code) => { clearTimeout(fail); reject(new Error(`child exited early code=${code}: ${earlyErr.slice(0, 500)}`)); });
    });

    await new Promise((r) => setTimeout(r, 300));
    child.stderr.destroy();

    const code = await new Promise<number | null>((resolve, reject) => {
        const fail = setTimeout(() => reject(new Error("child timed out after pipe close")), 30000);
        child.on("close", (c) => { clearTimeout(fail); resolve(c); });
    });

    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const ticks = lines.filter((l) => l.includes("[info] tick"));
    const uncaught = lines.filter((l) => l.includes("uncaughtException"));
    const warns = lines.filter((l) => l.includes("[warn]"));

    try { child.kill(); } catch { /* already exited */ }
    fs.rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 0, `child must exit cleanly, got ${code}; stderr: ${earlyErr.slice(0, 500)}`);
    assert.match(out, /FIRED 0/, "the uncaughtException handler must never fire");
    // Exactly the 25 ticks, in order — the count is fixed by construction
    // above, so this cannot drift with runner load (#1445).
    const nums = ticks.map((l) => l.match(/\[info\] tick (\d+)/)?.[1]).filter((x): x is string => x !== undefined);
    assert.deepEqual(nums, Array.from({ length: 25 }, (_, i) => String(i + 1)), `file-only logging must keep the complete durable record (got ${ticks.length} tick lines)`);
    assert.equal(uncaught.length, 0, `no uncaughtException spam may reach the log file: ${JSON.stringify(uncaught.slice(0, 3))}`);
    assert.equal(warns.length, 1, `exactly one degradation [warn], got ${JSON.stringify(warns)}`);
    assert.match(warns[0], /stderr unavailable/);
    assert.match(warns[0], /file-only/);
});
