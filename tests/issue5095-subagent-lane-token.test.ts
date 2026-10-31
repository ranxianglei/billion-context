import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { claudeSubagentLaneTokenOf } from "../src/session-id.ts";
import { resetSessionOrderForTest, resolveSessionOrder } from "../src/session-resolve.ts";
import { isClaudeLaneToken, mintClaudeLaneToken, claudeLaneTokenIn, LANE_TOKEN_MARKER } from "../src/claude-lane-token.ts";
import { subagentStartHookOutput } from "../src/claude-subagent-hook.ts";
import { applyClaudeManagedBlock, stripClaudeManagedBlock } from "../src/plugin-install.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #5095 (D1-C): the SubagentStart lane token. Claude Code builds that stamp
// no agent-id headers (#4352) fork onto a `|sub:<fp16(tag)>` lane keyed by
// the persona text alone — and PARALLEL dispatches of the SAME subagent type
// (identical system text → identical fingerprint) merge onto ONE lane. The
// bili-managed SubagentStart hook mints a per-dispatch token that rides the
// dispatch's first user message; the resolver keys on it deterministically.
// Gate discipline (#3617): every row below has its negative — token absent
// keeps resolution byte-identical to #4352 behavior.

const MAIN_SYSTEM = ["You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent..."];
const SUB_AGENT_SYSTEM = ["x-anthropic-billing-header: cc_version=...", "You are a Claude agent, built on Anthropic's...", "You are a file search specialist for..."];

const tag = (blocks: string[]): string => blocks.join("\n\n");
const fp16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const forkKey = (conv: string, systemText: string): string => `${conv}|sub:${fp16(systemText)}`;
const tokenLaneKey = (conv: string, systemText: string, token: string): string => `${forkKey(conv, systemText)}:t:${token}`;

type Msg = { role: string; content: unknown };

function history(prefix: string, turns: number): Msg[] {
    const out: Msg[] = [];
    for (let i = 1; i <= turns; i++) {
        out.push({ role: "user", content: `${prefix}-user-${i}` });
        out.push({ role: "assistant", content: `${prefix}-assistant-${i}` });
    }
    return out;
}

test("#5095 grammar: mint / validate / extract", () => {
    const a = mintClaudeLaneToken();
    const b = mintClaudeLaneToken();
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.notEqual(a, b, "tokens are minted per dispatch — collisions must not happen");
    assert.equal(isClaudeLaneToken(a), true);
    assert.equal(isClaudeLaneToken("ABCDEF123456"), false, "uppercase is not our grammar");
    assert.equal(isClaudeLaneToken("abc123"), false, "too short");
    assert.equal(isClaudeLaneToken("abc123abc1234"), false, "too long");
    assert.equal(isClaudeLaneToken(undefined), false);
    assert.equal(claudeLaneTokenIn(`context\n${LANE_TOKEN_MARKER}${a}\nmore`), a);
    assert.equal(claudeLaneTokenIn(`${LANE_TOKEN_MARKER}${a}ff`), undefined, "a longer hex run is not our token (boundary guard)");
    assert.equal(claudeLaneTokenIn(`ff${LANE_TOKEN_MARKER}${a}`), undefined, "hex touching the marker is rejected on both sides (strict grammar)");
    assert.equal(claudeLaneTokenIn("no marker here"), undefined);
});

