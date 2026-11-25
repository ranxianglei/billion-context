/**
 * #6884: the wire-client legs of the cross-agent session-identity audit
 * (discussions/6884; follow-on to #7077's pi purpose declaration).
 *
 * Source review of all five verbatim-roster clients (grok-shell, mcode,
 * goose, CodeBuddy, opencode) confirmed their session-id lifecycles are
 * HEALTHY — one id per logical conversation, forks/subagents mint fresh ids.
 * The exposure this file pins: each fires auxiliary LLM calls (titles,
 * compaction, suggestions, memory, naming) UNDER THE SAME id, and those
 * bodies defeat isSideRequest's heuristics (no tools + missing/small/large
 * budget), so pre-change they entered the main session's kernel pipeline as
 * conversation turns — one-shot pollution of the real conversation's
 * compression state.
 *
 * The clauses (src/server/handle.ts, gated on the client's own wire signal —
 * same trust tier as the roster in src/session-id.ts):
 *  - grok-shell: x-grok-session-id WITHOUT x-grok-turn-idx → side (main turns
 *    always stamp the turn index; grok's own test-support contract).
 *  - mcode: x-mavis-session-id + (single submit_session_title tool |
 *    tool-less budget-less single user with no history).
 *  - goose: agent-session-id + the dsh single-shot structural shape.
 *  - CodeBuddy: x-compaction present → side; x-context-compacted does NOT
 *    (it appears on ordinary post-compaction MAIN turns).
 *  - opencode: User-Agent "opencode/" + the pinned title template shape.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { isMcodeOneShotAuxRequest, isMcodeTitleRequest, isOpencodeTitleRequest, MCODE_TITLE_TOOL, OPENCODE_TITLE_FRAME_PREFIXES } from "../src/server/side-request.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue6884w-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

// The shape a wire-client auxiliary call that DEFEATS the heuristics has:
// no tools, an output budget ABOVE the <=200 side heuristic (so neither the
// budget rung nor the #546 tools rung can see it), a system carrier, one
// user message. Pre-change this entered the main kernel pipeline.
const AUX_LARGE_BUDGET_BODY = {
    model: "fake-a", max_completion_tokens: 8192, stream: false,
    messages: [
        { role: "system", content: "You are a compact summarizer." },
        { role: "user", content: "summarize the conversation so far into bullets" },
    ],
};

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context", "sessions"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "fake-a": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    // `extra` carries the client's own wire signal. Every request also
    // carries x-acp-session as a fallback id so the session exists even for
    // clients whose own header is absent (the control cases); the
    // client-specific roster headers outrank it in the resolution ladder.
    const send = async (conversationId: string, body: Record<string, unknown>, extra: Record<string, string> = {}) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, ...extra };
        return fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
    };
    const requests = (id: string) => resolveConversation(id).session?.stats.requests ?? 0;
    return { forwarded, send, requests, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("grok-shell: session id WITHOUT the turn index → side passthrough (kernel untouched)", async () => {
    const h = await harness();
    try {
        const r = await h.send("gk-aux", AUX_LARGE_BUDGET_BODY, { "x-grok-session-id": "gk-aux" });
        assert.equal(r.status, 200);
        assert.equal(h.requests("gk-aux"), 0, "auxiliary call (no turn-idx) must not run the full pipeline");
        assert.equal(h.forwarded.length, 1);
        assert.deepEqual(h.forwarded.at(-1), AUX_LARGE_BUDGET_BODY, "side passthrough forwards verbatim");
    } finally {
        await h.close();
    }
});

test("grok-shell: session id WITH the turn index → main pipeline (the foreground contract)", async () => {
    const h = await harness();
    try {
        const r = await h.send("gk-main", AUX_LARGE_BUDGET_BODY, { "x-grok-session-id": "gk-main", "x-grok-turn-idx": "3" });
        assert.equal(r.status, 200);
        assert.equal(h.requests("gk-main"), 1, "a turn-stamped request is a foreground main turn even in aux-ish shape");
    } finally {
        await h.close();
    }
});

test("grok-shell: without its session header the shape falls back to the heuristics (gate is the header, not the body)", async () => {
    const h = await harness();
    try {
        const r = await h.send("gk-plain", AUX_LARGE_BUDGET_BODY);
        assert.equal(r.status, 200);
        assert.equal(h.requests("gk-plain"), 1, "no grok header → no clause → legacy main-lane classification");
    } finally {
        await h.close();
    }
});

test("mcode: title sidecar (single submit_session_title tool) → side", async () => {
    const h = await harness();
    try {
        const body = {
            model: "fake-a", max_completion_tokens: 1000, stream: false,
            tools: [{ type: "function", function: { name: "submit_session_title", description: "Submit the session title.", parameters: { type: "object", properties: { title: { type: "string" } } } } }],
            messages: [{ role: "user", content: "Generate a concise title for: fix the flaky test in the parser" }],
        };
        const r = await h.send("mc-title", body, { "x-mavis-session-id": "mc-title" });
        assert.equal(r.status, 200);
        assert.equal(h.requests("mc-title"), 0, "the title call must not run the full pipeline");
    } finally {
        await h.close();
    }
});

test("mcode: prompt-suggestion one-shot (no tools, no budget, single user) → side", async () => {
    const h = await harness();
    try {
        const body = { model: "fake-a", stream: false, messages: [{ role: "user", content: "Suggest a concise follow-up question to the user. Reply with only the question." }] };
        const r = await h.send("mc-sugg", body, { "x-mavis-session-id": "mc-sugg" });
        assert.equal(r.status, 200);
        assert.equal(h.requests("mc-sugg"), 0, "budget-less single user defeats the legacy heuristics — the clause must catch it");
    } finally {
        await h.close();
    }
});

test("mcode: without its session header the same bodies stay heuristic-classified (control)", async () => {
    const h = await harness();
    try {
        const suggestion = { model: "fake-a", stream: false, messages: [{ role: "user", content: "Suggest a concise follow-up question to the user." }] };
        const r1 = await h.send("mc-plain-sugg", suggestion);
        assert.equal(r1.status, 200);
        assert.equal(h.requests("mc-plain-sugg"), 1, "no mcode header → legacy main-lane classification (budget-less is never a side req)");
        const title = {
            model: "fake-a", max_completion_tokens: 1000, stream: false,
            tools: [{ type: "function", function: { name: "submit_session_title", description: "Submit the session title.", parameters: { type: "object" } } }],
            messages: [{ role: "user", content: "Generate a concise title for: hello" }],
        };
        const r2 = await h.send("mc-plain-title", title);
        assert.equal(r2.status, 200);
        assert.equal(h.requests("mc-plain-title"), 1, "the tool surface is a main-turn marker (#546) without the mcode gate");
    } finally {
        await h.close();
    }
});

test("goose: single-shot aux shape under agent-session-id → side; the same shape without the header → main", async () => {
    const h = await harness();
    try {
        const body = { model: "fake-a", stream: false, messages: [{ role: "system", content: "You name conversations. Reply with a short title." }, { role: "user", content: "debug the wifi reconnect loop" }] };
        const r1 = await h.send("gs-naming", body, { "agent-session-id": "gs-naming" });
        assert.equal(r1.status, 200);
        assert.equal(h.requests("gs-naming"), 0, "the goose naming call (no tools, no budget, single user) must not run the full pipeline");
        const r2 = await h.send("gs-plain", body);
        assert.equal(r2.status, 200);
        assert.equal(h.requests("gs-plain"), 1, "without the goose lane header the shape keeps the legacy classification");
    } finally {
        await h.close();
    }
});

test("goose: a tool-carrying main turn keeps the full pipeline even under agent-session-id", async () => {
    const h = await harness();
    try {
        const body = {
            model: "fake-a", max_completion_tokens: 8192, stream: false,
            tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
            messages: [{ role: "system", content: "You are Goose." }, { role: "user", content: "read the manifest" }],
        };
        const r = await h.send("gs-main", body, { "agent-session-id": "gs-main" });
        assert.equal(r.status, 200);
        assert.equal(h.requests("gs-main"), 1, "no-tools veto: any action surface marks a main turn (#546)");
    } finally {
        await h.close();
    }
});

test("CodeBuddy: x-compaction → side; x-context-compacted does NOT demote (post-compaction main turns keep the pipeline)", async () => {
    const h = await harness();
    try {
        // The compaction request itself: large budget, no tools — heuristic-
        // invisible; the wire header is the identity.
        const r1 = await h.send("cb-compact", AUX_LARGE_BUDGET_BODY, { "x-conversation-id": "cb-compact", "x-compaction": "summary" });
        assert.equal(r1.status, 200);
        assert.equal(h.requests("cb-compact"), 0, "the compaction generation request must ride the side passthrough");
        // A post-compaction ordinary main turn carries x-context-compacted —
        // consuming it would demote the real mainline (the deliberate veto).
        const mainTurn = { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "user", content: "keep going with the refactoring" }, { role: "assistant", content: "done" }, { role: "user", content: "and now the tests" }] };
        const r2 = await h.send("cb-main", mainTurn, { "x-conversation-id": "cb-main", "x-context-compacted": "1" });
        assert.equal(r2.status, 200);
        assert.equal(h.requests("cb-main"), 1, "x-context-compacted alone must never demote a main turn");
    } finally {
        await h.close();
    }
});

test("opencode: title-gen shape under the opencode UA → side; other UAs keep the legacy classification", async () => {
    const h = await harness();
    try {
        const body = { model: "fake-a", stream: false, messages: [{ role: "system", content: "You name conversations. Be concise." }, { role: "user", content: OPENCODE_TITLE_FRAME_PREFIXES[0] + "\n\n<message>\nfix the flaky test\n</message>\n\nReply with only the title." }] };
        const r1 = await h.send("oc-title", body, { "user-agent": "opencode/dev/2.3.0/opencode", "x-opencode-session-id": "oc-title" });
        assert.equal(r1.status, 200);
        assert.equal(h.requests("oc-title"), 0, "the pure-proxy title-gen (no tools, no budget) must not enter the main pipeline");
        // Regeneration variant.
        const regen = { ...body, messages: [{ role: "system", content: "You name conversations." }, { role: "user", content: OPENCODE_TITLE_FRAME_PREFIXES[1] + "\n\n<conversation>…</conversation>\n\nReply with only the title." }] };
        const r2 = await h.send("oc-regen", regen, { "user-agent": "opencode/dev/2.3.0/opencode", "x-opencode-session-id": "oc-regen" });
        assert.equal(r2.status, 200);
        assert.equal(h.requests("oc-regen"), 0, "the regeneration frame is pinned too");
        // Same bytes, non-opencode UA: the lane evidence is absent → legacy.
        const r3 = await h.send("oc-plain", body, { "user-agent": "curl/8.5.0" });
        assert.equal(r3.status, 200);
        assert.equal(h.requests("oc-plain"), 1, "without the opencode UA the shape keeps the legacy classification");
    } finally {
        await h.close();
    }
});

test("isMcodeTitleRequest: exact one-tool shape only (pure predicate pins)", () => {
    const tool = { type: "function", function: { name: MCODE_TITLE_TOOL } };
    assert.equal(isMcodeTitleRequest({ tools: [tool] }), true, "openai function form");
    assert.equal(isMcodeTitleRequest({ tools: [{ name: MCODE_TITLE_TOOL }] }), true, "flat name form");
    assert.equal(isMcodeTitleRequest({ tools: [tool, { type: "function", function: { name: "bash" } }] }), false, "main turn: other tools beside the title tool");
    assert.equal(isMcodeTitleRequest({ tools: [{ type: "function", function: { name: "bash" } }] }), false, "different single tool");
    assert.equal(isMcodeTitleRequest({}), false, "no tools");
    assert.equal(isMcodeTitleRequest(null), false, "null body");
});

test("isMcodeOneShotAuxRequest: single user, no history, no tools (pure predicate pins)", () => {
    assert.equal(isMcodeOneShotAuxRequest("openai", { messages: [{ role: "user", content: "suggest a follow-up" }] }), true, "budget-less single user");
    assert.equal(isMcodeOneShotAuxRequest("openai", { messages: [{ role: "system", content: "sys" }, { role: "user", content: "one" }, { role: "assistant", content: "two" }] }), false, "assistant history vetoes");
    assert.equal(isMcodeOneShotAuxRequest("openai", { messages: [{ role: "user", content: "one" }, { role: "tool", content: "result", tool_call_id: "c1" }] }), false, "tool result vetoes");
    assert.equal(isMcodeOneShotAuxRequest("openai", { tools: [{ type: "function", function: { name: "bash" } }], messages: [{ role: "user", content: "one" }] }), false, "tools veto (#546)");
    assert.equal(isMcodeOneShotAuxRequest("openai", { messages: [{ role: "user", content: "" }] }), false, "empty user is not a one-shot call");
    assert.equal(isMcodeOneShotAuxRequest(null, { messages: [{ role: "user", content: "one" }] }), false, "protocol null");
});

test("isOpencodeTitleRequest: both frames, budget-less, one entry (pure predicate pins)", () => {
    for (const prefix of OPENCODE_TITLE_FRAME_PREFIXES) {
        assert.equal(isOpencodeTitleRequest("openai", { messages: [{ role: "user", content: prefix + "\n\n<message>x</message>" }] }), true, `frame ${JSON.stringify(prefix)}`);
    }
    assert.equal(isOpencodeTitleRequest("openai", { max_tokens: 512, messages: [{ role: "user", content: OPENCODE_TITLE_FRAME_PREFIXES[0] }] }), false, "a budget is not the title agent's wire form");
    assert.equal(isOpencodeTitleRequest("openai", { tools: [{ type: "function", function: { name: "bash" } }], messages: [{ role: "user", content: OPENCODE_TITLE_FRAME_PREFIXES[0] }] }), false, "tools veto");
    assert.equal(isOpencodeTitleRequest("openai", { messages: [{ role: "user", content: OPENCODE_TITLE_FRAME_PREFIXES[0] }, { role: "assistant", content: "t" }] }), false, "history vetoes");
    assert.equal(isOpencodeTitleRequest("openai", { messages: [{ role: "user", content: "Here is a message about conversations: x" }] }), false, "near-miss text");
});
