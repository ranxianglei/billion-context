import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { isServerToolUtilityCall, isSideRequest, resolveSideLane, SIDE_REQUEST_MAX_TOKENS } from "../src/server/side-request.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

// #2500: Claude Code sends WebSearch sub-requests under the MAIN session id —
// one message, tools = ONLY Anthropic server-executed web_search_/web_fetch_
// versions. Pre-fix the #546 rule (non-empty tools ⇒ main turn) routed them
// through the full pipeline: bili tools/prompt injected (~4K billed tokens per
// search) and their usage (25–85K) landed as a usage-grade sample that
// re-anchored the main session's nudge baseline (#1595) → premature folds.
// Post-fix the structural shape rides the #388 side passthrough: kernel state,
// stats, snapshot and the output-budget high-water stay untouched.

const MODEL = "claude-sonnet-4-5";
const SESSION = "websearch-side-sess";
// Main-turn real usage sits HIGH (160K, below the 200K window) so a search
// sample far below it − the flat 50K growth margin can trigger the #1595
// re-anchor pre-fix (the issue's production shape: 164637 -> 25255).
const MAIN_INPUT_TOKENS = 160_000;
const SEARCH_INPUT_TOKENS = 85_000;

const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

function searchBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: MODEL,
        stream: true,
        max_tokens: 32_000,
        messages: [{ role: "user", content: "Perform a web search for the query: context compression for AI agents" }],
        system: "You are an assistant for performing a web search tool use.",
        tools: [SEARCH_TOOL],
        tool_choice: { type: "auto" },
        ...over,
    };
}

test("isServerToolUtilityCall: positive — the captured Claude Code 2.1.288 shape", () => {
    assert.equal(isServerToolUtilityCall(searchBody()), true, "captured shape (object tool_choice auto)");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: { type: "tool", name: "web_search" } })), true, "forced DECLARED tool (thinking-off source shape)");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: "auto" })), true, "string auto");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: "any" })), true, "string any");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: { type: "any" } })), true, "object any");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: undefined })), true, "absent tool_choice");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] })), true, "web_fetch family");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [{ type: "web_search_20250305", name: "web_search" }, { type: "web_fetch_20250910", name: "web_fetch" }] })), true, "mixed server-executed types");
});

test("isServerToolUtilityCall: negatives — every veto keeps the request on the main pipeline", () => {
    assert.equal(isServerToolUtilityCall(null), false, "null body");
    assert.equal(isServerToolUtilityCall({}), false, "empty body");
    assert.equal(isServerToolUtilityCall(searchBody({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })), false, "history-bearing forced-search turn is a REAL main turn");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: "none" })), false, "string none vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: { type: "none" } })), false, "object none vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: { type: "tool", name: "bash" } })), false, "forcing an UNDECLARED tool vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tool_choice: { type: "required" } })), false, "unrecognized tool_choice shape vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [{ type: "bash_20250124", name: "bash" }] })), false, "client-executed versioned tool does not match");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }] })), false, "text_editor family does not match");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [...([SEARCH_TOOL] as unknown[]), { type: "function", function: { name: "get_weather" } }] })), false, "mixing ANY client-side tool vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [...([SEARCH_TOOL] as unknown[]), { name: "compress", description: "c", input_schema: { type: "object", properties: {} } }] })), false, "leaked bili/compress tool vetoes");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [] })), false, "empty tools array");
    assert.equal(isServerToolUtilityCall(searchBody({ messages: [] })), false, "zero messages");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [null] })), false, "non-object tool entry");
    assert.equal(isServerToolUtilityCall({ input: [{ role: "user", content: "q" }], tools: [{ type: "web_search" }] }), false, "responses-wire input + unversioned type never match");
    assert.equal(isServerToolUtilityCall(searchBody({ tools: [{ type: "web_search", name: "web_search" }] })), false, "unversioned web_search type never matches");
});

test("isSideRequest: the structural shape outranks the #546 tools veto; explicit intent still outranks the structure", () => {
    const body = searchBody();
    assert.equal(isSideRequest(body), true, "server-tool-only utility call is a side request despite non-empty tools and a large budget");
    assert.equal(isSideRequest(body, "main"), false, "explicit main intent vetoes the structure");
    assert.equal(isSideRequest(body, "title"), true, "declared side agent stays side");
    // The old rules are untouched for everything the structure does not claim.
    assert.equal(isSideRequest({ max_tokens: 100 }), true, "tiny-budget heuristic intact");
    assert.equal(isSideRequest({ max_tokens: 100, tools: [{ name: "compress" }] }), false, "#546 veto intact for client tools");
    assert.equal(isSideRequest({ max_tokens: 1024, tools: [{ type: "bash_20250124", name: "bash" }] }), false, "client-executed versioned tools stay main");
});