test("#5095 extractor: only the FIRST user message is scanned", () => {
    const tok = mintClaudeLaneToken();
    const marker = `${LANE_TOKEN_MARKER}${tok}`;
    // string content
    assert.equal(claudeSubagentLaneTokenOf([{ role: "user", content: `hello ${marker}` }]), tok);
    // block-array content, token inside a system-reminder wrapper (hook shape)
    assert.equal(
        claudeSubagentLaneTokenOf([{ role: "user", content: [{ type: "text", text: `<system-reminder>${marker}</system-reminder>` }, { type: "text", text: "find the bug" }] }]),
        tok,
    );
    // a leading assistant message is skipped, the first user message still scanned
    assert.equal(claudeSubagentLaneTokenOf([{ role: "assistant", content: "hi" }, { role: "user", content: marker }]), tok);
    // NEGATIVE: the marker pasted by the user into a LATER message must never fork the main
    assert.equal(claudeSubagentLaneTokenOf([{ role: "user", content: "first turn" }, { role: "assistant", content: "reply" }, { role: "user", content: marker }]), undefined);
    // NEGATIVE: first user message clean, marker later only
    assert.equal(claudeSubagentLaneTokenOf([{ role: "user", content: "clean" }, { role: "user", content: marker }]), undefined);
    // non-text blocks are not scanned
    assert.equal(claudeSubagentLaneTokenOf([{ role: "user", content: [{ type: "image", source: marker }] }]), undefined);
    // degenerate shapes
    assert.equal(claudeSubagentLaneTokenOf(undefined), undefined);
    assert.equal(claudeSubagentLaneTokenOf([]), undefined);
    assert.equal(claudeSubagentLaneTokenOf([{ role: "user", content: null }]), undefined);
});

test("#5095 hook output: one token per invocation, valid JSON contract", () => {
    const out = subagentStartHookOutput();
    const tok = claudeLaneTokenIn(out.hookSpecificOutput.additionalContext);
    assert.ok(tok !== undefined, "additionalContext carries the marker token");
    assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.equal(typeof JSON.stringify(out), "string", "stdout payload serializes");
    const tok2 = claudeLaneTokenIn(subagentStartHookOutput().hookSpecificOutput.additionalContext);
    assert.notEqual(tok, tok2, "each dispatch launch mints a fresh token");
});

test("#5095 resolver rows: token keys the dispatch deterministically", () => {
    const SESSION = randomUUID();
    const MAIN_TAG = tag(MAIN_SYSTEM);
    const SUB_TAG = tag(SUB_AGENT_SYSTEM);
    const tokA = mintClaudeLaneToken();
    const tokB = mintClaudeLaneToken();

    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), MAIN_TAG);

    // Positive: a token'd dispatch never touches the raw key — regardless of
    // the persona text, even the SAME text as the main conversation.
    const a1 = resolveSessionOrder(SESSION, history("subA", 2), SUB_TAG, undefined, tokA);
    assert.equal(a1.key, tokenLaneKey(SESSION, SUB_TAG, tokA));
    assert.equal(a1.action, "derived-persona");
    // successive passes of the SAME dispatch (grown history, same token) keep the lane
    const a2 = resolveSessionOrder(SESSION, history("subA", 3), SUB_TAG, undefined, tokA);
    assert.equal(a2.key, tokenLaneKey(SESSION, SUB_TAG, tokA));
    // THE #5095 D1 GAP, FIXED: a parallel dispatch of the SAME type (same
    // system text → same fingerprint) gets its OWN lane.
    const b1 = resolveSessionOrder(SESSION, history("subB", 2), SUB_TAG, undefined, tokB);
    assert.equal(b1.key, tokenLaneKey(SESSION, SUB_TAG, tokB));
    assert.notEqual(b1.key, a1.key, "parallel same-persona dispatches must not merge");
    // token'd traffic under the MAIN persona also forks (token outranks tag)
    const c1 = resolveSessionOrder(SESSION, history("subC", 2), MAIN_TAG, undefined, tokA);
    assert.equal(c1.key, tokenLaneKey(SESSION, MAIN_TAG, tokA));
    // the parent keeps the raw key after the burst
    const main5 = resolveSessionOrder(SESSION, history("main", 5), MAIN_TAG);
    assert.equal(main5.key, SESSION);

    // NEGATIVE (control — the documented D1 gap without the token): both
    // same-type dispatches merge onto ONE fingerprint lane, pre-fix shape.
    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), MAIN_TAG);
    const x1 = resolveSessionOrder(SESSION, history("subA", 2), SUB_TAG);
    const x2 = resolveSessionOrder(SESSION, history("subB", 2), SUB_TAG);
    assert.equal(x1.key, forkKey(SESSION, SUB_TAG));
    assert.equal(x2.key, forkKey(SESSION, SUB_TAG), "without tokens the fingerprint lane merges parallel dispatches (#5095 D1)");

    // NEGATIVE: a malformed token is ignored → current behavior
    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), MAIN_TAG);
    const forged = resolveSessionOrder(SESSION, history("subA", 2), SUB_TAG, undefined, "zzz-not-hex!!");
    assert.equal(forged.key, forkKey(SESSION, SUB_TAG), "non-hex token falls back to the fingerprint lane (sanitizer)");

    // virgin id: token'd traffic claims ONLY its lane, the raw id stays free
    // for the main conversation (kills the #2156-style claim race).
    resetSessionOrderForTest();
    const virgin = randomUUID();
    const first = resolveSessionOrder(virgin, history("subA", 2), SUB_TAG, undefined, tokA);
    assert.equal(first.key, tokenLaneKey(virgin, SUB_TAG, tokA));
    const claim = resolveSessionOrder(virgin, history("main", 4), MAIN_TAG);
    assert.equal(claim.key, virgin, "the main conversation still claims the virgin raw id afterwards");
});

