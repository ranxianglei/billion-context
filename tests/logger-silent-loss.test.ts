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
    onFileLegLive,
} from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3857: a log file the OS refuses to deliver to (ASYNChronous failure —
 * EPERM/EACCES on a locked or sandboxed path) must not lose every line with
 * zero trace: one [warn] per degradation episode, and the muted stderr
 * fallback (#2864) must come back so a launcher-spawned child keeps durable
 * output in its %TEMP% port log. A DIRECTORY as the log path makes the leg
 * undeliverable deterministically on every platform — POSIX fails the open
 * (EISDIR); win32 (node 22 observed in CI) opens fine and only the writes
 * fail — so the suite pins the contract on DELIVERY, not on open().
 */

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

test("#3857: undeliverable file leg warns once and restores the muted stderr fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    fs.mkdirSync(path.join(dir, "bili.log")); // a DIRECTORY: undeliverable on every platform (POSIX: open fails; win32: writes fail)
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(path.join(dir, "bili.log"));
    try {
        muteStderrLeg(); // worst case: #2864 mute already fired on pending state
        log("info", "early-line"); // pre-failure + muted — legitimately may vanish
        await waitFor(() => warns.length >= 1, "degradation warn");
        assert.ok(warns[0].includes("unavailable"), `warn names the failure (got: ${warns[0]})`);
        assert.ok(warns[0].includes("stderr-only"), "warn states the fallback mode");
        assert.equal(isFileLoggingActive(), false, "a leg that never delivered a byte is not 'active'");
        log("info", "late-line");
        await waitFor(() => cap.lines.some((l) => l.includes("late-line")), "late-line on restored stderr");
        assert.ok(cap.lines.some((l) => l.includes("unavailable")), "the warn itself reached the restored stderr leg");
        log("info", "third-line");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(warns.filter((w) => w.includes("unavailable")).length, 1, "one [warn] per degradation episode");
        assert.ok(cap.lines.some((l) => l.includes("third-line")), "fallback keeps carrying lines");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: onFileLegLive fires exactly once, only after a proven delivery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    const file = path.join(dir, "bili.log");
    let fires = 0;
    onFileLegLive(() => { fires++; });
    configureLogger(file);
    try {
        assert.equal(fires, 0, "must not fire before anything has been delivered");
        log("info", "tick");
        // Wait on the hook itself: fd visibility ('open') precedes the first
        // flushed write, so isFileLoggingActive() can be true pre-delivery.
        await waitFor(() => fires === 1, "delivered write fires the hook");
        assert.equal(fires, 1, "fires once when the first byte lands");
        log("info", "tick2");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(fires, 1, "does not re-fire per write");
    } finally {
        onFileLegLive(null);
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: onFileLegLive never fires when the leg cannot deliver", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    fs.mkdirSync(path.join(dir, "bili.log")); // a DIRECTORY: undeliverable on every platform (POSIX: open fails; win32: writes fail)
    let fires = 0;
    onFileLegLive(() => { fires++; });
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(path.join(dir, "bili.log"));
    try {
        log("info", "probe");
        await waitFor(() => warns.length >= 1, "degradation warn");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(fires, 0, "no live-hook callback for an undeliverable leg");
    } finally {
        onFileLegLive(null);
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("#3857: late registration observes an already-proven-live stream immediately", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-silent-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        let proven = false;
        onFileLegLive(() => { proven = true; });
        log("info", "seed");
        await waitFor(() => proven, "logger has observed the delivered write");
        let fires = 0;
        onFileLegLive(() => { fires++; });
        assert.equal(fires, 1, "registration while live fires immediately");
    } finally {
        onFileLegLive(null);
        await closeLogger();
        rmrf(dir);
    }
});
