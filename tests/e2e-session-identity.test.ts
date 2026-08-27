import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

// #286: strong-signal (clientProvided) conversation identities must key the
// session on (protocol, conversation) only — credential rotation (ChatGPT
// OAuth bearer) and upstream/relay switches must not orphan the session and
// its compression state. Weak signals (content fingerprints) keep the full
// 4-dim key (protocol|upstream|credential|conversation) for isolation.

function responsesSse(): string {
    const block = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };
    return (
        block("response.created", { response: { id: "resp_1", status: "in_progress" } }) +
        block("response.in_progress", { response: { id: "resp_1", status: "in_progress" } }) +
        block("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }) +
        block("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
        block("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" }) +
        block("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }) +
        block("response.content_part.done", { item_id: "msg_1", output_index: 0, content_index: 0 }) +
        block("response.output_item.done", { output_index: 0, item }) +
        block("response.completed", { response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3 } } })
    );
}

function anthropicSse(): string {
    const block = (event: string, data: Record<string, unknown>): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return (
        block("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 10 } } }) +
        block("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        block("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        block("content_block_stop", { type: "content_block_stop", index: 0 }) +
        block("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
        block("message_stop", { type: "message_stop" })
    );
}

function chatSse(): string {
    const chunk = (choices: unknown): string =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices })}\n\n`;
    return (
        chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: { content: "ok" }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
        "data: [DONE]\n\n"
    );
}

interface MockUpstream {
    server: http.Server;
    port: number;
    close(): Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const url = req.url ?? "";
            if (req.method !== "POST") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "mock upstream: unsupported" } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (url.endsWith("/v1/messages")) res.end(anthropicSse());
            else if (url.endsWith("/responses")) res.end(responsesSse());
            else if (url.endsWith("/chat/completions")) res.end(chatSse());
            else res.end(responsesSse());
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    return {
        server,
        port,
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
}

interface Harness {
    proxyPort: number;
    upstreams: MockUpstream[];
    close(): Promise<void>;
}

async function startHarness(upstreamCount = 1): Promise<Harness> {
    const upstreams: MockUpstream[] = [];
    for (let i = 0; i < upstreamCount; i++) upstreams.push(await startMockUpstream());
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const routes: ProxyOptions["routes"] = {};
    for (const u of upstreams) {
        routes[`http://127.0.0.1:${u.port}`] = { models: { "gpt-test": { context: 100_000 }, "claude-test": { context: 100_000 } } };
    }
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreams,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            await Promise.all(upstreams.map((u) => u.close()));
        },
    };
}

interface StatsSession {
    id: string;
    protocol: string;
    upstream: string;
    requests: number;
}

async function getSessions(h: Harness): Promise<StatsSession[]> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/stats`);
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { sessions: StatsSession[] };
    return json.sessions;
}

async function post(h: Harness, upstreamIdx: number, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
    const up = h.upstreams[upstreamIdx]!;
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${up.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    assert.equal(resp.status, 200, `proxy returned ${resp.status}`);
    await resp.text();
}

function responsesBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "gpt-test",
        stream: true,
        instructions: "You are a test assistant.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        ...extra,
    };
}

function anthropicBody(): Record<string, unknown> {
    return { model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [{ role: "user", content: "hello" }] };
}

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }], ...extra };
}

test("e2e session identity: responses body.session_id survives bearer rotation (#286, #280)", async () => {
    const h = await startHarness();
    try {
        const body = responsesBody({ session_id: "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-old" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-new" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.protocol, "responses");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: responses session-id header survives bearer rotation (#286)", async () => {
    const h = await startHarness();
    try {
        const body = responsesBody();
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-old", "session-id": "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-new", "session-id": "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.protocol, "responses");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: responses body.session_id survives upstream/relay switch (#286)", async () => {
    const h = await startHarness(2);
    try {
        const body = responsesBody({ session_id: "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer keyA" });
        await post(h, 1, "/v1/responses", body, { authorization: "Bearer keyA" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: anthropic x-claude-code-session-id survives x-api-key rotation (#286)", async () => {
    const h = await startHarness();
    try {
        const body = anthropicBody();
        await post(h, 0, "/v1/messages", body, { "x-api-key": "sk-ant-old", "x-claude-code-session-id": "claude-sess-1" });
        await post(h, 0, "/v1/messages", body, { "x-api-key": "sk-ant-new", "x-claude-code-session-id": "claude-sess-1" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.protocol, "anthropic");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: openai prompt_cache_key survives bearer rotation (#286)", async () => {
    const h = await startHarness();
    try {
        const body = chatBody({ prompt_cache_key: "pck-omp-1" });
        await post(h, 0, "/v1/chat/completions", body, { authorization: "Bearer bearer-old" });
        await post(h, 0, "/v1/chat/completions", body, { authorization: "Bearer bearer-new" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.protocol, "openai");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: weak signal (content fingerprint) keeps credential isolation (#286)", async () => {
    const h = await startHarness();
    try {
        const body = responsesBody();
        // No session signal at all → content fingerprint. Same content, no
        // credential → same session (fingerprint stability).
        await post(h, 0, "/v1/responses", body, {});
        await post(h, 0, "/v1/responses", body, {});
        // Same content, different credential → different session: the 4-dim
        // key still isolates anonymous content by account.
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer keyX" });
        // Different content, no credential → different session.
        await post(h, 0, "/v1/responses", responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "different opener" }] }] }), {});
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 3, `expected 3 sessions, got ${JSON.stringify(sessions)}`);
        const requests = sessions.map((s) => s.requests).sort((a, b) => a - b);
        assert.deepEqual(requests, [1, 1, 2]);
    } finally {
        await h.close();
    }
});

test("e2e session identity: distinct session_ids stay separate (#286)", async () => {
    const h = await startHarness();
    try {
        await post(h, 0, "/v1/responses", responsesBody({ session_id: "sess-A" }), { authorization: "Bearer keyA" });
        await post(h, 0, "/v1/responses", responsesBody({ session_id: "sess-B" }), { authorization: "Bearer keyA" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 2, `expected 2 sessions, got ${JSON.stringify(sessions)}`);
    } finally {
        await h.close();
    }
});
