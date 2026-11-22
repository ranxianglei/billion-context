import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dumpRejectedBody, dumpSummaryRejection } from "../src/error-dump.js";
import { stripDumpBanner } from "../src/dump-banner.js";
import { setLogCapture } from "../src/logger.js";
import { rmrf } from "./tmp-rm.js";

const NOW = 1_700_000_000_000;

function setup(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-incident-collision-"));
    const previousGate = process.env.BILI_DUMP_4XX;
    const previousDir = process.env.ACP_DUMP_DIR;
    process.env.BILI_DUMP_4XX = "1";
    process.env.ACP_DUMP_DIR = dir;
    setLogCapture(() => {});
    t.mock.method(Date, "now", () => NOW);
    t.after(async () => {
        if (previousGate === undefined) delete process.env.BILI_DUMP_4XX; else process.env.BILI_DUMP_4XX = previousGate;
        if (previousDir === undefined) delete process.env.ACP_DUMP_DIR; else process.env.ACP_DUMP_DIR = previousDir;
        setLogCapture(null);
        await rmrf(dir);
    });
    return dir;
}

function contents(file: string): string {
    return stripDumpBanner(fs.readFileSync(file, "utf8"));
}

test("same-millisecond rejected bodies preserve both incident snapshots", (t) => {
    const dir = setup(t);
    const first = dumpRejectedBody(400, "session", "first rejected body");
    assert.ok(first);
    const original = fs.readFileSync(first, "utf8");
    const second = dumpRejectedBody(400, "session", "second rejected body");
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(fs.readFileSync(first, "utf8"), original);
    assert.equal(contents(first), "first rejected body");
    assert.equal(contents(second), "second rejected body");
    assert.equal(fs.readdirSync(dir).length, 2);
});

test("same-millisecond summary failures keep both exchanges", (t) => {
    setup(t);
    const first = dumpSummaryRejection(413, "session", "request one", "response one");
    const second = dumpSummaryRejection(413, "session", "request two", "response two");
    assert.ok(first && second);
    assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(contents(first)), { status: 413, request: "request one", response: "response one" });
    assert.deepEqual(JSON.parse(contents(second)), { status: 413, request: "request two", response: "response two" });
});

for (const kind of ["main", "summary"] as const) {
    test(`${kind} dumps do not replace evidence left by another process`, (t) => {
        const dir = setup(t);
        const prefix = kind === "main" ? "err" : "summary-err";
        const existing = path.join(dir, `${prefix}-${NOW}-session-400.json`);
        fs.writeFileSync(existing, "existing incident evidence\n");
        const out = kind === "main"
            ? dumpRejectedBody(400, "session", "new rejected body")
            : dumpSummaryRejection(400, "session", "new request", "new response");
        assert.ok(out);
        assert.notEqual(out, existing);
        assert.equal(fs.readFileSync(existing, "utf8"), "existing incident evidence\n");
        assert.equal(fs.readdirSync(dir).length, 2);
    });
}

test("sanitized session-name collisions do not overwrite another session", (t) => {
    setup(t);
    const first = dumpRejectedBody(400, "team/session", "session with slash");
    const second = dumpRejectedBody(400, "team_session", "session with underscore");
    assert.ok(first && second);
    assert.notEqual(first, second);
    assert.equal(contents(first), "session with slash");
    assert.equal(contents(second), "session with underscore");
});

test("a burst preserves each incident and its returned path", (t) => {
    const dir = setup(t);
    const files = Array.from({ length: 32 }, (_, i) => dumpRejectedBody(429, "burst", `request ${i}`));
    assert.equal(new Set(files).size, files.length);
    for (const [i, file] of files.entries()) {
        assert.ok(file);
        assert.equal(contents(file), `request ${i}`);
    }
    assert.equal(fs.readdirSync(dir).length, files.length);
});

test("a collision suffix still fits when the existing session filename is long", (t) => {
    setup(t);
    const session = "s".repeat(200);
    const first = dumpSummaryRejection(400, session, "first request", "first response");
    const second = dumpSummaryRejection(400, session, "second request", "second response");
    assert.ok(first && second);
    assert.notEqual(first, second);
    assert.equal((JSON.parse(contents(first)) as { request: string }).request, "first request");
    assert.equal((JSON.parse(contents(second)) as { request: string }).request, "second request");
});

test("a non-collision write failure stays fail-soft and is not retried", (t) => {
    const dir = setup(t);
    const original = fs.writeFileSync;
    let attempts = 0;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "string" && args[0].startsWith(dir + path.sep)) {
            attempts++;
            throw Object.assign(new Error("read-only fixture"), { code: "EROFS" });
        }
        return original(...args);
    });
    assert.equal(dumpRejectedBody(400, "session", "body"), null);
    assert.equal(attempts, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
});
