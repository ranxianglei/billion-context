import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, _sessionsSizeForTest, peekSession } from "../src/session.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { CLAUDE_CODE_TITLE_SESSION_TAG, isClaudeCodeTitleRequest } from "../src/server/side-request.ts";

// #5135: Claude Code CLI's session-title sidecar (proxy mode, header-less)
// fires at session start UNDER THE SAME x-claude-code-session-id as the first
// main turn, ~1ms ahead of it. Field shape (0.1.209, three machines): a single
// user message wrapping the first prompt in \x3csession\x3e…\x3c/session\x3e,
// no tools, an output budget past the <=200 heuristic, and its OWN system
// prompt. Pre-fix it entered the #4774 order resolver on the virgin id and
// CLAIMED the raw key as kernel anchor; the main turn then arrived tagChanged
// and history-disjoint and forked onto |sub:<fp> for the session lifetime
// (#2156 form: side requests must never claim the anchor). Two layers pinned
// here: the shape predicate's truth table, and the live race against the real
// pipeline (both arrival orders + the client-evidence negative).

// Every test mints its OWN session id: the order-resolver skeleton state is
// persisted per raw id (#3397) and re-hydrated on each server boot, so a fixed
// id shared across tests would let one test's anchor leak into the next.

// System-block corpus shared with tests/issue4352-claude-anthropic-subagent-split.test.ts.
const MAIN_SYSTEM = ["You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent..."];
const TITLE_SYSTEM = "Summarize the user's first message into a short title.";
const BLOB = `${CLAUDE_CODE_TITLE_SESSION_TAG}fix the flaky login test\u003c/session\u003e`;

type Msg = { role: string; content: string };
/** n alternating user/assistant turns with distinct per-prefix content. */
function history(prefix: string, turns: number): Msg[] {
    const out: Msg[] = [];
    for (let i = 1; i <= turns; i++) {
        out.push({ role: "user", content: `${prefix}-user-${i}` });
        out.push({ role: "assistant", content: `${prefix}-assistant-${i}` });
    }
    return out;
}

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Minimal valid Anthropic /v1/messages SSE stream: one text block "ok". */
function anthropicStream(): string {
    return (
        sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sse("content_block_stop", { index: 0 }) +
        sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        sse("message_stop", {})
    );
}

function startMockUpstream(): http.Server {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(anthropicStream());
        res.end();
    });
    server.listen(0, "127.0.0.1");
    return server;
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startHarness(upstream: http.Server, over: Partial<ProxyOptions> = {}): Promise<{ proxy: http.Server; post: (headers: Record<string, string>, body?: Record<string, unknown>) => Promise<{ status: number; text: string }> }> {
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
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
        ...over,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const post = async (headers: Record<string, string>, body?: Record<string, unknown>) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? { model: "claude-test", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
            duplex: "half",
        } as RequestInit);
        const text = await res.text();
        return { status: res.status, text };
    };
    return { proxy, post };
}

function freshState(): void {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    resetSessionOrderForTest();
}

const ccHeadersFor = (id: string) => ({ "x-claude-code-session-id": id });
const sysBlocks = (system: string[]): { type: string; text: string }[] => system.map((t) => ({ type: "text", text: t }));
const mainBody = (hist: Msg[], system: string[] = MAIN_SYSTEM): Record<string, unknown> =>
    ({ model: "claude-test", stream: true, max_tokens: 1024, system: sysBlocks(system), messages: hist });
const titleBody = (): Record<string, unknown> =>
    ({ model: "claude-test", stream: true, max_tokens: 4096, system: TITLE_SYSTEM, messages: [{ role: "user", content: BLOB }] });