test("#5095 install: managed settings carry the SubagentStart hook; user entries survive", () => {
    const settings = { env: {}, hooks: { SubagentStart: [{ hooks: [{ type: "command", command: "node ~/.claude/hooks/my-own-hook.js" }] }] } };
    const ours = portable("subagent");
    const { data, notes } = applyClaudeManagedBlock(structuredClone(settings), { baseUrl: "http://127.0.0.1:18787/bili", hookCommand: portable("bootstrap"), subagentHookCommand: ours });
    const subagentStart = (data.hooks as { SubagentStart: { hooks: { command: string }[] }[] }).SubagentStart;
    assert.equal(subagentStart.length, 2, "user entry + our entry");
    assert.equal(subagentStart[0].hooks[0].command, "node ~/.claude/hooks/my-own-hook.js", "the user's own hook stays first");
    assert.ok(notes.some((n) => n.includes("SubagentStart")), `install notes mention the hook: ${notes.join("; ")}`);
    // idempotent: a second apply neither duplicates nor "refreshes"
    const again = applyClaudeManagedBlock(data, { baseUrl: "http://127.0.0.1:18787/bili", hookCommand: portable("bootstrap"), subagentHookCommand: ours });
    const list2 = (again.data.hooks as { SubagentStart: unknown[] }).SubagentStart;
    assert.equal(list2.length, 2, "no duplicate on re-apply");
    assert.ok(!again.notes.some((n) => n.includes("SubagentStart")), `no churn note on re-apply: ${again.notes.join("; ")}`);
    // refresh: a stale command from an older release is rewritten in place
    const stale = structuredClone(data);
    const oursEntry = (stale.hooks as { SubagentStart: { hooks: { command: string }[] }[] }).SubagentStart[1];
    oursEntry.hooks[0].command = portable("claude-subagent-hook.js.old-dist-path");
    const refreshed = applyClaudeManagedBlock(stale, { baseUrl: "http://127.0.0.1:18787/bili", hookCommand: portable("bootstrap"), subagentHookCommand: ours });
    const list3 = (refreshed.data.hooks as { SubagentStart: { hooks: { command: string }[] }[] }).SubagentStart;
    assert.equal(list3.length, 2);
    assert.equal(list3[1].hooks[0].command, ours, "stale command refreshed");
    // NEGATIVE: callers that pass no subagentHookCommand (old shape) write no SubagentStart entry
    const bare = applyClaudeManagedBlock({ env: {} }, { baseUrl: "http://127.0.0.1:18787/bili", hookCommand: portable("bootstrap") });
    assert.equal((bare.data.hooks as { SubagentStart?: unknown[] } | undefined)?.SubagentStart, undefined, "no SubagentStart without the opt-in");
    // removal is symmetric: strip takes ours, keeps the user's
    const stripped = stripClaudeManagedBlock(data);
    const kept = (stripped.data.hooks as { SubagentStart: { hooks: { command: string }[] }[] }).SubagentStart;
    assert.equal(kept.length, 1, "our entry leaves with the managed block");
    assert.equal(kept[0].hooks[0].command, "node ~/.claude/hooks/my-own-hook.js", "the user's own hook survives removal");
});

