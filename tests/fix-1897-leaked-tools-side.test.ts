import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer, stripLeakedBiliTools, BILI_TOOL_NAMES } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { PROXY_TOOL_NAMES, ABSORB_TOOL_NAME, RETRIEVE_TOOL_NAME, RULE_TOOL_NAME } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

// #1897: omp registers bili's ACP tools as first-class extension tools and
// includes them in EVERY model request — including the session-start title
// request, which carries no host action tools of its own and titles with
// max_tokens=1024 (> the 200 budget gate). Pre-fix, the leaked tools tripped
// the #546 "non-empty tools = main turn" rule, so the title payload rode
// processTurn under the main session id (refs/usage pollution) and ~4K of
// tool tokens were billed upstream per session start. Post-fix, a request
// whose ENTIRE tools array is bili's own set is demoted to the side
// passthrough and the leak is stripped from the wire.

function openAiTool(name: string): Record<string, unknown> {
    return { type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } };
}

function biliCoreToolsOpenAi(): Record<string, unknown>[] {
    return [...PROXY_TOOL_NAMES].map(openAiTool);
}

test("stripLeakedBiliTools: all-bili openai tools → demoted, tools key deleted", () => {
    const body = { model: "m", max_tokens: 1024, messages: [{ role: "user", content: "hi" }], tools: biliCoreToolsOpenAi() };
    assert.equal(stripLeakedBiliTools(body), true);
    assert.equal(body.tools, undefined, "leak stripped");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }], "rest of the body untouched");
});

test("stripLeakedBiliTools: ANY host tool vetoes the demotion (#546 direction preserved)", () => {
    const tools = [...biliCoreToolsOpenAi(), openAiTool("bash")];
    const body = { model: "m", max_tokens: 1024, tools };
    assert.equal(stripLeakedBiliTools(body), false);
    assert.deepEqual(body.tools, tools, "body untouched when a host tool is present");
});

test("stripLeakedBiliTools: anthropic and responses shapes", () => {
    const anthr = { model: "m", tools: [...PROXY_TOOL_NAMES].map((n) => ({ name: n })) };
    assert.equal(stripLeakedBiliTools(anthr), true, "anthropic {name} shape");
    const resp = { model: "m", tools: [...PROXY_TOOL_NAMES].map((n) => ({ type: "function", name: n })) };
    assert.equal(stripLeakedBiliTools(resp), true, "responses {type,name} shape");
    const respMixed = { model: "m", tools: [{ type: "function", name: "compress" }, { type: "function", name: "shell" }] };
    assert.equal(stripLeakedBiliTools(respMixed), false, "one non-bili name vetoes");
});

test("stripLeakedBiliTools: google functionDeclarations (one entry may declare many)", () => {
    const all = { model: "m", tools: [{ functionDeclarations: [...PROXY_TOOL_NAMES].map((n) => ({ name: n })) }] };
    assert.equal(stripLeakedBiliTools(all), true, "single entry declaring only bili tools");
    const mixed = { model: "m", tools: [{ functionDeclarations: [{ name: "compress" }, { name: "exec" }] }] };
    assert.equal(stripLeakedBiliTools(mixed), false, "any non-bili declaration vetoes");
});

test("stripLeakedBiliTools: opt-in bili extras count as bili-owned", () => {
    const body = { model: "m", tools: [openAiTool(ABSORB_TOOL_NAME), openAiTool(RULE_TOOL_NAME), openAiTool(RETRIEVE_TOOL_NAME)] };
    assert.equal(stripLeakedBiliTools(body), true);
    for (const n of [ABSORB_TOOL_NAME, RULE_TOOL_NAME, RETRIEVE_TOOL_NAME]) {
        assert.ok(BILI_TOOL_NAMES.has(n), `${n} in the bili set`);
    }
});

