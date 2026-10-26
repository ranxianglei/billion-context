import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { claudeSubagentAgentId, claudeSubagentSplit } from "../src/session-id.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const SESSION = "bb54027d-f1bf-4043-8ec3-a1b2c3d4e5f6";
const SUB_AGENT = "a51e8a9a05a035095";
const SUB_SESSION = `${SESSION}|sub:${SUB_AGENT}`;

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

/** Mock anthropic upstream. The FIRST connection to arrive is gated behind
 *  `firstDelayMs` before its first byte; every later connection answers
 *  immediately. Used to prove the subagent request is not queued behind the
 *  main session's in-flight stream (the #970 stall). */
function startMockAnthropicUpstream(firstDelayMs: number): { server: http.Server; connections: number } {
    const state = { connections: 0 };
    const server = http.createServer((_req, res) => {
        const isFirst = state.connections++ === 0;
        const body = anthropicStream();
        if (isFirst) {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(body);
                res.end();
            }, firstDelayMs);
        } else {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(body);
            res.end();
        }
    });
    server.listen(0, "127.0.0.1");
    return { server, connections: 0 };
}

type Harness = {
    proxy: http.Server;
    url: string;
    post: (headers: Record<string, string>, body?: Record<string, unknown>) => Promise<{ status: number; text: string; tFirstChunk: number }>;
};

async function startHarness(upstream: http.Server, over: Partial<ProxyOptions> = {}): Promise<Harness> {
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
    const t0 = performance.now();
    const post = async (headers: Record<string, string>, body?: Record<string, unknown>) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? { model: "claude-test", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
            duplex: "half",
        } as RequestInit);
        let tFirstChunk = 0;
        const text = await res.text();
        tFirstChunk = performance.now() - t0;
        return { status: res.status, text, tFirstChunk };
    };
    return { proxy, url, post };
}

const sessionHeaders = { "x-claude-code-session-id": SESSION };
const subagentHeaders = { "x-claude-code-session-id": SESSION, "x-claude-code-agent-id": SUB_AGENT, "x-claude-code-parent-agent-id": "a47c8f3e8bac7386b" };

// System-block shapes captured from live Claude Code 2.1.274 traffic.
const MAIN_INTERACTIVE_SYSTEM = ["You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent..."];
const MAIN_PRINT_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "You are an interactive agent that helps..."];
const GENERAL_PURPOSE_SUB_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "This session is a background job. The..."];
const EXPLORE_SUB_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "You are a file search specialist for..."];

test("claudeSubagentAgentId: two-signal discrimination (headers + main system prefixes)", () => {
    assert.equal(claudeSubagentAgentId(subagentHeaders, GENERAL_PURPOSE_SUB_SYSTEM), SUB_AGENT, "general-purpose subagent splits");
    assert.equal(claudeSubagentAgentId(subagentHeaders, EXPLORE_SUB_SYSTEM), SUB_AGENT, "custom agent type (Explore) splits");
    assert.equal(claudeSubagentAgentId({ "x-claude-code-session-id": SESSION, "x-claude-code-agent-id": SUB_AGENT }, EXPLORE_SUB_SYSTEM), SUB_AGENT, "agent-id without parent still splits (custom agent types send no parent header)");
    assert.equal(claudeSubagentAgentId({ "x-claude-code-agent-id": "a47c8f3e8bac7386b" }, MAIN_PRINT_SYSTEM), undefined, "-p main turn (agent-id present, interactive system block) must not split");
    assert.equal(claudeSubagentAgentId({ "x-claude-code-agent-id": "a47c8f3e8bac7386b" }, MAIN_INTERACTIVE_SYSTEM), undefined, "interactive main turn must not split even with agent-id");
    assert.equal(claudeSubagentAgentId(sessionHeaders, MAIN_INTERACTIVE_SYSTEM), undefined, "no agent headers must not split");
    assert.equal(claudeSubagentAgentId(subagentHeaders, []), SUB_AGENT, "no system at all but agent headers present splits (header-only fallback)");
    assert.equal(claudeSubagentAgentId({ "x-claude-code-agent-id": "  ", "x-claude-code-parent-agent-id": "p" }, EXPLORE_SUB_SYSTEM), "p", "blank agent id falls back to the parent id");
    assert.equal(claudeSubagentAgentId({ "x-claude-code-agent-id": ["a"], "x-claude-code-parent-agent-id": "p" }, EXPLORE_SUB_SYSTEM), "p", "array-valued (repeated) agent header falls back to parent");
    assert.equal(claudeSubagentAgentId(subagentHeaders, ["  You are Claude Code..."]), undefined, "main prefix matched after leading whitespace");
});

