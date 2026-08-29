import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const ROOT_SESSION = "01a048b8-c704-7c00-8000-000000000000";
const SUB_THREAD = "01a048b8-c728-7c00-8000-000000000000";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Minimal valid Responses-API SSE upstream: one assistant "ok" message. */
function startMockResponsesUpstream(): http.Server {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sseBlock("response.created", { response: { id: "resp_1", status: "in_progress" } }));
        res.write(
            sseBlock("response.output_item.added", {
                output_index: 0,
                item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
            }),
        );
        res.write(sseBlock("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" }));
        res.write(sseBlock("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }));
        res.write(
            sseBlock("response.output_item.done", {
                output_index: 0,
                item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] },
            }),
        );
        res.write(
            sseBlock("response.completed", {
                response: {
                    id: "resp_1",
                    status: "completed",
                    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
                    usage: { input_tokens: 10, output_tokens: 2 },
                },
            }),
        );
        res.end();
    });
    server.listen(0, "127.0.0.1");
    return server;
}

const rootMeta = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ request_kind: "turn", thread_source: "user", thread_id: ROOT_SESSION, turn_id: "turn-1", window_id: "win-1", ...over });
const subMeta = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ request_kind: "turn", thread_source: "subagent", thread_id: SUB_THREAD, turn_id: "turn-2", window_id: "win-1", ...over });

test("codex turn-metadata partition (#316 / PR-A): subagent and root threads get isolated sessions", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const upstream = startMockResponsesUpstream();
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
    const post = async (headers: Record<string, string>, body: Record<string, unknown>) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
            duplex: "half",
        } as RequestInit);
        const text = await res.text();
        return { status: res.status, text };
    };
    try {
        // 1. Root thread: session-id == thread-id == ROOT, thread_source user.
        const rootRes = await post(
            { "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta() },
            { model: "gpt-test", stream: true, instructions: "", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "root turn 1" }] }] },
        );
        assert.equal(rootRes.status, 200, `root request: ${rootRes.text}`);
        assert.ok(peekSession(ROOT_SESSION), "root request must create the session keyed by the session-id header");

        // 2. Subagent: REUSES the root session-id but carries its own thread-id.
        //    It must land in a SEPARATE session keyed by the thread-id, not the
        //    root session (this is the #150 isolation the bug broke).
        const subRes = await post(
            { "session-id": ROOT_SESSION, "thread-id": SUB_THREAD, "x-codex-turn-metadata": subMeta() },
            { model: "gpt-test", stream: true, instructions: "", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "subagent turn 1" }] }] },
        );
        assert.equal(subRes.status, 200, `subagent request: ${subRes.text}`);
        const subSession = peekSession(SUB_THREAD);
        assert.ok(subSession, "subagent request must create a session keyed by the thread-id header");
        assert.notEqual(subSession!.id, ROOT_SESSION, "subagent session must be distinct from the root session");
        assert.notEqual(subSession, peekSession(ROOT_SESSION), "subagent and root must be separate session objects (isolated compression state)");

        // 3. Root identity is stable across turns: a later root turn (churned
        //    turn_id/window_id) must reuse the SAME root session.
        const rootRes2 = await post(
            { "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ turn_id: "turn-2", window_id: "win-9" }) },
            { model: "gpt-test", stream: true, instructions: "", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "root turn 2" }] }] },
        );
        assert.equal(rootRes2.status, 200, `root turn 2: ${rootRes2.text}`);
        assert.equal(peekSession(ROOT_SESSION)!.stats.requests, 2, "two root turns must accumulate on the same root session");
        assert.equal(peekSession(SUB_THREAD)!.stats.requests, 1, "subagent session must not absorb root turns");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
