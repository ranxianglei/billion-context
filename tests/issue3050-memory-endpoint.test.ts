import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { CoreMessage } from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, createSession, getSession, sessionMemoryBreakdown, sessionPoolLimits } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #3050 step ①: GET /__bili/memory exposes the resident pool split per
// session (lastMessages / pluginSnapshot / blockContents / contentStore /
// state / transient / other) plus process RSS/heap/peak — the measurement
// that decides which residents go lazy-load next.

test("#3050 step ①: sessionMemoryBreakdown attributes resident bytes to the right fields", () => {
    _resetSessionsForTest();
    try {
        const session = createSession("mem-breakdown");
        const empty = sessionMemoryBreakdown(session);
        // skeleton only: each named field costs at most its own frame
        assert.ok(empty.total > 0, "empty session still has a measurable skeleton");
        assert.equal(empty.lastMessages, 8, "absent field measures as a scalar");
        assert.equal(empty.blockContents, 64, "empty map costs its frame only");
        assert.ok(empty.other >= 0, "other never goes negative");

        // disjoint payloads per field → attribution must be monotone in size
        session.blockContents.set("b00001", { one: null, full: { text: "A".repeat(1_000_000), count: 3 } });
        const last: CoreMessage[] = [{ id: "m00001", role: "user", contentType: "text", text: "B".repeat(500_000) }];
        session.lastMessages = last;
        const snap: CoreMessage[] = [{ id: "m00002", role: "user", contentType: "text", text: "C".repeat(250_000) }];
        session.pluginSnapshot = snap;
        session.contentStore = { version: 1, byHash: { h1: "D".repeat(100_000) }, byRef: {} };
        session.transient = { pluginMessages: { processed: [], original: [] } };

        const b = sessionMemoryBreakdown(session);
        assert.ok(b.blockContents > b.lastMessages, `blockContents (${b.blockContents}) > lastMessages (${b.lastMessages})`);
        assert.ok(b.lastMessages > b.pluginSnapshot, `lastMessages (${b.lastMessages}) > pluginSnapshot (${b.pluginSnapshot})`);
        assert.ok(b.pluginSnapshot > b.contentStore, `pluginSnapshot (${b.pluginSnapshot}) > contentStore (${b.contentStore})`);
        assert.ok(b.contentStore > 0, "contentStore measured");
        assert.ok(b.state > 0, "kernel state measured");
        assert.ok(b.total >= b.blockContents, "whole-session pass covers the largest bucket");
        assert.ok(b.other >= 0, "other floored at 0");
        assert.equal(b.inFlight, 0);
        assert.equal(b.id, "mem-breakdown");

        // shared reference: the SAME message array under two fields counts in
        // both buckets but once in the whole — isolated on a fresh session so
        // no other field can mask the overlap
        const sharedSession = createSession("mem-shared");
        const sharedMsgs: CoreMessage[] = [{ id: "m00009", role: "user", contentType: "text", text: "G".repeat(200_000) }];
        sharedSession.lastMessages = sharedMsgs;
        sharedSession.pluginSnapshot = sharedMsgs;
        const sh = sessionMemoryBreakdown(sharedSession);
        assert.equal(sh.pluginSnapshot, sh.lastMessages, "same array measures identically under both fields");
        assert.ok(sh.total < sh.lastMessages + sh.pluginSnapshot, "shared object counted once in total, twice across buckets");
        assert.ok(sh.other >= 0);
    } finally {
        _resetSessionsForTest();
    }
});

test("#3050 step ①: sessionPoolLimits reflects the admission bounds", () => {
    _resetSessionsForTest(3, 1024 * 1024);
    try {
        const limits = sessionPoolLimits();
        assert.equal(limits.maxSessions, 3);
        assert.equal(limits.maxResidentBytes, 1024 * 1024);
    } finally {
        _resetSessionsForTest();
    }
});

async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface MemoryReport {
    process: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number; peakRss: number | null };
    pool: { count: number; maxSessions: number; maxResidentBytes: number; residentBytes: number };
    sessions: Array<{ id: string; total: number; lastMessages: number; pluginSnapshot: number; blockContents: number; contentStore: number; state: number; transient: number; other: number; inFlight: number }>;
}

test("#3050 step ①: GET /__bili/memory reports process + pool + per-session split", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mem-stats-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const opts: ProxyOptions = {
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
        mitm: { enabled: true, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        await waitReady(port);

        const first = (await (await fetch(`http://127.0.0.1:${port}/__bili/memory`)).json()) as MemoryReport;
        assert.ok(first.process.rss > 0, "process rss reported");
        assert.ok(first.process.heapUsed > 0, "heap used reported");
        assert.ok("peakRss" in first.process, "peak RSS field present (null off-Linux)");
        assert.ok(Number.isInteger(first.pool.count) && first.pool.count >= 0);
        assert.ok(first.pool.maxSessions >= 1);
        assert.ok(first.pool.maxResidentBytes > 0);
        assert.ok(first.pool.residentBytes >= 0);
        assert.ok(Array.isArray(first.sessions));

        // grow one resident session, then watch its bucket move
        const s = getSession("mem-endpoint-session");
        s.blockContents.set("b00001", { one: null, full: { text: "E".repeat(100_000), count: 2 } });
        s.lastMessages = [{ id: "m00008", role: "user", contentType: "text", text: "F".repeat(50_000) }];

        const second = (await (await fetch(`http://127.0.0.1:${port}/__bili/memory`)).json()) as MemoryReport;
        const row = second.sessions.find((x) => x.id === "mem-endpoint-session");
        assert.ok(row, "resident session appears in the report");
        assert.ok(row!.blockContents > 0, "blockContents bucket carries the originals");
        assert.ok(row!.lastMessages > 0, "lastMessages bucket carries the resend cache");
        assert.ok(row!.total >= row!.blockContents);
        assert.ok(second.pool.residentBytes > first.pool.residentBytes, "pool total grew with the session");
    } finally {
        if (proxy) {
            proxy.closeAllConnections?.();
            await close(proxy);
        }
        _resetSessionsForTest();
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        if (prevData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevData;
        rmrf(tmpRoot);
    }
});