test("stripLeakedBiliTools: starved budget vetoes — the #546 rescue path stays a main turn", () => {
    const starved = { model: "m", max_tokens: 16, tools: biliCoreToolsOpenAi() };
    assert.equal(stripLeakedBiliTools(starved), false, "starved budget (<=200) + all-bili tools must NOT demote");
    assert.ok(Array.isArray(starved.tools), "tools preserved so restoreOutputBudget can run");
    const boundary = { model: "m", max_tokens: 200, tools: biliCoreToolsOpenAi() };
    assert.equal(stripLeakedBiliTools(boundary), false, "boundary 200 still protects the rescue path");
    const justAbove = { model: "m", max_tokens: 201, tools: biliCoreToolsOpenAi() };
    assert.equal(stripLeakedBiliTools(justAbove), true, "201 is no longer starved → demoted");
    const noBudget = { model: "m", tools: biliCoreToolsOpenAi() };
    assert.equal(stripLeakedBiliTools(noBudget), true, "missing budget cannot veto (opencode v2 title-gen shape)");
});

test("stripLeakedBiliTools: absent/empty/malformed tools → inert", () => {
    assert.equal(stripLeakedBiliTools({ model: "m" }), false, "no tools key");
    assert.equal(stripLeakedBiliTools({ model: "m", tools: [] }), false, "empty array");
    assert.equal(stripLeakedBiliTools({ model: "m", tools: [null] }), false, "malformed entry");
    assert.equal(stripLeakedBiliTools({ model: "m", tools: [{ type: "function" }] }), false, "entry without a resolvable name");
    assert.equal(stripLeakedBiliTools(null), false, "null body");
    assert.equal(stripLeakedBiliTools([1, 2]), false, "array body");
    assert.equal(stripLeakedBiliTools("x"), false, "string body");
});

const MODEL = "claude-sonnet-4-5";
const SESSION = "fix-1897-sess";
const MAIN_INPUT_TOKENS = 50_000;

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<title>Test post</title>" } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    lastBody: Record<string, unknown> | null;
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            rig.lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    } as ProxyOptions);
    await once(proxy, "listening");
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = (proxy.address() as { port: number }).port; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

const TITLE_MESSAGES = [
    { role: "system", content: "Write a ~5 word title using only the task described in the next user message.\n- You MUST ONLY answer with the title, inside the <title> tag." },
    { role: "user", content: "test post please ignore" },
];