test("resolveSideLane: the #2500 label names the structural shape in the log line", () => {
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined, sideLabel: "server-tool utility call (#2500)" }).reason,
        "server-tool utility call (#2500)",
    );
    // Without a label the historical reason strings are byte-stable.
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: "title" }).reason,
        "agent=title",
    );
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined }).reason,
        `max_tokens<=${SIDE_REQUEST_MAX_TOKENS}`,
    );
});

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function isWebSearchShape(b: Record<string, unknown>): boolean {
    return Array.isArray(b.messages) && b.messages.length === 1
        && Array.isArray(b.tools) && b.tools.length > 0
        && b.tools.every((t) => t !== null && typeof t === "object" && typeof (t as { type?: unknown }).type === "string" && /^web_(?:search|fetch)_\d{8}$/.test((t as { type: string }).type));
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** Last request body received by the upstream (for wire assertions). */
    lastBody: Record<string, unknown> | null;
    /** Total requests received by the upstream. */
    upstreamHits: number;
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null, upstreamHits: 0 };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            rig.lastBody = parsed;
            rig.upstreamHits++;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(isWebSearchShape(parsed) ? SEARCH_INPUT_TOKENS : MAIN_INPUT_TOKENS));
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
        proxy: "",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
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
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
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

test("e2e: WebSearch sub-request rides the side passthrough — no re-anchor, no injection, no high-water poison (#2500)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main turn 1: a normal turn whose REAL usage lands at 160K (high, below
        // the 200K window) → the nudge baseline the search sample would poison.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request must mutate kernel state");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main usage captured as the nudge baseline");
        assert.equal(s1.metadata.outputBudgetHighWater, 1024, "high-water learned from the healthy main turn");

        const stateAfterMain = JSON.stringify(s1.state);
        const statsAfterMain = JSON.stringify(s1.stats);
        const snapshotAfterMain = JSON.stringify(s1.lastMessages);
        const requestsAfterMain = s1.stats.requests;
        const nudgeRefAfterMain = s1.state.nudge.lastPerMessageNudgeTokens;

        // The WebSearch sub-request (captured CC 2.1.288 shape) on the SAME
        // session key: the upstream reports 85K input usage for it — far below
        // 160K − 50K margin, so pre-fix the #1595 re-anchor fires.
        const body = searchBody();
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r2.status, 200);
        await r2.text();

        // Verbatim forward: tools/system/messages/tool_choice/budget untouched —
        // nothing injected, budget not restored.
        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the search request");
        assert.deepEqual(fwd!.tools, body.tools, "tools forwarded verbatim (no bili tools injected)");
        assert.deepEqual(fwd!.messages, body.messages, "messages forwarded verbatim (no prompt/render tags injected)");
        assert.equal(fwd!.system, body.system, "system forwarded verbatim");
        assert.deepEqual(fwd!.tool_choice, body.tool_choice, "tool_choice forwarded verbatim");
        assert.equal(fwd!.max_tokens, 32_000, "utility-call budget must NOT be mutated by restoreOutputBudget");

        // Kernel state, stats, snapshot, counter and high-water all untouched.
        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the search request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain, "search request must NOT mutate kernel state (the #1595 re-anchor must not fire)");
        assert.equal(s2.state.nudge.lastPerMessageNudgeTokens, nudgeRefAfterMain, "nudge reference untouched by the search usage sample");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain, "search request must NOT mutate stats");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "the search's 85K usage must NOT replace the main 160K baseline");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain, "search request must NOT clobber the message snapshot");
        assert.equal(s2.stats.requests, requestsAfterMain, "search request must NOT increment the main request counter");
        assert.equal(s2.metadata.outputBudgetHighWater, 1024, "the search's 32K max_tokens must NOT seed the high-water");

        // Main turn 2: the pipeline still works after the search request.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = getSession(SESSION);
        assert.ok(s3.stats.requests > requestsAfterMain, "main turn 2 increments the request counter");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain, "main turn 2 advances kernel state");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: forced-search turn WITH conversation history stays a main turn — compression still injected (#2500 control)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `${SESSION}-control` };

        // Nine messages + ALL-server-tools + forced declared tool: the single-
        // message condition vetoes the structural identification, so this is a
        // genuine main turn that must ride the full pipeline.
        const body: Record<string, unknown> = { model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9), tools: [SEARCH_TOOL], tool_choice: { type: "tool", name: "web_search" } };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const s = getSession(`${SESSION}-control`);
        assert.ok(s, "session exists after the control request");
        assert.ok(s.stats.requests >= 1, "history-bearing forced-search request must go through the pipeline, not the side passthrough");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state must advance for the control request");
        assert.ok(JSON.stringify(rig.lastBody ?? {}).length > JSON.stringify(body).length + 1000, "proxy-mode injection (tools/prompt) still happens for real main turns");
    } finally {
        await closeRig(rig);
    }
});