test("claudeSubagentSplit: stable namespace, main untouched", () => {
    assert.equal(claudeSubagentSplit(SESSION, subagentHeaders, GENERAL_PURPOSE_SUB_SYSTEM), SUB_SESSION);
    assert.equal(claudeSubagentSplit(SESSION, subagentHeaders, GENERAL_PURPOSE_SUB_SYSTEM), SUB_SESSION, "same agent id reuses the split id across turns");
    assert.equal(claudeSubagentSplit(SESSION, sessionHeaders, MAIN_INTERACTIVE_SYSTEM), SESSION);
    const other = { ...subagentHeaders, "x-claude-code-agent-id": "a81aa02c77b7bece7" };
    assert.notEqual(claudeSubagentSplit(SESSION, other, EXPLORE_SUB_SYSTEM), SUB_SESSION, "a second subagent gets its own namespace");
    assert.equal(claudeSubagentSplit(SESSION, { "x-claude-code-agent-id": `  ${SUB_AGENT}  `, "x-claude-code-parent-agent-id": " p " }, EXPLORE_SUB_SYSTEM), SUB_SESSION, "whitespace is trimmed");
});

test("#970 split: subagent lands on its own session; main identity is stable", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const upstream = startMockAnthropicUpstream(0).server;
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        const main1 = await post(sessionHeaders);
        assert.equal(main1.status, 200, `main request: ${main1.text}`);
        assert.ok(peekSession(SESSION), "main request must create the session keyed by the session header");

        const sub = await post(subagentHeaders);
        assert.equal(sub.status, 200, `subagent request: ${sub.text}`);
        const subSession = peekSession(SUB_SESSION);
        assert.ok(subSession, "subagent request must create a session keyed by the split id");
        assert.notEqual(subSession, peekSession(SESSION), "subagent and main must be separate session objects (isolated lock chains / compression state)");

        const main2 = await post(sessionHeaders);
        assert.equal(main2.status, 200, `main turn 2: ${main2.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 2, "later main turns accumulate on the MAIN session");
        assert.equal(peekSession(SUB_SESSION)!.stats.requests, 1, "subagent session must not absorb main turns");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#970 no-stall: a subagent is not head-of-line-blocked by the main turn's slow stream", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    // First upstream connection (= the main request, fired first) is gated
    // 1200ms before its first byte. Pre-fix the subagent queued on the main
    // session's lock chain and its first byte came AFTER the main's; post-fix
    // it streams through its own session immediately.
    const upstream = startMockAnthropicUpstream(1200).server;
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        const mainPromise = post(sessionHeaders);
        await new Promise((r) => setTimeout(r, 80)); // let the main request take the lock first
        const subPromise = post(subagentHeaders);
        const [main, sub] = await Promise.all([mainPromise, subPromise]);
        assert.equal(main.status, 200, `main: ${main.text}`);
        assert.equal(sub.status, 200, `sub: ${sub.text}`);
        assert.ok(peekSession(SUB_SESSION), "split session exists");
        assert.ok(
            sub.tFirstChunk < main.tFirstChunk - 500,
            `subagent first byte (${sub.tFirstChunk.toFixed(0)}ms) must beat the gated main stream (${main.tFirstChunk.toFixed(0)}ms) by a wide margin — it was queued on the main session's lock`,
        );
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#970 gate: subagentSplit:false restores the single-session behavior", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const upstream = startMockAnthropicUpstream(0).server;
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream, { subagentSplit: false });
    try {
        const main = await post(sessionHeaders);
        const sub = await post(subagentHeaders);
        assert.equal(main.status, 200, `main: ${main.text}`);
        assert.equal(sub.status, 200, `sub: ${sub.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 2, "with the split off, both requests accumulate on one session");
        assert.equal(peekSession(SUB_SESSION), undefined, "with the split off, no split session is minted");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
