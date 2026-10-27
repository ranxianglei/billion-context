import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

process.env.NODE_ENV = "test";

import { loadConfigFile, parseRouteEntry } from "../src/config.ts";
import { resolveCacheKeepalive } from "../src/cache-keepalive.ts";
import { setLogCapture } from "../src/logger.ts";
import { handleConfigPut } from "../src/web/api.js";

// #4200: the GLOBAL cacheKeepalive block at the config root was only listed in
// KNOWN_TOP_LEVEL_KEYS — loadConfigFile never ran the strict #1909 parser on
// it, so a typo'd block loaded clean at root while the identical typo under
// providers.<url> rejected, and resolveCacheKeepalive silently dropped the bad
// fields to defaults. These pin the fix: an invalid global block fails loudly
// at load (error naming the field + file treated as unreadable, like a
// malformed file), a valid one passes through as-is, and null stays "absent".

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-cfg-keepalive-"));
const savedConfigEnv = process.env.BILI_CONFIG_FILE;
const KEEPALIVE_ENV_KEYS = [
    "BILI_CACHE_KEEPALIVE",
    "BILI_CACHE_KEEPALIVE_TTL_FACTOR",
    "BILI_CACHE_KEEPALIVE_MAX_DURATION_MS",
    "BILI_CACHE_KEEPALIVE_MAX_PINGS",
    "BILI_CACHE_KEEPALIVE_ASSUME_TTL",
    "BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS",
    "BILI_CACHE_KEEPALIVE_INTERVAL_MS",
];
const savedKeepaliveEnv: Record<string, string | undefined> = {};

test.before(() => {
    for (const k of KEEPALIVE_ENV_KEYS) { savedKeepaliveEnv[k] = process.env[k]; delete process.env[k]; }
});

test.after(() => {
    setLogCapture(null);
    if (savedConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigEnv;
    for (const k of KEEPALIVE_ENV_KEYS) {
        if (savedKeepaliveEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedKeepaliveEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
});

function pointAt(name: string): string {
    const f = path.join(root, name);
    process.env.BILI_CONFIG_FILE = f;
    return f;
}

test("#4200: typo'd global cacheKeepalive fails loudly at load (field named, file unreadable)", () => {
    const f = pointAt("bad-global.json");
    const seen: string[] = [];
    setLogCapture((_level, msg) => { if (msg.includes("failed to parse")) seen.push(msg); });
    try {
        // The exact repro from the issue: the value that rejects route-level.
        fs.writeFileSync(f, JSON.stringify({ port: 9001, cacheKeepalive: { ttlFactor: "high" } }));
        for (let i = 0; i < 5; i++) assert.deepEqual(loadConfigFile(), {});
        assert.equal(seen.length, 1, `first corruption logs once across 5 calls (got ${seen.length})`);
        assert.match(seen[0], /failed to parse .*cacheKeepalive\.ttlFactor must be a number in \(0, 1\]/);
        // Fixing the file clears the failure without further logging.
        fs.writeFileSync(f, JSON.stringify({ port: 9002 }));
        assert.equal(loadConfigFile().port, 9002);
        loadConfigFile();
        assert.equal(seen.length, 1, "valid rewrite logs nothing more");
    } finally {
        setLogCapture(null);
    }
});

test("#4200: unknown key in the global block is rejected too", () => {
    const f = pointAt("unknown-key.json");
    const seen: string[] = [];
    setLogCapture((_level, msg) => { seen.push(msg); });
    try {
        fs.writeFileSync(f, JSON.stringify({ cacheKeepalive: { bogusKey: 1 } }));
        assert.deepEqual(loadConfigFile(), {});
        const failed = seen.find((m) => m.includes("failed to parse"));
        assert.ok(failed, "one failed-to-parse line");
        assert.match(failed, /unknown key "bogusKey"/);
    } finally {
        setLogCapture(null);
    }
});

test("#4200: the identical typo still rejects at route level (symmetry pinned)", () => {
    assert.throws(() => parseRouteEntry({ cacheKeepalive: { ttlFactor: "high" } }), /cacheKeepalive\.ttlFactor/);
});

test("#4200: a valid global block passes through as-is and reaches the resolver", () => {
    const f = pointAt("valid-global.json");
    fs.writeFileSync(f, JSON.stringify({ port: 9003, cacheKeepalive: { enabled: true, ttlFactor: 0.5, assumeTtl: "1h" } }));
    const cfg = loadConfigFile();
    assert.equal(cfg.port, 9003);
    assert.deepEqual(cfg.cacheKeepalive, { enabled: true, ttlFactor: 0.5, assumeTtl: "1h" }, "raw object preserved verbatim");
    const r = resolveCacheKeepalive(undefined, undefined);
    assert.equal(r.enabled, true);
    assert.equal(r.ttlFactor, 0.5);
    assert.equal(r.assumeTtl, "1h");
});

test("#4200: null global block means absent (web save contract) — loads clean", () => {
    const f = pointAt("null-global.json");
    const seen: string[] = [];
    setLogCapture((_level, msg) => { seen.push(msg); });
    try {
        fs.writeFileSync(f, JSON.stringify({ port: 9004, cacheKeepalive: null }));
        const cfg = loadConfigFile();
        assert.equal(cfg.port, 9004);
        assert.equal(cfg.cacheKeepalive, null);
        assert.equal(seen.filter((m) => m.includes("failed to parse")).length, 0, "null block logs nothing");
    } finally {
        setLogCapture(null);
    }
});

// ---- web whole-file save facet (#4200 follow-up) ---------------------------

async function putWholeFile(rawText: string): Promise<{ status: number; payload: Record<string, unknown> }> {
    const req = new Readable({ read() {} });
    req.push(Buffer.from(JSON.stringify({ file: rawText })));
    req.push(null);
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigPut(req as unknown as IncomingMessage, res as unknown as ServerResponse, undefined, 8787);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

test("#4200 web: invalid global block in a whole-file save gets a clean 400 naming the field", async () => {
    const f = pointAt("web-bad-global.json");
    fs.writeFileSync(f, "{}");
    const r = await putWholeFile(JSON.stringify({ cacheKeepalive: { ttlFactor: "high" } }));
    assert.equal(r.status, 400);
    assert.match(String(r.payload.error), /cacheKeepalive\.ttlFactor must be a number/);
    assert.equal(fs.readFileSync(f, "utf8"), "{}", "the file is never written");
});

test("#4200 web: valid global block still saves (no over-strictening)", async () => {
    const f = pointAt("web-valid-global.json");
    fs.writeFileSync(f, "{}");
    const r = await putWholeFile(JSON.stringify({ cacheKeepalive: { enabled: true, ttlFactor: 0.5 } }));
    assert.equal(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.cacheKeepalive, { enabled: true, ttlFactor: 0.5 });
});
