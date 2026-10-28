import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, _sessionsSizeForTest, peekSession } from "../src/session.ts";
import { claudeAnthropicPersonaOrderApplies } from "../src/session-id.ts";
import { resetSessionOrderForTest, resolveSessionOrder } from "../src/session-resolve.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #4352: claude code builds that stamp NO agent-id headers (VS Code extension
// subagents) ride the parent session id. Their traffic must fork onto its own
// |sub lane instead of destroying the parent's fold substrate.

// Every test mints its OWN session id: the order-resolver skeleton state is
// persisted per raw id (#3397) and re-hydrated on each server boot, so a fixed
// id shared across tests would let one test's system-drift anchor migration
// (#2241) leak into the next test's resolution.

// System-block shapes captured from live Claude Code traffic (same corpus as
// tests/claude-subagent-split.test.ts).
const MAIN_SYSTEM = ["You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent..."];
const SUB_AGENT_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "You are a file search specialist for..."];
const OTHER_SUB_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "This session is a background job. The..."];

const tag = (blocks: string[]): string => blocks.join("\n\n");
const forkKey = (conv: string, systemText: string): string =>
    `${conv}|sub:${createHash("sha256").update(systemText, "utf8").digest("hex").slice(0, 16)}`;

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
const sysBlocks = (system: string[]) => system.map((t) => ({ type: "text", text: t }));
const mainBody = (hist: Msg[], system: string[] = MAIN_SYSTEM): Record<string, unknown> =>
    ({ model: "claude-test", stream: true, max_tokens: 1024, system: sysBlocks(system), messages: hist });

test("claudeAnthropicPersonaOrderApplies: allowlist is the claude-code conversation source only", () => {
    const id = randomUUID();
    assert.equal(claudeAnthropicPersonaOrderApplies({ "x-claude-code-session-id": id }), true);
    assert.equal(claudeAnthropicPersonaOrderApplies({ "x-acp-session": id }), false, "plain anthropic clients keep verbatim identity (#1106)");
    assert.equal(claudeAnthropicPersonaOrderApplies({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": id }), false, "dsh keeps its own persona mechanism (#1916)");
    assert.equal(claudeAnthropicPersonaOrderApplies({}), false);
});

test("#4352 resolver rows: disjoint ride forks; continuing main and compaction keep the raw key", () => {
    const SESSION = randomUUID();
    const MAIN_TAG = tag(MAIN_SYSTEM);
    const SUB_TAG = tag(SUB_AGENT_SYSTEM);
    const OTHER_TAG = tag(OTHER_SUB_SYSTEM);

    resetSessionOrderForTest();
    const claim = resolveSessionOrder(SESSION, history("main", 4), MAIN_TAG);
    assert.equal(claim.key, SESSION, "first sight claims the raw id");
    assert.equal(claim.action, "claim");

    const ride = resolveSessionOrder(SESSION, history("sub", 2), SUB_TAG);
    assert.equal(ride.key, forkKey(SESSION, SUB_TAG), "history-disjoint ride under a different system forks onto its own lane");
    assert.equal(ride.action, "derived-persona");

    const ride2 = resolveSessionOrder(SESSION, history("sub", 3), SUB_TAG);
    assert.equal(ride2.key, forkKey(SESSION, SUB_TAG), "successive passes of the same persona stay on ONE lane (ref continuity)");

    const other = resolveSessionOrder(SESSION, history("other", 2), OTHER_TAG);
    assert.notEqual(other.key, ride.key, "a different subagent system gets its own lane");

    const drifted = resolveSessionOrder(SESSION, history("main", 5), MAIN_TAG + "\n[additional context loaded]");
    assert.equal(drifted.key, SESSION, "byte-drifted system on a verbatim-continuing history keeps the raw key (#1106)");
    assert.equal(drifted.action, "reanchor");

    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), MAIN_TAG);
    // Native /compact shape: the head collapses into a summary, the living tail
    // stays verbatim, same system — must stay on the raw key.
    const compacted = [
        { role: "user", content: "<compact summary of earlier turns>" },
        ...history("main", 4).slice(-4),
    ];
    const compactRes = resolveSessionOrder(SESSION, compacted, MAIN_TAG);
    assert.equal(compactRes.key, SESSION, "head-rewritten /compact replay keeps the raw key");
});

test("#4352 field shape: VS Code build shares the parent's first system block; the fork still fires", () => {
    // Live transcripts from Claude Code VS Code extension 2.1.307 (issue
    // comment): the parent and ALL subagents send the SAME first system block
    // verbatim — only the second block differs. The #975 main-prefix heuristic
    // therefore cannot separate these subagents (their first block starts with
    // "You are Claude Code"); separation must come from order+tag alone.
    const SESSION = randomUUID();
    const SHARED = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
    const PARENT_TAG = [SHARED, "You are an interactive agent... (parent-specific second block)"].join("\n\n");
    const SUB_TAG = [SHARED, "You are an agent for Claude Code, ... (subagent second block)"].join("\n\n");

    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), PARENT_TAG);
    const ride = resolveSessionOrder(SESSION, history("sub", 2), SUB_TAG);
    assert.equal(ride.key, forkKey(SESSION, SUB_TAG), "a shared first system block does not block the fork (order+tag decide)");
    assert.equal(ride.action, "derived-persona");
    const back = resolveSessionOrder(SESSION, history("main", 5), PARENT_TAG);
    assert.equal(back.key, SESSION, "the parent returns to the raw key after the subagent burst");
});

