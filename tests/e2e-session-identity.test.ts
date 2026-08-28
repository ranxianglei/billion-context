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
import { deriveFingerprintSessionId } from "../src/session-id.ts";

// #286: the session ID is the client-provided conversation value VERBATIM —
// no hash, no other dimensions. Credential rotation (ChatGPT OAuth bearer),
// upstream/relay switches, and even wire-protocol switches must not orphan
// the session and its compression state. Requests WITHOUT a client-provided
// identity are rejected with 400 (content-fingerprint sessions disabled).

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

async function startHarness(upstreamCount = 1, allowFingerprintSessions = false): Promise<Harness> {
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
        allowFingerprintSessions,
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
    const resp = await postRaw(h, upstreamIdx, path, body, headers);
    assert.equal(resp.status, 200, `proxy returned ${resp.status}: ${await resp.text()}`);
}

async function postRaw(h: Harness, upstreamIdx: number, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const up = h.upstreams[upstreamIdx]!;
    return fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${up.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
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

test("e2e session identity: responses body.session_id survives bearer rotation; id is the value verbatim (#286, #280)", async () => {
    const h = await startHarness();
    try {
        const body = responsesBody({ session_id: "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-old" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-new" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.id, "019fdc81-a420-7a00-bbd1-0a64e3eb772c");
        assert.equal(sessions[0]!.protocol, "responses");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: responses session-id header survives bearer rotation; id is the value verbatim (#286)", async () => {
    const h = await startHarness();
    try {
        const body = responsesBody();
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-old", "session-id": "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        await post(h, 0, "/v1/responses", body, { authorization: "Bearer bearer-new", "session-id": "019fdc81-a420-7a00-bbd1-0a64e3eb772c" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.id, "019fdc81-a420-7a00-bbd1-0a64e3eb772c");
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
        assert.equal(sessions[0]!.id, "019fdc81-a420-7a00-bbd1-0a64e3eb772c");
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
        assert.equal(sessions[0]!.id, "claude-sess-1");
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
        assert.equal(sessions[0]!.id, "pck-omp-1");
        assert.equal(sessions[0]!.protocol, "openai");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: same conversation value continues across a protocol switch (relay translation, #286)", async () => {
    const h = await startHarness();
    try {
        // The same client conversation id first speaks the Responses API, then
        // the OpenAI chat API (e.g. a relay that translates between them).
        // Session state is protocol-neutral, so the session must continue.
        await post(h, 0, "/v1/responses", responsesBody({ session_id: "cross-proto-1" }), { authorization: "Bearer keyA" });
        await post(h, 0, "/v1/chat/completions", chatBody(), { authorization: "Bearer keyA", "x-session-id": "cross-proto-1" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.id, "cross-proto-1");
        assert.equal(sessions[0]!.requests, 2);
    } finally {
        await h.close();
    }
});

test("e2e session identity: anonymous responses request → 400, no session created (#286)", async () => {
    const h = await startHarness();
    try {
        const resp = await postRaw(h, 0, "/v1/responses", responsesBody(), {});
        assert.equal(resp.status, 400);
        const json = (await resp.json()) as { error?: { message?: string } };
        assert.match(json.error?.message ?? "", /Missing stable conversation identity/);
        assert.equal((await getSessions(h)).length, 0);
    } finally {
        await h.close();
    }
});

test("e2e session identity: anonymous anthropic request → 400 anthropic error shape (#286)", async () => {
    const h = await startHarness();
    try {
        const resp = await postRaw(h, 0, "/v1/messages", anthropicBody(), { "x-api-key": "sk-ant" });
        assert.equal(resp.status, 400);
        const json = (await resp.json()) as { type?: string; error?: { type?: string; message?: string } };
        assert.equal(json.type, "error");
        assert.equal(json.error?.type, "invalid_request_error");
        assert.match(json.error?.message ?? "", /Missing stable conversation identity/);
        assert.equal((await getSessions(h)).length, 0);
    } finally {
        await h.close();
    }
});

test("e2e session identity: anonymous openai request → 400, even with credentials (#286)", async () => {
    const h = await startHarness();
    try {
        const resp = await postRaw(h, 0, "/v1/chat/completions", chatBody(), { authorization: "Bearer keyX" });
        assert.equal(resp.status, 400);
        const json = (await resp.json()) as { error?: { message?: string } };
        assert.match(json.error?.message ?? "", /Missing stable conversation identity/);
        assert.equal((await getSessions(h)).length, 0);
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
        const ids = sessions.map((s) => s.id).sort();
        assert.deepEqual(ids, ["sess-A", "sess-B"]);
    } finally {
        await h.close();
    }
});

// --- #286 opt-in (issue #309): allowFingerprintSessions lets header-less
// third-party harnesses fall back to a content-fingerprint session instead of
// 400ing. Default (absent/false) keeps the hard-reject above. ---

test("deriveFingerprintSessionId: 4-dim key isolates by protocol/upstream/credential/conversation", () => {
    const base = { authorization: "Bearer keyA" };
    const same = deriveFingerprintSessionId(base, "responses", "http://up1", "conv-1");
    assert.ok(same.length > 0, "non-empty id");
    assert.equal(deriveFingerprintSessionId(base, "responses", "http://up1", "conv-1"), same, "identical inputs → identical id");
    assert.notEqual(deriveFingerprintSessionId({ authorization: "Bearer keyB" }, "responses", "http://up1", "conv-1"), same, "different credential → different id");
    assert.notEqual(deriveFingerprintSessionId(base, "responses", "http://up2", "conv-1"), same, "different upstream → different id");
    assert.notEqual(deriveFingerprintSessionId(base, "anthropic", "http://up1", "conv-1"), same, "different protocol → different id");
    assert.notEqual(deriveFingerprintSessionId(base, "responses", "http://up1", "conv-2"), same, "different conversation → different id");
    assert.throws(() => deriveFingerprintSessionId(base, "responses", "http://up1", ""), /empty conversation signal/);
});

test("opt-in: anonymous responses request → 200, a fingerprint session is created (#309)", async () => {
    const h = await startHarness(1, true);
    try {
        const resp = await postRaw(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        assert.equal(resp.status, 200, `expected 200 with opt-in, got ${resp.status}: ${await resp.text()}`);
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 fingerprint session, got ${JSON.stringify(sessions)}`);
        const s = sessions[0]!;
        assert.equal(s.protocol, "responses");
        assert.ok(s.id.length > 0 && s.id !== "hello", "id is a derived fingerprint, not the verbatim content");
    } finally {
        await h.close();
    }
});

test("opt-in: identical anonymous requests continue one fingerprint session (stable key)", async () => {
    const h = await startHarness(1, true);
    try {
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 1, `expected 1 session for identical content, got ${JSON.stringify(sessions)}`);
        assert.equal(sessions[0]!.requests, 2, "both requests land on the same fingerprint session");
    } finally {
        await h.close();
    }
});

test("opt-in: different credentials → separate fingerprint sessions (4-dim isolation)", async () => {
    const h = await startHarness(1, true);
    try {
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyB" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 2, `expected 2 sessions for different credentials, got ${JSON.stringify(sessions)}`);
    } finally {
        await h.close();
    }
});

test("opt-in: different content → separate fingerprint sessions (content dimension)", async () => {
    const h = await startHarness(1, true);
    try {
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        await post(h, 0, "/v1/responses", responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a totally different prompt" }] }] }), { authorization: "Bearer keyA" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 2, `expected 2 sessions for different content, got ${JSON.stringify(sessions)}`);
    } finally {
        await h.close();
    }
});

test("opt-in: a client-provided identity still wins over the fingerprint fallback (#309)", async () => {
    const h = await startHarness(1, true);
    try {
        // Anonymous → fingerprint session.
        await post(h, 0, "/v1/responses", responsesBody(), { authorization: "Bearer keyA" });
        // Same content but WITH a session_id → verbatim id, separate session.
        await post(h, 0, "/v1/responses", responsesBody({ session_id: "explicit-1" }), { authorization: "Bearer keyA" });
        const sessions = await getSessions(h);
        assert.equal(sessions.length, 2, `expected 2 sessions (fingerprint + explicit), got ${JSON.stringify(sessions)}`);
        const ids = sessions.map((s) => s.id).sort();
        assert.ok(ids.includes("explicit-1"), "the explicit session_id is recorded verbatim");
    } finally {
        await h.close();
    }
});
