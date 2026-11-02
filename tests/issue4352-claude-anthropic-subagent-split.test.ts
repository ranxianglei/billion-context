import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, _sessionsSizeForTest, peekSession } from "../src/session.ts";
import { anthropicFirstUserFrag, claudeAnthropicPersonaOrderApplies } from "../src/session-id.ts";
import { mintClaudeLaneToken } from "../src/claude-lane-token.ts";
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
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const forkKey = (conv: string, systemText: string): string => `${conv}|sub:${fp16(systemText)}`;
// #5095 D1-B: three-segment derived-persona lane key — the per-run
// discriminator (the dispatch task prompt's first-user fragment) as its own
// fp16 segment.
const forkKey3 = (conv: string, systemText: string, firstUserFrag: string): string => `${conv}|sub:${fp16(systemText)}:${fp16(firstUserFrag)}`;

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

    // The claude-anthropic call site passes the request's first user fragment
    // as the per-run lane discriminator (#5095 D1-B) — mirror it here.
    const disc = (msgs: Msg[]) => anthropicFirstUserFrag(msgs);
    const ride = resolveSessionOrder(SESSION, history("sub", 2), SUB_TAG, undefined, undefined, disc(history("sub", 2)));
    assert.equal(ride.key, forkKey3(SESSION, SUB_TAG, "sub-user-1"), "history-disjoint ride forks onto its own lane, discriminated by the run's task prompt (#5095)");
    assert.equal(ride.action, "derived-persona");

    const ride2 = resolveSessionOrder(SESSION, history("sub", 3), SUB_TAG, undefined, undefined, disc(history("sub", 3)));
    assert.equal(ride2.key, ride.key, "successive turns of the SAME agent (first user unchanged) stay on ONE lane (ref continuity)");

    // #5095 acceptance row: a SECOND dispatched run of the same agent TYPE
    // shares the system byte-for-byte but carries a different task prompt —
    // it must mint its OWN lane instead of merging onto the twin's
    // compression state.
    const twin = resolveSessionOrder(SESSION, history("twin", 2), SUB_TAG, undefined, undefined, disc(history("twin", 2)));
    assert.equal(twin.key, forkKey3(SESSION, SUB_TAG, "twin-user-1"), "same-type twin run mints its own three-segment lane");
    assert.notEqual(twin.key, ride.key, "distinct runs of the same type NEVER share a lane (#5095)");

    const other = resolveSessionOrder(SESSION, history("other", 2), OTHER_TAG, undefined, undefined, disc(history("other", 2)));
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
    const ride = resolveSessionOrder(SESSION, history("sub", 2), SUB_TAG, undefined, undefined, anthropicFirstUserFrag(history("sub", 2)));
    assert.equal(ride.key, forkKey3(SESSION, SUB_TAG, "sub-user-1"), "a shared first system block does not block the fork (order+tag decide)");
    assert.equal(ride.action, "derived-persona");
    const back = resolveSessionOrder(SESSION, history("main", 5), PARENT_TAG);
    assert.equal(back.key, SESSION, "the parent returns to the raw key after the subagent burst");
});

test("#5095 degradation: absent/empty discriminator keeps today's two-segment lane key", () => {
    const SESSION = randomUUID();
    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), tag(MAIN_SYSTEM));
    // No user text on the wire → graceful fallback to the pre-#5095
    // two-segment key — persisted lanes of that shape stay valid.
    const bare = resolveSessionOrder(SESSION, history("bare", 2), tag(SUB_AGENT_SYSTEM));
    assert.equal(bare.key, forkKey(SESSION, tag(SUB_AGENT_SYSTEM)), "absent discriminator keeps the two-segment key");
    assert.equal(bare.action, "derived-persona");
    const emptyDisc = resolveSessionOrder(SESSION, history("bare2", 2), tag(SUB_AGENT_SYSTEM), undefined, undefined, "");
    assert.equal(emptyDisc.key, bare.key, "explicit empty discriminator degrades to the same two-segment key");
    resetSessionOrderForTest();
});

test("#5095 negative: discriminator-less callers (dsh/codex/opencode/google shapes) keep byte-identical keys", () => {
    const DSH_ID = randomUUID();
    resetSessionOrderForTest();
    resolveSessionOrder(DSH_ID, history("dshmain", 4), tag(MAIN_SYSTEM));
    const review = resolveSessionOrder(DSH_ID, history("dshreview", 2), tag(SUB_AGENT_SYSTEM));
    assert.equal(review.key, forkKey(DSH_ID, tag(SUB_AGENT_SYSTEM)), "no discriminator arg → exact today-shape key (zero behavior change for other hosts)");
    assert.equal(review.action, "derived-persona");
    const review2 = resolveSessionOrder(DSH_ID, history("dshreview-b", 2), tag(SUB_AGENT_SYSTEM), undefined, undefined, "");
    assert.equal(review2.key, review.key, "empty discriminator → identical bytes, same lane as today");
    resetSessionOrderForTest();
});