test("#4352 split: header-less subagent rides its own lane; the parent session is untouched", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        for (let t = 1; t <= 3; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const parentBefore = peekSession(SESSION);
        assert.ok(parentBefore, "parent session exists");
        assert.equal(parentBefore.stats.requests, 3);

        const sub1 = await post(ccHeaders, mainBody(history("sub", 2), SUB_AGENT_SYSTEM));
        assert.equal(sub1.status, 200, `subagent pass 1: ${sub1.text}`);
        const subKey = forkKey(SESSION, tag(SUB_AGENT_SYSTEM));
        const subSession = peekSession(subKey);
        assert.ok(subSession, "header-less subagent must fork onto its own |sub:<fp> lane");
        assert.notEqual(subSession, parentBefore, "forked lane is a separate session object (own lock chain / compression state)");
        assert.equal(peekSession(SESSION), parentBefore, "parent session object is the same instance");
        assert.equal(parentBefore.stats.requests, 3, "subagent turns must not accumulate on the parent");

        const sub2 = await post(ccHeaders, mainBody(history("sub", 3), SUB_AGENT_SYSTEM));
        assert.equal(sub2.status, 200, `subagent pass 2: ${sub2.text}`);
        assert.equal(peekSession(subKey)!.stats.requests, 2, "successive passes share ONE forked session");
        assert.equal(parentBefore.stats.requests, 3, "parent still untouched after pass 2");

        const main4 = await post(ccHeaders, mainBody(history("main", 4)));
        assert.equal(main4.status, 200, `parent turn 4: ${main4.text}`);
        assert.equal(parentBefore.stats.requests, 4, "the parent continues accumulating on the raw key after the burst");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#4352 negative: a main turn with a byte-drifted system keeps the raw key (#1106)", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        for (let t = 1; t <= 3; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const drifted = [...MAIN_SYSTEM, "[additional context loaded]"];
        const r = await post(ccHeaders, mainBody(history("main", 4), drifted));
        assert.equal(r.status, 200, `drifted-system continuation: ${r.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 4, "continuation must stay on the raw key");
        assert.equal(peekSession(forkKey(SESSION, tag(drifted))), undefined, "no |sub lane is minted for a continuing conversation");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#4352 negative: non-claude anthropic clients stay verbatim (#1106)", async () => {
    freshState();
    const OTHER_SESSION = randomUUID();
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        const headers = { "x-acp-session": OTHER_SESSION };
        // Two disjoint main-shaped conversations under the same id must behave
        // EXACTLY as before the fix: verbatim identity, one session.
        for (let t = 1; t <= 2; t++) {
            const r = await post(headers, mainBody(history("alpha", t)));
            assert.equal(r.status, 200, `alpha turn ${t}: ${r.text}`);
        }
        for (let t = 1; t <= 2; t++) {
            const r = await post(headers, mainBody(history("beta", t), OTHER_SUB_SYSTEM));
            assert.equal(r.status, 200, `beta turn ${t}: ${r.text}`);
        }
        assert.equal(peekSession(OTHER_SESSION)!.stats.requests, 4, "all four requests accumulate on the one verbatim session");
        assert.equal(peekSession(forkKey(OTHER_SESSION, tag(OTHER_SUB_SYSTEM))), undefined, "no fork lane is minted for non-claude clients");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#4352 opt-out: subagentSplit:false disables the header-less fallback too", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream, { subagentSplit: false });
    try {
        for (let t = 1; t <= 3; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const sub = await post(ccHeaders, mainBody(history("sub", 2), SUB_AGENT_SYSTEM));
        assert.equal(sub.status, 200, `subagent with split off: ${sub.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 4, "with the split off, the subagent rides the raw key (pre-fix behavior)");
        assert.equal(peekSession(forkKey(SESSION, tag(SUB_AGENT_SYSTEM))), undefined, "with the split off, no fork lane is minted");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#4352 exemptions: side calls and empty-system requests stay verbatim", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        for (let t = 1; t <= 2; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        // Tool-less request with a small output budget = the #388 side-request
        // shape: it rides the main session key verbatim by contract. Side calls
        // never increment stats.requests (the passthrough lane skips the
        // counter), so only the two parent turns + the empty-system request
        // count here.
        const side = await post(ccHeaders, { model: "claude-test", stream: true, max_tokens: 100, system: sysBlocks(MAIN_SYSTEM), messages: [{ role: "user", content: "summarize in one word" }] });
        assert.equal(side.status, 200, `side call: ${side.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 2, "side call rides the raw key but does not bump the request counter");
        // Empty system is non-anchoring (kernel anchor semantics): verbatim.
        const bare = await post(ccHeaders, { model: "claude-test", stream: true, max_tokens: 1024, messages: history("sub", 2) });
        assert.equal(bare.status, 200, `empty-system request: ${bare.text}`);
        assert.equal(peekSession(SESSION)!.stats.requests, 3, "both exempt shapes land on the raw key; side calls are uncounted");
        assert.equal(_sessionsSizeForTest(), 1, "no fork lane is minted for exempt shapes");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
