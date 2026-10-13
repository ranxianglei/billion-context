import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { createStorageCodec, parseEncryptionKey } from "../src/encrypt.ts";
import { getAuditOfflineReport, runAuditOfflineScan, scanSessionsDir, _resetAuditOfflineForTest, type AuditOfflineReport } from "../src/audit-offline.ts";
import { rmrf } from "./tmp-rm.ts";

// Plain JSON baseline; individual tests toggle the storage-policy envs.
process.env.BILI_PERSIST_ZSTD = "0";
delete process.env.BILI_ENCRYPTION_KEY;
delete process.env.BILI_AUDIT_OFFLINE_ENABLED;

function withSessionsDir<T>(name: string, fn: (dir: string) => Promise<T>): void {
    test(name, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-audit-offline-"));
        const prevSessionsDir = process.env.BILI_SESSIONS_DIR;
        const prevZstd = process.env.BILI_PERSIST_ZSTD;
        const prevKey = process.env.BILI_ENCRYPTION_KEY;
        const prevEnabled = process.env.BILI_AUDIT_OFFLINE_ENABLED;
        process.env.BILI_SESSIONS_DIR = dir;
        _resetAuditOfflineForTest();
        try {
            await fn(dir);
        } finally {
            if (prevSessionsDir === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessionsDir;
            if (prevZstd === undefined) delete process.env.BILI_PERSIST_ZSTD; else process.env.BILI_PERSIST_ZSTD = prevZstd;
            if (prevKey === undefined) delete process.env.BILI_ENCRYPTION_KEY; else process.env.BILI_ENCRYPTION_KEY = prevKey;
            if (prevEnabled === undefined) delete process.env.BILI_AUDIT_OFFLINE_ENABLED; else process.env.BILI_AUDIT_OFFLINE_ENABLED = prevEnabled;
            _resetAuditOfflineForTest();
            rmrf(dir);
        }
    });
}

function sessionJson(id: string, patch: Record<string, unknown> = {}, savedAt: number = Date.now()): string {
    const payload: Record<string, unknown> = {
        version: 3,
        savedAt,
        id,
        meta: { protocol: "openai" },
        stats: {},
        messages: [{ role: "user", text: "hello tail content for counting" }],
        metadata: {},
        state: { blocks: [], messageRefs: {} },
        blockContents: {},
        ...patch,
    };
    return JSON.stringify({ id, savedAt, payload });
}

async function waitFor<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v !== null) return v;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

withSessionsDir("empty dir yields an all-zero report", async (dir) => {
    const r = await scanSessionsDir();
    assert.equal(r.filesScanned, 0);
    assert.equal(r.sessionsTotal, 0);
    assert.equal(r.blockContentsTokens, 0);
    assert.equal(r.tailMessagesTokens, 0);
    assert.equal(r.oldestSavedAt, null);
    assert.equal(r.newestSavedAt, null);
});

withSessionsDir("plain-JSON never-compressed session counts its tail only", async (dir) => {
    writeFileSync(path.join(dir, "a1.json"), sessionJson("a1"));
    const r = await scanSessionsDir();
    assert.equal(r.filesScanned, 1);
    assert.equal(r.filesReadable, 1);
    assert.equal(r.sessionsTotal, 1);
    assert.equal(r.sessionsNeverCompressed, 1);
    assert.equal(r.sessionsEverCompressed, 0);
    assert.equal(r.blockContentsTokens, 0);
    assert.ok(r.tailMessagesTokens > 0);
    assert.equal(r.perFile[0].readable, true);
    assert.equal(r.perFile[0].everCompressed, false);
    assert.ok(r.perFile[0].tailMessageCount === 1);
});

withSessionsDir("compressed session counts verbatim folded originals", async (dir) => {
    writeFileSync(path.join(dir, "b2.json"), sessionJson("b2", {
        state: { blocks: [{ kind: "summary" }], messageRefs: {} },
        blockContents: { bid1: { one: null, full: { text: "verbatim folded original text", count: 1 } } },
    }));
    const r = await scanSessionsDir();
    assert.equal(r.sessionsEverCompressed, 1);
    assert.equal(r.sessionsNeverCompressed, 0);
    assert.ok(r.blockContentsTokens > 0);
    assert.equal(r.perFile[0].everCompressed, true);
});

withSessionsDir("zstd-framed file decodes when the zstd knob is on", async (dir) => {
    process.env.BILI_PERSIST_ZSTD = "1";
    const codec = createStorageCodec({ compress: true });
    assert.ok(codec, "zstd codec must exist");
    const enc = codec.encode(sessionJson("z1"));
    writeFileSync(path.join(dir, "z1.json"), enc);
    const r = await scanSessionsDir();
    assert.equal(r.filesReadable, 1);
    assert.equal(r.filesUnreadable, 0);
    assert.equal(r.sessionsTotal, 1);
});