test("#5095 precedence: a valid lane token outranks a non-empty discriminator; an invalid one falls through", () => {
    const SESSION = randomUUID();
    resetSessionOrderForTest();
    resolveSessionOrder(SESSION, history("main", 4), tag(MAIN_SYSTEM));
    // #5095 D1-C wins over D1-B: when the SubagentStart token rides the wire,
    // the per-dispatch t:<token> lane is used regardless of the fragment.
    const tok = mintClaudeLaneToken();
    const res = resolveSessionOrder(SESSION, history("sub", 2), tag(SUB_AGENT_SYSTEM), undefined, tok, "task prompt fragment");
    assert.equal(res.key, `${SESSION}|sub:${fp16(tag(SUB_AGENT_SYSTEM))}:t:${tok}`, "valid token → per-dispatch lane");
    assert.equal(res.action, "derived-persona");
    // An INVALID token (forged / malformed) is ignored — the fragment
    // fallback still isolates the run on its own three-segment lane.
    const res2 = resolveSessionOrder(SESSION, history("other", 2), tag(SUB_AGENT_SYSTEM), undefined, "not-a-token!!", "another prompt");
    assert.equal(res2.key, forkKey3(SESSION, tag(SUB_AGENT_SYSTEM), "another prompt"), "invalid token → frag fallback");
    assert.notEqual(res2.key, res.key);
    resetSessionOrderForTest();
});

test("#5095 anthropicFirstUserFrag: first extractable user text, capped at 1KB, body-only", () => {
    assert.equal(anthropicFirstUserFrag([]), "");
    assert.equal(anthropicFirstUserFrag(undefined), "");
    assert.equal(anthropicFirstUserFrag([{ role: "assistant", content: "lead" }]), "", "no user message → empty (degrade to two-segment key)");
    assert.equal(anthropicFirstUserFrag([{ role: "user", content: "task prompt" }]), "task prompt", "string content");
    assert.equal(
        anthropicFirstUserFrag([{ role: "user", content: [{ type: "text", text: "part-a" }, { type: "text", text: "part-b" }] }]),
        "part-a\n\npart-b",
        "text parts join",
    );
    assert.equal(
        anthropicFirstUserFrag([
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "result" }] }] },
            { role: "user", content: "second" },
        ]),
        "second",
        "users with no top-level text are skipped",
    );
    assert.equal(anthropicFirstUserFrag([{ role: "user", content: "z".repeat(5_000) }]).length, 1024, "capped at 1KB");
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
        const subKey = forkKey3(SESSION, tag(SUB_AGENT_SYSTEM), "sub-user-1");
        const subSession = peekSession(subKey);
        assert.ok(subSession, "header-less subagent must fork onto its own |sub:<fp>:<userFp> lane");
        assert.equal(peekSession(forkKey(SESSION, tag(SUB_AGENT_SYSTEM))), undefined, "the pre-#5095 two-segment lane is no longer minted for header-less rides (migration disclosure)");
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

test("#5095: two same-type subagent runs get distinct sessions, neither accumulates on the other", async () => {
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
        // Two dispatched runs of the SAME agent type (byte-identical system)
        // with different task prompts — the #5095 repro shape.
        const runA = await post(ccHeaders, mainBody(history("taskA", 2), SUB_AGENT_SYSTEM));
        assert.equal(runA.status, 200, `run A: ${runA.text}`);
        const runB = await post(ccHeaders, mainBody(history("taskB", 2), SUB_AGENT_SYSTEM));
        assert.equal(runB.status, 200, `run B: ${runB.text}`);
        const keyA = forkKey3(SESSION, tag(SUB_AGENT_SYSTEM), "taskA-user-1");
        const keyB = forkKey3(SESSION, tag(SUB_AGENT_SYSTEM), "taskB-user-1");
        const sessA = peekSession(keyA);
        const sessB = peekSession(keyB);
        assert.ok(sessA && sessB, "each dispatched run mints its own three-segment lane");
        assert.notEqual(sessA, sessB, "same-type runs are DISTINCT session objects — own lock chain / compression state (#5095 acceptance 1)");
        assert.equal(sessA!.stats.requests, 1, "run A's lane holds exactly its own turn");
        assert.equal(sessB!.stats.requests, 1, "run B never accumulated on run A's lane (no cross-run fold state)");
        assert.equal(peekSession(SESSION)!.stats.requests, 3, "parent session untouched by the burst");
        // Same agent continues → its OWN lane keeps accumulating (acceptance 2).
        const a2 = await post(ccHeaders, mainBody(history("taskA", 3), SUB_AGENT_SYSTEM));
        assert.equal(a2.status, 200, `run A turn 2: ${a2.text}`);
        assert.equal(peekSession(keyA)!.stats.requests, 2, "successive turns stay on the run's own lane");
        assert.equal(peekSession(keyB)!.stats.requests, 1, "run B's lane still isolated after run A continues");
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
        assert.equal(peekSession(forkKey(SESSION, tag(SUB_AGENT_SYSTEM))), undefined, "with the split off, no two-segment fork lane is minted");
        assert.equal(peekSession(forkKey3(SESSION, tag(SUB_AGENT_SYSTEM), "sub-user-1")), undefined, "with the split off, no three-segment lane exists either (#5095 opt-out)");
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
