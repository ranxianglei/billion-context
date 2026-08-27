import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gcDebugDir } from "../src/state-gc.ts";

function makeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-state-gc-"));
}

function writeWithMtime(dir: string, name: string, sizeBytes: number, mtimeSec: number): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(sizeBytes, 65));
    const t = new Date(mtimeSec * 1000);
    fs.utimesSync(p, t, t);
    return p;
}

test("gcDebugDir: trims oldest files (by mtime) down to maxFiles", () => {
    const dir = makeDir();
    try {
        for (let i = 0; i < 5; i++) writeWithMtime(dir, `f${i}`, 1, 1000 + i);
        const removed = gcDebugDir(dir, { maxFiles: 2, maxBytes: 1e9 }, 5000);
        assert.equal(removed, 3);
        assert.deepEqual(fs.readdirSync(dir).sort(), ["f3", "f4"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("gcDebugDir: trims oldest files down to maxBytes", () => {
    const dir = makeDir();
    try {
        writeWithMtime(dir, "a", 30, 1000);
        writeWithMtime(dir, "b", 30, 1001);
        writeWithMtime(dir, "c", 30, 1002);
        assert.equal(gcDebugDir(dir, { maxFiles: 100, maxBytes: 90 }, 5000), 0);
        writeWithMtime(dir, "d", 30, 1003);
        const removed = gcDebugDir(dir, { maxFiles: 100, maxBytes: 90 }, 5000 + 31000);
        assert.equal(removed, 1);
        assert.deepEqual(fs.readdirSync(dir).sort(), ["b", "c", "d"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("gcDebugDir: no-op when both caps hold", () => {
    const dir = makeDir();
    try {
        writeWithMtime(dir, "a", 10, 1000);
        assert.equal(gcDebugDir(dir, { maxFiles: 5, maxBytes: 100 }, 5000), 0);
        assert.deepEqual(fs.readdirSync(dir), ["a"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("gcDebugDir: throttled per directory within 30 s", () => {
    const dir = makeDir();
    try {
        for (let i = 0; i < 5; i++) writeWithMtime(dir, `f${i}`, 1, 1000 + i);
        assert.equal(gcDebugDir(dir, { maxFiles: 2, maxBytes: 1e9 }, 1000), 3);
        for (let i = 0; i < 5; i++) writeWithMtime(dir, `g${i}`, 1, 2000 + i);
        assert.equal(fs.readdirSync(dir).length, 7);
        assert.equal(gcDebugDir(dir, { maxFiles: 2, maxBytes: 1e9 }, 1000 + 29999), 0);
        assert.equal(fs.readdirSync(dir).length, 7);
        assert.equal(gcDebugDir(dir, { maxFiles: 2, maxBytes: 1e9 }, 1000 + 30000), 5);
        assert.equal(fs.readdirSync(dir).length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("gcDebugDir: missing directory is a no-op", () => {
    assert.equal(gcDebugDir(path.join(makeDir(), "nope"), {}, 12345), 0);
});

test("gcDebugDir: ignores subdirectories", () => {
    const dir = makeDir();
    try {
        const sub = path.join(dir, "sub.log");
        fs.mkdirSync(sub);
        writeWithMtime(dir, "a", 1, 1000);
        writeWithMtime(dir, "b", 1, 1001);
        assert.equal(gcDebugDir(dir, { maxFiles: 1, maxBytes: 1e9 }, 5000), 1);
        assert.ok(fs.existsSync(sub));
        assert.deepEqual(fs.readdirSync(dir).sort(), ["b", "sub.log"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
