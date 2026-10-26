// #4352: the ack channel must not depend on the response-header transport.
//
// The 2026-10-22 incident: pi's after_provider_response exposes response
// headers only for some provider transports — when the
// x-bili-applied-seq header never reaches the extension, noteIncrementalAck
// never runs, and EVERY subsequent turn re-seeds the full history
// (sinceSeq=0). Fix: before planning the next turn, reconcile any un-acked
// pending plan by PULLING GET /__bili/plugin/turn?conversation=<id> and
// adopting the receipt only when its boundary hash proves the canonical
// absorbed OUR last message.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { __resetIncrementalClientForTests } from "../src/agent/incremental-client.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

process.env.NODE_ENV = "test";
process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
const testRoot = mkdtempSync(join(tmpdir(), "bili-ackpull-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

function makeFakePi() {
    const events = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const tools: unknown[] = [];
    return {
        events,
        tools,
        on: (event: string, handler: (event: never, ctx: never) => unknown) => {
            const list = events.get(event) ?? [];
            list.push(handler as (event: unknown, ctx: unknown) => unknown);
            events.set(event, list);
        },
        registerTool: (tool: unknown) => { tools.push(tool); },
        registerCommand: () => {},
        registerProvider: () => {},
        getSessionName: () => "test",
        fire: (name: string, event: unknown, ctx: unknown) => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = h(event, ctx);
            return last;
        },
        fireAsync: async (name: string, event: unknown, ctx: unknown) => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = await h(event, ctx);
            return last;
        },
    };
}

type Harness = {
    proxyUrl: string;
    baseUrl: string;
    pi: ReturnType<typeof makeFakePi>;
    ctx: { sessionManager: { getSessionId: () => string }; model: { id: string; contextWindow: number; api: string; baseUrl: string }; cwd: string };
    close: () => Promise<void>;
};

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    __resetIncrementalClientForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const ctx = {
        sessionManager: { getSessionId: () => "conv-pi-1" },
        model: { id: "claude-test", contextWindow: 400000, api: "anthropic", baseUrl: `${proxyUrl}/bili/${upstreamUrl}/v1` },
        cwd: dir,
    };
    try {
        await pi.fireAsync("session_start", {}, ctx);
        const deadline = Date.now() + 15000;
        while (pi.tools.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        assert.ok(pi.tools.length >= 2, `tools registered: ${pi.tools.length}`);
        await fn({ proxyUrl, baseUrl: `${ctx.model.baseUrl}/messages`, pi, ctx, close: async () => undefined });
    } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
}

const PAYLOAD1 = { model: "claude-test", max_tokens: 1024, system: "be brief", messages: [{ role: "user", content: "hello".repeat(50) }] };

test("#4352 ack via response header keeps working (regression pin)", async () => {
    await withHarness(async (h) => {
        const headers1: Record<string, string> = {};
        await h.pi.fireAsync("before_provider_headers", { headers: headers1 }, h.ctx);
        const replaced1 = await h.pi.fireAsync("before_provider_request", { payload: PAYLOAD1 }, h.ctx) as Record<string, unknown>;
        const res1 = await fetch(h.baseUrl, { method: "POST", headers: { "content-type": "application/json", ...headers1 }, body: JSON.stringify(replaced1) });
        assert.equal(res1.status, 200);
        assert.equal(res1.headers.get("x-bili-applied-seq"), "1", "the lane stamps the ack header on 2xx");
        const ackHeaders: Record<string, string> = {};
        res1.headers.forEach((v, k) => { ackHeaders[k] = v; });
        await h.pi.fireAsync("after_provider_response", { status: res1.status, headers: ackHeaders }, h.ctx);
        const payload2 = { ...PAYLOAD1, messages: [...PAYLOAD1.messages, { role: "assistant", content: "answer" }, { role: "user", content: "next".repeat(50) }] };
        const replaced2 = await h.pi.fireAsync("before_provider_request", { payload: payload2 }, h.ctx) as { sinceSeq?: number };
        assert.equal(replaced2.sinceSeq, 1, "acked turn 1 → turn 2 is a delta");
    });
});