test("e2e: omp title-gen with leaked bili tools is demoted to side passthrough (#1897)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "omp",
            "x-bili-plugin-conversation": SESSION,
        };
        // The exact reported shape: omp's online title-gen (max_tokens=1024,
        // verified in oh-my-pi source) with every registered extension tool
        // leaking in because omp includes them in all model requests.
        const body = { model: MODEL, max_tokens: 1024, stream: true, tools: biliCoreToolsOpenAi(), messages: TITLE_MESSAGES };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody as Record<string, unknown> | null;
        assert.ok(fwd, "upstream received the request");
        assert.equal(fwd?.tools, undefined, "leaked bili tools stripped from the wire");
        assert.deepEqual(fwd?.messages, TITLE_MESSAGES, "title payload forwarded verbatim (nothing injected, nothing rewritten)");
        assert.equal(fwd?.max_tokens, 1024, "budget untouched — demotion runs before restoreOutputBudget");

        const s = getSession(SESSION);
        assert.ok(s, "session row exists (created before the gate)");
        assert.equal(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state untouched by the demoted request");
        assert.equal(s.stats.requests, 0, "demoted request is NOT a main turn");
        assert.equal(s.stats.lastInputTokens, 0, "title usage must not seed the nudge baseline (#460 contract; fresh sessions start at 0)");
        assert.equal(s.metadata.outputBudgetHighWater, undefined, "leak cannot seed the output-budget high-water mark");
        assert.equal(s.metadata.pluginAgent, "omp", "plugin binding still sticks (it happens before the side gate)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: faithful omp lane — no plugin headers, identity register + prompt_cache_key only", async () => {
    const rig = await startRig();
    try {
        // omp stamps NO x-bili-plugin* headers (pi.ts: omp never emits
        // before_provider_headers); its binding rides the identity register,
        // which the extension awaits inside registerTools BEFORE the first
        // model request, plus the body prompt_cache_key it stamps on every
        // chat-shaped payload (server.ts promotes pck over the content
        // fingerprint for headerless openai requests).
        const reg = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: SESSION, agent: "omp", identity: true }),
        });
        assert.equal(reg.status, 200);
        await reg.text();

        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json" };
        const body = { model: MODEL, max_tokens: 1024, stream: true, prompt_cache_key: SESSION, tools: biliCoreToolsOpenAi(), messages: TITLE_MESSAGES };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody as Record<string, unknown> | null;
        assert.ok(fwd, "upstream received the request");
        assert.equal(fwd?.tools, undefined, "leaked bili tools stripped from the wire");
        assert.deepEqual(fwd?.messages, TITLE_MESSAGES, "title payload forwarded verbatim");
        assert.equal(fwd?.max_tokens, 1024, "budget untouched");

        const s = getSession(SESSION);
        assert.ok(s, "session derives from prompt_cache_key even without conversation headers");
        assert.equal(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state untouched");
        assert.equal(s.stats.requests, 0, "demoted request is NOT a main turn");
        assert.equal(s.metadata.pluginAgent, "omp", "identity register bound plugin mode before the side gate");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: mixed host+bili tools stay a MAIN turn through the pipeline (#546 direction preserved)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "omp",
            "x-bili-plugin-conversation": SESSION,
        };
        const tools = [...biliCoreToolsOpenAi(), openAiTool("bash")];
        const body = { model: MODEL, max_tokens: 1024, stream: true, tools, messages: mainConversation(4) };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody as Record<string, unknown> | null;
        assert.ok(Array.isArray(fwd?.tools), "tools survive — a host tool vetoes the demotion");
        assert.ok(JSON.stringify(fwd?.tools).includes('"bash"'), "host tool intact on the wire");
        assert.equal((fwd?.tools as unknown[]).length, tools.length, "plugin mode passes client tools through (no extra injection)");

        const s = getSession(SESSION);
        assert.equal(s.stats.requests, 1, "mixed-tools request goes through the main pipeline");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state advanced by the main turn");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: all-bili tools WITH history artifacts stay a MAIN turn (#1197 boundary)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": SESSION,
            "x-bili-plugin": "omp",
            "x-bili-plugin-conversation": SESSION,
        };
        // The #1197/#1086 boundary: the ENTIRE tools array is bili's set BUT the
        // history re-sends real invocations of both ACP tools — a live plugin
        // session replaying its own compression state, NOT a utility side request.
        // All-bili tools alone cannot mean "side request"; history artifacts must
        // veto the demotion so this runs through the kernel.
        const body = {
            model: MODEL, max_tokens: 1024, stream: true,
            tools: [openAiTool("acp_status"), openAiTool("search_context")],
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "user", content: "hello world, please help me with a task" },
                { role: "assistant", content: null, tool_calls: [
                    { id: "call_1", type: "function", function: { name: "acp_status", arguments: "{}" } },
                    { id: "call_2", type: "function", function: { name: "search_context", arguments: "{}" } },
                ]},
                { role: "tool", tool_call_id: "call_1", content: "ok" },
                { role: "tool", tool_call_id: "call_2", content: "ok" },
            ],
        };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody as Record<string, unknown> | null;
        assert.ok(fwd, "upstream received the request");
        assert.ok(Array.isArray(fwd?.tools), "tools SURVIVE — history artifacts veto the demotion");
        assert.ok(JSON.stringify(fwd?.tools).includes('"acp_status"'), "leak NOT stripped when the request is a live session");

        const s = getSession(SESSION);
        assert.equal(s.stats.requests, 1, "all-bili tools + history artifacts = live session → processed, not demoted (#1197)");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state advanced by the main turn");
    } finally {
        await closeRig(rig);
    }
});