test("isClaudeCodeTitleRequest truth table: positive shapes match, every veto holds", () => {
    const base = { model: "claude-test", max_tokens: 4096, system: TITLE_SYSTEM };
    // Positive — anthropic wire, string content
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: BLOB }] }), true);
    // Positive — block-array content (first text block carries the wrapper)
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: [{ type: "text", text: BLOB }] }] }), true);
    // Positive — leading whitespace before the wrapper
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: `  ${BLOB}` }] }), true);
    // Positive — responses wire (typed message item, instructions carrier)
    assert.equal(isClaudeCodeTitleRequest("responses", { model: "claude-test", max_output_tokens: 4096, instructions: TITLE_SYSTEM, input: [{ type: "message", role: "user", content: BLOB }] }), true);
    // Positive — google wire (parts carrier)
    assert.equal(isClaudeCodeTitleRequest("google", { systemInstruction: { parts: [{ text: TITLE_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: BLOB }] }] }), true);
    // Negative — any tools surface vetoes (an agent turn, not the one-shot call)
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, tools: [{ name: "Bash", input_schema: {} }], messages: [{ role: "user", content: BLOB }] }), false, "tools veto");
    // Negative — a second entry is a replayed history, not the one-shot title call
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: BLOB }, { role: "assistant", content: "ok" }] }), false, "history veto");
    // Negative — missing wrapper
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: "fix the flaky login test" }] }), false, "wrapper required");
    // Negative — empty content
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: "" }] }), false, "empty content");
    // Negative — non-text-only blocks
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }), false, "no text blocks");
    // Negative — assistant role
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [{ role: "assistant", content: BLOB }] }), false, "role must be user");
    // Negative — typed non-message item (a real model round-trip artifact)
    assert.equal(isClaudeCodeTitleRequest("responses", { instructions: TITLE_SYSTEM, input: [{ type: "reasoning", role: "assistant", content: BLOB }] }), false, "typed item veto");
    // Negative — zero entries / null protocol / non-object body
    assert.equal(isClaudeCodeTitleRequest("anthropic", { ...base, messages: [] }), false, "zero entries");
    assert.equal(isClaudeCodeTitleRequest(null, { ...base, messages: [{ role: "user", content: BLOB }] }), false, "protocol null");
    assert.equal(isClaudeCodeTitleRequest("anthropic", null), false, "non-object body");
});

test("#5135 race: title call FIRST — the main conversation keeps the raw key", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        // The reported topology: the title sidecar arrives ~1ms ahead of the
        // first main turn on the virgin id. Pre-fix it claimed the raw-key
        // anchor in the #4774 order resolver and the main turn forked onto
        // |sub:<fp>; now it rides verbatim + #388 passthrough.
        const t = await post(ccHeaders, titleBody());
        assert.equal(t.status, 200, `title call: ${t.text}`);
        assert.equal(peekSession(SESSION)?.stats.requests ?? 0, 0, "the title call counts nowhere");
        assert.equal(_sessionsSizeForTest(), 1, "the title call mints no fork lane");
        const m = await post(ccHeaders, mainBody(history("main", 1)));
        assert.equal(m.status, 200, `main turn: ${m.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 1, "the main turn lands on the RAW key");
        assert.equal(_sessionsSizeForTest(), 1, "the main conversation never forks");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#5135 race: main turn FIRST — the later title call stays transparent", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        const m = await post(ccHeaders, mainBody(history("main", 1)));
        assert.equal(m.status, 200, `main turn: ${m.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 1, "the main turn anchors the raw key");
        const t = await post(ccHeaders, titleBody());
        assert.equal(t.status, 200, `title call: ${t.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 1, "the late title call counts nowhere");
        assert.equal(_sessionsSizeForTest(), 1, "the late title call mints no fork lane");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#5135 gate: the same shape from a non-claude-code client is NOT exempted", async () => {
    freshState();
    const SESSION = randomUUID();
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        // Evidence-per-client discipline: the exemption follows the claude-code
        // conversation source (the population #4774 routes through the order
        // resolver). A plain anthropic client sending the same shape keeps its
        // pre-fix behavior — full pipeline, counted.
        const r = await post({ "x-acp-session": SESSION }, titleBody());
        assert.equal(r.status, 200, `non-CC title-shaped call: ${r.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 1, "full pipeline, counted");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
