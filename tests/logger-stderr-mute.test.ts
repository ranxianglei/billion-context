import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    configureLogger,
    log,
    closeLogger,
    setLogCapture,
    muteStderrLeg,
    isFileLoggingActive,
} from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/** Synchronous stderr stand-in: captures every line written through
 *  process.stderr while the test holds it (the logger reads process.stderr at
 *  call time, so the swap is visible without touching the real stream). */
function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr;
    Object.defineProperty(process, "stderr", {
        configurable: true,
        value: { write: (chunk: unknown) => { lines.push(String(chunk)); return true; } },
    });
    return { lines, restore: () => Object.defineProperty(process, "stderr", { configurable: true, value: orig }) };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

async function settle(file: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    let last = -1;
    let stable = 0;
    while (Date.now() - start < timeoutMs) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
        if (size > 0 && size === last) {
            stable++;
            if (stable >= 3) return;
        } else {
            stable = 0;
            last = size;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`settle timed out: ${file}`);
}

test("muteStderrLeg: file leg live → stderr silent, file still written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-mute-"));
    const file = path.join(dir, "bili.log");
    const cap = captureStderr();
    configureLogger(file);
    try {
        // #3857: liveness is proven by a DELIVERED write (an async open — or on
        // win32, an fd whose writes fail — does not count), so seed one first.
        log("info", "seed");
        // fd visibility alone lags behind delivery ('open' precedes the first
        // flushed write) — wait for a byte on disk, not an open event.
        // existsSync first: the file only exists once the async open lands.
        await waitFor(() => fs.existsSync(file) && fs.statSync(file).size > 0, "delivered write proves the leg");
        log("info", "pre-mute");
        assert.ok(cap.lines.some((l) => l.includes("pre-mute")), "unmuted tee must reach stderr");
        assert.equal(isFileLoggingActive(), true);

        muteStderrLeg();
        log("info", "post-mute");
        assert.ok(!cap.lines.some((l) => l.includes("post-mute")), "muted leg must not reach stderr");
        await settle(file);
        const content = fs.readFileSync(file, "utf8");
        assert.ok(content.includes("post-mute"), "file leg must keep writing while muted");
    } finally {
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("file-leg death un-mutes the stderr fallback (spawned child keeps durable output)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-mute-"));
    const file = path.join(dir, "sub", "bili.log");
    fs.mkdirSync(path.join(dir, "sub"));
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(file);
    try {
        log("info", "works-before");
        await settle(file);

        muteStderrLeg();
        log("info", "muted-line");
        assert.ok(!cap.lines.some((l) => l.includes("muted-line")), "muted leg stays silent while the file leg is healthy");

        rmrf(dir);
        fs.writeFileSync(dir, "blocker");

        log("info", "after-clobber"); // must not throw
        log("info", "still-alive");

        assert.equal(warns.length, 1, "exactly one [warn] per degradation episode");
        assert.ok(cap.lines.some((l) => l.includes("stderr-only")), "degradation [warn] lands on the restored stderr leg");
        assert.ok(cap.lines.some((l) => l.includes("still-alive")), "stderr fallback un-muted after file-leg death");
        assert.ok(!fs.existsSync(file), "degraded logging must not resurrect the file");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});