withSessionsDir("encrypted file decodes with the key, unreadable without it", async (dir) => {
    const hex = randomBytes(32).toString("hex");
    const keyBuf = parseEncryptionKey(hex);
    const codec = createStorageCodec({ key: keyBuf });
    assert.ok(codec, "aes codec must exist");
    const enc = codec.encode(sessionJson("e1"));
    writeFileSync(path.join(dir, "e1.json"), enc);

    process.env.BILI_ENCRYPTION_KEY = hex;
    const withKey = await scanSessionsDir();
    assert.equal(withKey.filesReadable, 1);
    assert.equal(withKey.filesUnreadable, 0);
    assert.equal(withKey.sessionsTotal, 1);

    delete process.env.BILI_ENCRYPTION_KEY;
    const noKey = await scanSessionsDir();
    assert.equal(noKey.filesReadable, 0);
    assert.equal(noKey.filesUnreadable, 1);
    assert.equal(noKey.sessionsTotal, 0);

    // Invalid key must degrade to a warning, never crash the scan.
    process.env.BILI_ENCRYPTION_KEY = "not-a-valid-key";
    const badKey = await scanSessionsDir();
    assert.equal(badKey.filesUnreadable, 1);
});

withSessionsDir("garbage and non-record files count as unreadable, not fatal", async (dir) => {
    writeFileSync(path.join(dir, "g1.json"), "definitely not json {{{");
    writeFileSync(path.join(dir, "g2.json"), JSON.stringify({ foo: 1 }));
    writeFileSync(path.join(dir, "ok.json"), sessionJson("ok"));
    const r = await scanSessionsDir();
    assert.equal(r.filesScanned, 3);
    assert.equal(r.filesReadable, 1);
    assert.equal(r.filesUnreadable, 2);
    assert.equal(r.sessionsTotal, 1);
});

withSessionsDir("CCR companion files are counted separately from sessions", async (dir) => {
    writeFileSync(path.join(dir, "c1.json"), sessionJson("c1"));
    writeFileSync(path.join(dir, "c1.content-store.json"), JSON.stringify({
        version: 1,
        byHash: { h1: "unique tool output content for the ccr store" },
        byRef: { m00001: "h1" },
    }));
    const r = await scanSessionsDir();
    assert.equal(r.filesScanned, 2);
    assert.equal(r.filesReadable, 2);
    assert.equal(r.ccrCompanionFiles, 1);
    assert.ok(r.ccrCompanionTokens > 0);
    assert.equal(r.sessionsTotal, 1);
});

withSessionsDir("tmp and hidden entries are skipped", async (dir) => {
    writeFileSync(path.join(dir, ".tmp-wip.json"), sessionJson("wip"));
    mkdirSync(path.join(dir, ".hidden"));
    writeFileSync(path.join(dir, ".hidden", "x.json"), sessionJson("hid"));
    writeFileSync(path.join(dir, "real.json"), sessionJson("real"));
    const r = await scanSessionsDir();
    assert.equal(r.filesScanned, 1);
    assert.equal(r.sessionsTotal, 1);
});

withSessionsDir("oldest/newest savedAt span the scanned records", async (dir) => {
    writeFileSync(path.join(dir, "old.json"), sessionJson("old", {}, 1_000_000));
    writeFileSync(path.join(dir, "new.json"), sessionJson("new", {}, 2_000_000));
    const r = await scanSessionsDir();
    assert.equal(r.oldestSavedAt, 1_000_000);
    assert.equal(r.newestSavedAt, 2_000_000);
});

withSessionsDir("runAuditOfflineScan caches its report for the readout", async (dir) => {
    writeFileSync(path.join(dir, "s1.json"), sessionJson("s1"));
    assert.equal(getAuditOfflineReport(), null);
    runAuditOfflineScan();
    const report = await waitFor(async () => getAuditOfflineReport(), "boot-scan report");
    assert.equal(report.filesScanned, 1);
    assert.equal(report.sessionsTotal, 1);
    assert.ok(report.durationMs >= 0);
    // A second call while idle re-scans and refreshes the cache.
    _resetAuditOfflineForTest();
    runAuditOfflineScan();
    const again = await waitFor(async () => getAuditOfflineReport(), "second boot-scan report");
    assert.equal(again.sessionsTotal, 1);
});

function proxyOpts(): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
}

withSessionsDir("admin readout is pending while the switch is off", async (dir) => {
    writeFileSync(path.join(dir, "p1.json"), sessionJson("p1"));
    const server = await startServer(proxyOpts());
    if (!server.listening) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/audit/offline`);
        assert.equal(res.status, 202);
        const body = (await res.json()) as { status: string };
        assert.equal(body.status, "pending");
    } finally {
        server.close();
        await new Promise<void>((resolve) => server.once("close", () => resolve()));
    }
});

withSessionsDir("admin readout serves the boot-scan report when enabled", async (dir) => {
    writeFileSync(path.join(dir, "q1.json"), sessionJson("q1"));
    process.env.BILI_AUDIT_OFFLINE_ENABLED = "1";
    const server = await startServer(proxyOpts());
    if (!server.listening) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const body = await waitFor(async () => {
            const res = await fetch(`http://127.0.0.1:${port}/__bili/audit/offline`);
            if (res.status !== 200) return null;
            return (await res.json()) as AuditOfflineReport;
        }, "200 audit report");
        assert.equal(body.filesScanned, 1);
        assert.equal(body.sessionsTotal, 1);
        assert.ok(body.scannedAt > 0);
    } finally {
        server.close();
        await new Promise<void>((resolve) => server.once("close", () => resolve()));
    }
});
