// #2399 stage 3: opencode V2 fork-child adoption. The http.request hook is the
// only V2 seam that sees both the owning session id and the outgoing body;
// parents come from session.created events (#1362 channel). These tests prove:
//   - a session.declared child whose body replays the parent's history is
//     adopted BEFORE its first request reaches the proxy (snapshot shows the
//     inherited prefix; the child replay is accepted);
//   - a persona-shaped child (#1102 — fresh context, no shared prefix) posts
//     no fork at all (N=0 guard), so blind adoption stays safe;
//   - both run behind the fire-and-forget identity register (#2399 B-plan).
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
import { createOpencodeV2Setup } from "../src/agent/opencode-v2.ts";
import { resetForkCapabilityCacheForTest } from "../src/agent/fork-adopt.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-oc-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    resetForkCapabilityCacheForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { dir, store, upstreamUrl, origin: `http://127.0.0.1:${paddr.port}`, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

async function seedParent(h: Awaited<ReturnType<typeof harness>>, conversationId: string) {
    const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": conversationId },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
        ] }),
    });
    assert.equal(seed.status, 200, await seed.text());
}

type HookCb = (e: Record<string, unknown>) => void | Promise<void>;

function makeV2Ctx() {
    const hooks = new Map<string, HookCb>();
    const eventQueue: Array<{ type?: unknown; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let consumed = 0;
    const ctx = {
        session: {
            hook: async (name: string, cb: HookCb) => { hooks.set(name, cb); return { dispose: () => undefined }; },
            synthetic: async () => ({}),
        },
        tool: { transform: async () => ({ dispose: () => undefined }) },
        command: { transform: async () => ({ dispose: () => undefined }) },
        event: {
            subscribe: (opts?: { signal?: AbortSignal }) => {
                opts?.signal?.addEventListener("abort", () => { closed = true; wake?.(); }, { once: true });
                return {
                    [Symbol.asyncIterator]: (): AsyncIterator<{ type?: unknown; data?: Record<string, unknown> }> => ({
                        next: async () => {
                            while (eventQueue.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
                            wake = undefined;
                            const v = eventQueue.shift();
                            if (v === undefined) return { done: true as const, value: undefined };
                            consumed += 1;
                            return { done: false as const, value: v };
                        },
                    }),
                };
            },
        },
        catalog: { model: { list: async () => ({ data: [] }) } },
    };
    return {
        ctx,
        fire: async (name: string, e: Record<string, unknown>) => { const cb = hooks.get(name); assert.ok(cb, `hook ${name} registered`); await cb(e); },
        pushEvent: (evt: { type?: unknown; data?: Record<string, unknown> }) => { eventQueue.push(evt); wake?.(); },
        untilConsumed: async (n: number) => {
            const deadline = Date.now() + 3000;
            while (consumed < n) {
                if (Date.now() > deadline) throw new Error(`only ${consumed} events consumed, wanted ${n}`);
                await new Promise((r) => setTimeout(r, 10));
            }
        },
    };
}

const childBody = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
    { role: "system", content: "system prompt" },
    { role: "user", content: "first original ".repeat(250) },
    { role: "assistant", content: "second original ".repeat(250) },
    { role: "user", content: "tail original" },
    { role: "user", content: "new fork tail" },
] };

test("v2 http.request lane adopts a session.created fork child before its first request (#2399 stage 3)", async () => {
    const h = await harness();
    try {
        await seedParent(h, "oc-parent");
        const fake = makeV2Ctx();
        const dispose = await createOpencodeV2Setup()(fake.ctx as never);
        fake.pushEvent({ type: "session.created", data: { sessionID: "oc-child", parentID: "oc-parent" } });
        await fake.untilConsumed(1);
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`;
        const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(childBody) });
        await fake.fire("http.request", { sessionID: "oc-child", model: { providerID: "qwen", id: "m1" }, request });
        assert.equal(request.headers.get("x-bili-plugin"), "opencode", "hook stamped the plugin headers");
        assert.equal(request.headers.get("x-bili-plugin-conversation"), "oc-child");
        const snap = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=oc-child`);
        const snapText = await snap.text();
        assert.equal(snap.status, 200, snapText);
        const snapBody = JSON.parse(snapText) as { orderedMessages: unknown[] };
        assert.equal(snapBody.orderedMessages.length, 3, "child inherited the parent's three-message prefix");
        const replay = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "oc-child" },
            body: JSON.stringify(childBody),
        });
        assert.equal(replay.status, 200, await replay.text());
        dispose();
    } finally {
        await h.close();
    }
});

test("v2: persona-shaped child (fresh context, no shared prefix) never posts a fork (#2399 / #1102 gate)", async () => {
    const h = await harness();
    try {
        await seedParent(h, "oc-parent");
        const fake = makeV2Ctx();
        const dispose = await createOpencodeV2Setup()(fake.ctx as never);
        fake.pushEvent({ type: "session.created", data: { sessionID: "oc-persona", parentID: "oc-parent" } });
        await fake.untilConsumed(1);
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`;
        const personaBody = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "review policy" },
            { role: "user", content: "review this pull request" },
        ] };
        await fake.fire("http.request", { sessionID: "oc-persona", model: { providerID: "qwen", id: "m1" }, request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(personaBody) }) });
        const snap = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=oc-persona`);
        assert.equal(snap.status, 404, "no fork was posted — the persona context shares no prefix with the parent");
        // A second request stays closed: the adoption window is first-request-only.
        await fake.fire("http.request", { sessionID: "oc-persona", model: { providerID: "qwen", id: "m1" }, request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(personaBody) }) });
        const snap2 = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=oc-persona`);
        assert.equal(snap2.status, 404);
        dispose();
    } finally {
        await h.close();
    }
});
