// #5012: a host that spawns bili and captures stderr into a buffer without
// draining it fills the ~64KB pipe; Node pipe writes are BLOCKING and a full
// pipe NEVER emits an error event — the proxy's event loop wedged mid-write:
// no crash, no error line, silent file leg, the "App frozen" symptom class
// (#4992 shape). The tee decision therefore keeps the stderr leg ONLY where a
// real consumer is guaranteed to drain it: a terminal (isTTY === true). A dead
// file leg stays the crash fallback (no proof ever fires → tee survives).
// Launcher children keep their unconditional #2864 mute (launch token).
//
// Both directions pinned below: the pure predicate rows, then real-child runs
// through the exact onFileLegLive→muteStderrLeg seam createEngineContext
// installs (child stderr = genuine undrained-style pipe per #5012):
//   - non-TTY + file leg   → muted after first delivered file byte
//   - non-TTY + file OFF   → never muted (tee survives, "off" escape)

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shouldMuteStderrLegAfterFileLive } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

const ROOT = path.join(import.meta.dirname, "..");

test("shouldMuteStderrLegAfterFileLive: truth table (#5012/#2864)", () => {
    // launcher children: unconditional mute (their stderr is a file fd anyway)
    assert.equal(shouldMuteStderrLegAfterFileLive(true, true), true);
    assert.equal(shouldMuteStderrLegAfterFileLive(true, false), true);
    assert.equal(shouldMuteStderrLegAfterFileLive(true, undefined), true);
    // direct spawns: only a real terminal earns the tee
    assert.equal(shouldMuteStderrLegAfterFileLive(false, true), false);
    assert.equal(shouldMuteStderrLegAfterFileLive(false, false), true);
    // unknown consumer = not guaranteed to drain = muted
    assert.equal(shouldMuteStderrLegAfterFileLive(false, undefined), true);
});

function runLoggerChild(script: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: ROOT,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.once("error", reject);
        child.once("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

async function makeChild(dir: string, body: string[]): Promise<string> {
    const script = path.join(dir, "child.mts");
    fs.writeFileSync(script, [
        `import { existsSync, statSync } from "node:fs";`,
        // Windows ESM: a raw drive path (D:\...) is not a valid import specifier — file:// URL only
        `import { configureLogger, onFileLegLive, muteStderrLeg, shouldMuteStderrLegAfterFileLive, isStderrMuted, log, closeLogger } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "src", "logger.ts")).href)};`,
        ...body,
    ].join("\n"));
    return script;
}

test("wiring: non-TTY + file leg → pipe goes silent after first DELIVERED byte (#5012)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5012-"));
    try {
        const logFile = path.join(dir, "bili.log");
        const script = await makeChild(dir, [
            `const file = ${JSON.stringify(logFile)};`,
            "configureLogger(file);",
            "if (shouldMuteStderrLegAfterFileLive(false, process.stderr.isTTY)) onFileLegLive(() => muteStderrLeg());",
            'log("info", "issue5012-marker-before-proof");',
            "const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));",
            "for (let i = 0; i < 500 && (!existsSync(file) || statSync(file).size === 0); i++) await wait(10);",
            "if (!existsSync(file) || statSync(file).size === 0) throw new Error('file leg never proved live');",
            "await new Promise((r) => setTimeout(r, 200));",
            'log("info", "issue5012-marker-after-mute");',
            "process.stderr.write(`__muted=${isStderrMuted()}\\n`);",
            "await closeLogger();",
        ]);
        const { code, out } = await runLoggerChild(script, {});
        assert.equal(code, 0, out);
        assert.match(out, /__muted=true/);
        // the pre-proof line was still teed…
        assert.match(out, /issue5012-marker-before-proof/);
        // …and after the file leg proved live the pipe carries NOTHING more.
        assert.doesNotMatch(out, /issue5012-marker-after-mute/, "post-proof lines must not reach an undrained pipe");
        // both markers survived in the durable leg
        const content = fs.readFileSync(logFile, "utf8");
        assert.match(content, /issue5012-marker-before-proof/);
        assert.match(content, /issue5012-marker-after-mute/);
    } finally {
        await rmrf(dir);
    }
});

test("wiring: file leg OFF → tee survives end-to-end (crash fallback, ACP_LOG_FILE=off)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5012-"));
    try {
        const script = await makeChild(dir, [
            "configureLogger(process.env.ACP_LOG_FILE || undefined);",
            "if (shouldMuteStderrLegAfterFileLive(false, process.stderr.isTTY)) onFileLegLive(() => muteStderrLeg());",
            'log("info", "issue5012-tee-survives");',
            "await new Promise((r) => setTimeout(r, 200));",
            "process.stderr.write(`__muted=${isStderrMuted()}\\n`);",
            "await closeLogger();",
        ]);
        const { code, out } = await runLoggerChild(script, { ACP_LOG_FILE: "off" });
        assert.equal(code, 0, out);
        assert.match(out, /issue5012-tee-survives/, "with no file leg the stderr tee must carry every line");
        assert.match(out, /__muted=false/);
    } finally {
        await rmrf(dir);
    }
});