test("#4352 pull receipt: a transport that hides response headers must not cause a re-seed", async () => {
    await withHarness(async (h) => {
        const headers1: Record<string, string> = {};
        await h.pi.fireAsync("before_provider_headers", { headers: headers1 }, h.ctx);
        const replaced1 = await h.pi.fireAsync("before_provider_request", { payload: PAYLOAD1 }, h.ctx) as Record<string, unknown>;
        const res1 = await fetch(h.baseUrl, { method: "POST", headers: { "content-type": "application/json", ...headers1 }, body: JSON.stringify(replaced1) });
        assert.equal(res1.status, 200);
        await res1.text();
        // The incident shape: the host transport never surfaces the response
        // headers to after_provider_response — no ack is observed.
        const probeRes = await fetch(`${h.proxyUrl}/__bili/plugin/turn?conversation=conv-pi-1`, { headers: { "x-bili-plugin": "pi" } });
        assert.equal(probeRes.status, 200);
        const receipt = await probeRes.json() as { conversation?: { appliedSeq?: number; boundary?: string | null } };
        assert.equal(receipt.conversation?.appliedSeq, 1, "the receipt exposes the warm canonical's appliedSeq");
        assert.ok(typeof receipt.conversation?.boundary === "string" && receipt.conversation.boundary.length === 16, "boundary is the 16-hex wire hash");
        const payload2 = { ...PAYLOAD1, messages: [...PAYLOAD1.messages, { role: "assistant", content: "answer" }, { role: "user", content: "next".repeat(50) }] };
        const replaced2 = await h.pi.fireAsync("before_provider_request", { payload: payload2 }, h.ctx) as { sinceSeq?: number; resync?: boolean; messages?: unknown[] };
        assert.notEqual(replaced2.sinceSeq, 0, `pull reconciliation must adopt the receipt instead of re-seeding (sinceSeq=${replaced2.sinceSeq})`);
        assert.notEqual(replaced2.resync, true, "turn 2 is a plain delta, not a resync");
        assert.ok((replaced2.messages ?? []).length < payload2.messages.length, "turn 2 ships only the delta suffix");
    });
});

test("#4352 cold canonical reports boundary null — the client keeps its pending plan and does not adopt", async () => {
    await withHarness(async (h) => {
        // Warm the lane with one applied turn (no ack observation).
        const headers1: Record<string, string> = {};
        await h.pi.fireAsync("before_provider_headers", { headers: headers1 }, h.ctx);
        const replaced1 = await h.pi.fireAsync("before_provider_request", { payload: PAYLOAD1 }, h.ctx) as Record<string, unknown>;
        const res1 = await fetch(h.baseUrl, { method: "POST", headers: { "content-type": "application/json", ...headers1 }, body: JSON.stringify(replaced1) });
        await res1.text();
        // Simulate a lane restart: warm canonical dropped.
        __resetIncrementalLaneForTests();
        const probeRes = await fetch(`${h.proxyUrl}/__bili/plugin/turn?conversation=conv-pi-1`, { headers: { "x-bili-plugin": "pi" } });
        const receipt = await probeRes.json() as { conversation?: { appliedSeq?: number; boundary?: string | null } };
        assert.equal(receipt.conversation?.boundary, null, "a cold canonical cannot vouch for a boundary");
        // The client must NOT adopt a null boundary — turn 2 re-seeds with
        // resync (the honest recovery), never a silent delta.
        const payload2 = { ...PAYLOAD1, messages: [...PAYLOAD1.messages, { role: "assistant", content: "answer" }, { role: "user", content: "next".repeat(50) }] };
        const replaced2 = await h.pi.fireAsync("before_provider_request", { payload: payload2 }, h.ctx) as { sinceSeq?: number; resync?: boolean };
        assert.ok(replaced2.resync === true || replaced2.sinceSeq === 0, "unadoptable receipt → the client falls back to a full re-seed, not a guess");
    });
});
