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
} from "../src/logger.ts";

/** Poll until the file's size is stable across a few checks (stream flushed). */
async function settle(file: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    let last = -1;
    let stable = 0;
    while (Date.now() - start < timeoutMs) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
        if (size === last) {
            stable++;
            if (stable >= 3) return;
        } else {
            stable = 0;
            last = size;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("external rename: subsequent lines land in the new file, .old frozen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        log("info", "before-1");
        log("info", "before-2");
        await settle(file);

        fs.renameSync(file, file + ".old");
        const oldSize = fs.statSync(file + ".old").size;
        assert.ok(oldSize > 0, "pre-rename lines must be flushed to .old");

        log("info", "after-1");
        log("info", "after-2");
        await settle(file);

        assert.ok(fs.existsSync(file), "new bili.log must be recreated");
        const content = fs.readFileSync(file, "utf8");
        assert.ok(content.includes("after-1"), "new file must receive post-rename lines");
        assert.ok(content.includes("after-2"));
        assert.ok(!content.includes("before-1"), "pre-rename lines must not leak into the new file");
        assert.equal(fs.statSync(file + ".old").size, oldSize, ".old must not grow after rotation");
    } finally {
        closeLogger();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("reopen failure: degrades to stderr-only with one [warn], no crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-"));
    const file = path.join(dir, "sub", "bili.log");
    fs.mkdirSync(path.join(dir, "sub"));
    configureLogger(file);
    const warns: string[] = [];
    setLogCapture((level, msg) => {
        if (level === "warn") warns.push(msg);
    });
    try {
        log("info", "works-before");
        await settle(file);

        // Clobber the path: remove the dir, then put a regular file where the
        // dir was, so mkdirSync(dirname) throws ENOTDIR on every reopen.
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(dir, "blocker");

        log("info", "after-clobber"); // must not throw
        log("info", "still-alive"); // must not throw, must not re-warn

        assert.equal(warns.length, 1, "exactly one [warn] per degradation episode");
        assert.match(warns[0], /bili\.log/);
        assert.match(warns[0], /stderr-only/);
        assert.ok(!fs.existsSync(file), "degraded logging must not resurrect the file");
    } finally {
        setLogCapture(null);
        closeLogger();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("internal 10MB rotation: post-rotation line lands in the fresh file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-"));
    const file = path.join(dir, "bili.log");
    const stderrSink = fs.createWriteStream(path.join(dir, "stderr.txt"));
    const origStderr = process.stderr;
    Object.defineProperty(process, "stderr", { value: stderrSink, configurable: true });
    configureLogger(file);
    try {
        log("info", "x".repeat(11 * 1024 * 1024));
        await settle(file);
        log("info", "post-rotation");
        await settle(file);

        const content = fs.readFileSync(file, "utf8");
        assert.ok(content.includes("post-rotation"), "post-rotation line must land in the fresh file");
        assert.ok(!content.includes("xxx"), "oversized line must have rotated out");
        const oldSize = fs.statSync(file + ".old").size;
        assert.ok(oldSize >= 11 * 1024 * 1024, ".old must hold the rotated oversized file");
    } finally {
        closeLogger();
        Object.defineProperty(process, "stderr", { value: origStderr, configurable: true });
        await new Promise<void>((resolve) => {
            try {
                stderrSink.end(() => resolve());
            } catch {
                resolve();
            }
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