function portable(name: string): string {
    return `node /opt/bili/dist/${name === "bootstrap" ? "claude-native-bootstrap" : "claude-subagent-hook"}.js`;
}

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

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

/** A subagent history whose FIRST user message carries the hook-injected token. */
function tokenedHistory(prefix: string, turns: number, token: string): Msg[] {
    const base = history(prefix, turns);
    const first = base[0];
    return [{ role: "user", content: [{ type: "text", text: `<system-reminder>${LANE_TOKEN_MARKER}${token}</system-reminder>` }, { type: "text", text: String(first.content) }] }, ...base.slice(1)];
}

test("#5095 end to end: parallel same-type dispatches ride distinct lanes; parent untouched; no-token control unchanged", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const tokA = mintClaudeLaneToken();
    const tokB = mintClaudeLaneToken();
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        for (let t = 1; t <= 3; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const parent = peekSession(SESSION);
        assert.ok(parent, "parent session exists");
        assert.equal(parent.stats.requests, 3);

        const laneA = tokenLaneKey(SESSION, tag(SUB_AGENT_SYSTEM), tokA);
        const laneB = tokenLaneKey(SESSION, tag(SUB_AGENT_SYSTEM), tokB);

        const a1 = await post(ccHeaders, mainBody(tokenedHistory("subA", 2, tokA), SUB_AGENT_SYSTEM));
        assert.equal(a1.status, 200, `dispatch A pass 1: ${a1.text}`);
        assert.ok(peekSession(laneA), "dispatch A rides its token lane");
        assert.equal(peekSession(laneA)!.stats.requests, 1);
        const a2 = await post(ccHeaders, mainBody(tokenedHistory("subA", 3, tokA), SUB_AGENT_SYSTEM));
        assert.equal(a2.status, 200, `dispatch A pass 2: ${a2.text}`);
        assert.equal(peekSession(laneA)!.stats.requests, 2, "same token → same lane across passes");

        const b1 = await post(ccHeaders, mainBody(tokenedHistory("subB", 2, tokB), SUB_AGENT_SYSTEM));
        assert.equal(b1.status, 200, `dispatch B pass 1: ${b1.text}`);
        assert.ok(peekSession(laneB), "dispatch B rides its OWN token lane");
        assert.notEqual(laneA, laneB, "same system text, different tokens — the #5095 D1 merge is gone");
        assert.notEqual(peekSession(laneA), peekSession(laneB), "distinct session objects (own compression state)");
        assert.equal(peekSession(forkKey(SESSION, tag(SUB_AGENT_SYSTEM))), undefined, "no shared fingerprint lane was minted");
        assert.equal(peekSession(SESSION), parent, "parent session object unchanged");
        assert.equal(parent.stats.requests, 3, "parent untouched by both dispatches");

        const main4 = await post(ccHeaders, mainBody(history("main", 4)));
        assert.equal(main4.status, 200, `parent turn 4: ${main4.text}`);
        assert.equal(parent.stats.requests, 4, "parent continues on the raw key after the burst");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("#5095 end to end negative: un-upgraded clients (no token) keep the #4352 behavior", async () => {
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
        const sub1 = await post(ccHeaders, mainBody(history("sub", 2), SUB_AGENT_SYSTEM));
        assert.equal(sub1.status, 200, `token-less subagent: ${sub1.text}`);
        const subKey = forkKey(SESSION, tag(SUB_AGENT_SYSTEM));
        assert.ok(peekSession(subKey), "token-less dispatch still forks by fingerprint (#4352)");
        const sub2 = await post(ccHeaders, mainBody(history("sub", 3), SUB_AGENT_SYSTEM));
        assert.equal(sub2.status, 200, `token-less pass 2: ${sub2.text}`);
        assert.equal(peekSession(subKey)!.stats.requests, 2, "and still merges on the fingerprint lane (documented gap, unchanged)");
        assert.equal(peekSession(SESSION)!.stats.requests, 3, "parent untouched either way");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
