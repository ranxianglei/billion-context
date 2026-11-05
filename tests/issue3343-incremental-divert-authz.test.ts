// #3343: the incremental lane's marker divert must never hand admin-shaped
// paths to the lane's re-entry — the re-entry historically carried a forged
// loopback socket, so a network peer who could set two headers reached
// /__acp/* management surfaces on any conversationId. Two pins here:
//   1. divert excludes /__acp/* (falls through to handleAdminRoute, whose
//      gates judge the caller's REAL socket — loopback keeps working, remote
//      callers get the standard 403/404 treatment);
//   2. the synthetic re-entry carries the caller's real socket identity.

import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests, handleIncrementalTurn } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-3343-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Harness {
    markerTurn: (reqPath: string, payload: { conversationId: string; sinceSeq: number; messages: unknown[] }) => Promise<{ status: number; appliedSeq?: number; body: unknown }>;
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const markerTurn = async (reqPath: string, payload: { conversationId: string; sinceSeq: number; messages: unknown[] }) => {
        const response = await fetch(`${proxyUrl}${reqPath}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": payload.conversationId, "x-acp-session": payload.conversationId, "x-bili-plugin-turn": "1" },
            body: JSON.stringify({ conversationId: payload.conversationId, sinceSeq: payload.sinceSeq, request: { model: "claude-test", max_tokens: 1024 }, messages: payload.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, body, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    return {
        markerTurn,
        close: async () => {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

test("marker divert never diverts admin-shaped /__acp/* paths into the lane (#3343)", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    try {
        const h = await harness();
        try {
            const payload = { conversationId: "conv-3343-admin", sinceSeq: 0, messages: [{ role: "user", content: "probe" }] };
            // Same shaped body that a pre-fix peer used to ride the lane into
            // management: POST /__acp/* + plugin headers + marker + turn body.
            const res = await h.markerTurn("/__acp/authz-probe-3343", payload);
            // Falls through to handleAdminRoute → unknown /__acp/ path → local
            // 404 — NEVER the lane's 200 + x-bili-applied-seq ack.
            assert.equal(res.status, 404);
            assert.equal(res.appliedSeq, undefined);
            // No lane state may have been planted under the chosen id.
            const rows = getStore().unifiedRawMessages(payload.conversationId);
            assert.ok(rows === null || rows.length === 0, "lane must not have written canonical rows for an admin-path request");
            assert.ok(!getStore().getSessionExt(payload.conversationId, "inc:system"), "lane must not have persisted sticky system for an admin-path request");
        } finally {
            await h.close();
        }
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
    }
});

test("model-shaped paths still divert into the lane (fix is not over-blocking)", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    try {
        const h = await harness();
        try {
            const res = await h.markerTurn("/v1/messages", { conversationId: "conv-3343-model", sinceSeq: 0, messages: [{ role: "user", content: "hi" }] });
            assert.equal(res.status, 200);
            assert.equal(res.appliedSeq, 1);
        } finally {
            await h.close();
        }
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
    }
});

test("synthetic re-entry carries the caller's real socket identity (#3343)", async () => {
    const dir = mkdtempSync(join(testRoot, "unit-"));
    const savedUnified = process.env.BILI_STORAGE_UNIFIED;
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.XDG_STATE_HOME = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    try {
        const resStub = { writableEnded: false, writeHead(): void { }, setHeader(): void { }, on(): void { } };
        for (const remoteAddress of ["203.0.113.7", "127.0.0.1"]) {
            const conversationId = `conv-3343-unit-${remoteAddress}`;
            const rawBody = Buffer.from(JSON.stringify({
                conversationId,
                sinceSeq: 0,
                system: "sticky",
                request: { model: "claude-test", max_tokens: 64 },
                messages: [{ role: "user", content: "hi" }],
            }));
            const req = Object.assign(Readable.from([]), {
                method: "POST",
                url: "/v1/messages",
                headers: { host: "localhost", "x-bili-plugin": "dsh" },
                socket: { remoteAddress, localPort: 39999, destroy(): void { } },
            }) as unknown as http.IncomingMessage;
            let captured: { socket?: { remoteAddress?: string; localPort?: number }; url?: string } | undefined;
            await handleIncrementalTurn(
                req,
                resStub as never,
                () => undefined,
                async (syntheticReq) => { captured = syntheticReq as never; },
                "/v1/messages",
                rawBody,
            );
            assert.ok(captured, "forward must be reached for a valid seeded turn");
            assert.equal(captured.socket?.remoteAddress, remoteAddress, "re-entry must carry the caller's real address, not a forged loopback");
            assert.equal(captured.socket?.localPort, 39999);
            assert.equal(captured.url, "/v1/messages");
        }
    } finally {
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = savedXdg;
        if (savedUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = savedUnified;
        store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
    }
});
