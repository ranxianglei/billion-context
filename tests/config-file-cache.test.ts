import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { loadConfigFile } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";

// #2078: loadConfigFile() feeds the file tier of every knob (#2030) — ~5-10
// calls per request used to each do readFileSync+JSON.parse. The cache keys on
// the RAW FILE TEXT (not mtime/size: back-to-back writes can share a sub-ms
// mtime, which would serve stale values right after a web-UI Apply), so any
// external rewrite is visible on the next call while unchanged content never
// re-parses. Explicit past Dates keep every step deterministic.

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-02T00:00:00Z");
const T2 = new Date("2026-01-03T00:00:00Z");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-cfg-cache-"));
const savedConfigEnv = process.env.BILI_CONFIG_FILE;

test.after(() => {
    setLogCapture(null);
    if (savedConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigEnv;
    fs.rmSync(root, { recursive: true, force: true });
});

function pointAt(name: string): string {
    const f = path.join(root, name);
    process.env.BILI_CONFIG_FILE = f;
    return f;
}

function writeAt(f: string, content: string, t: Date): void {
    fs.writeFileSync(f, content);
    fs.utimesSync(f, t, t);
}

test("#2078: unchanged file serves the same cached object (no re-read)", () => {
    const f = pointAt("stable.json");
    writeAt(f, JSON.stringify({ update: { checkIntervalMs: 111 } }), T0);
    assert.deepEqual(loadConfigFile(), { update: { checkIntervalMs: 111 } });
    assert.equal(loadConfigFile(), loadConfigFile());
});

test("#2078: hot reload — a real rewrite is visible on the next call", () => {
    const f = pointAt("reload.json");
    writeAt(f, JSON.stringify({ update: { checkIntervalMs: 111 } }), T0);
    assert.equal(loadConfigFile().update?.checkIntervalMs, 111);
    writeAt(f, JSON.stringify({ update: { checkIntervalMs: 222 } }), T1);
    assert.equal(loadConfigFile().update?.checkIntervalMs, 222);
});

test("#2078: same-size rewrite with restored mtime is still visible (content is truth)", () => {
    const f = pointAt("stale.json");
    writeAt(f, JSON.stringify({ update: { checkIntervalMs: 111 } }), T0);
    assert.equal(loadConfigFile().update?.checkIntervalMs, 111);
    // Same byte length, mtime forced back to T0. A stat-keyed cache would serve
    // the stale value here — the exact failure mode measured on real FSes
    // (back-to-back writes sharing one sub-ms mtime). Content keying sees 222.
    writeAt(f, JSON.stringify({ update: { checkIntervalMs: 222 } }), T0);
    assert.equal(loadConfigFile().update?.checkIntervalMs, 222, "changed content must be visible even with identical mtime+size");
});

test("#2078: identical-content rewrite does not re-parse (same object reference)", () => {
    const f = pointAt("identical.json");
    const content = JSON.stringify({ update: { checkIntervalMs: 111 } });
    writeAt(f, content, T0);
    const first = loadConfigFile();
    writeAt(f, content, T1); // cp -p / rsync --times style restoration
    assert.equal(loadConfigFile(), first, "unchanged content serves the cached object");
});

test("#2078: missing file → {} without throwing", () => {
    pointAt("never-created.json");
    assert.deepEqual(loadConfigFile(), {});
});

test("#2078: malformed file logs once per change, not once per call", () => {
    const f = pointAt("malformed.json");
    const seen: string[] = [];
    setLogCapture((_level, msg) => { if (msg.includes("failed to parse")) seen.push(msg); });
    try {
        writeAt(f, '{"update": oops', T0);
        for (let i = 0; i < 5; i++) assert.deepEqual(loadConfigFile(), {});
        assert.equal(seen.length, 1, `first corruption logs once across 5 calls (got ${seen.length})`);
        writeAt(f, JSON.stringify({ update: { checkIntervalMs: 9 } }), T1);
        assert.equal(loadConfigFile().update?.checkIntervalMs, 9);
        loadConfigFile();
        assert.equal(seen.length, 1, "valid rewrite logs nothing");
        writeAt(f, '{"other": [', T2);
        assert.deepEqual(loadConfigFile(), {});
        loadConfigFile();
        assert.equal(seen.length, 2, "second distinct corruption logs exactly once more");
    } finally {
        setLogCapture(null);
    }
});

test("#2078: switching BILI_CONFIG_FILE re-resolves", () => {
    const a = pointAt("a.json");
    writeAt(a, JSON.stringify({ update: { checkIntervalMs: 1 } }), T0);
    const b = pointAt("b.json");
    writeAt(b, JSON.stringify({ update: { checkIntervalMs: 2 } }), T0);
    assert.equal(loadConfigFile().update?.checkIntervalMs, 2);
    process.env.BILI_CONFIG_FILE = a;
    assert.equal(loadConfigFile().update?.checkIntervalMs, 1);
});
