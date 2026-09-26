// #1336 CCR v3: plan-aware search re-ranking (deterministic tier), steering
// output, retrieve-quality stats, plus an anthropic-wire run proving the
// steering section rides the search tool result with client cache_control
// breakpoints kept stable (mirrors the CCR v2 e2e coverage discipline).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { recordRetrieveHit, storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import {
    effectiveSearchPlanAware,
    executeSearchContext,
    executeSearchContextTarget,
    extractPlanState,
    resolveDecompress,
    storeEffectiveSearchPlanAware,
} from "../src/decompress-shared.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

function makeMsgs(n: number): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `h_${i}`,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        contentType: "text" as const,
        text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
    }));
}

// Six blocks whose topics all match the query "token" lexically; only the
// "token ratelimit" summary overlaps the plan state below, so plan-aware
// scoring must — and lexical scoring must not — lift it above the rest.
const BLOCKS: Array<[string, string]> = [
    ["token auth history", "Auth token issuance, token validation, token expiry and token rotation for the login flow."],
    ["token storage", "Session token storage layout and token cache eviction policy."],
    ["token validation", "Token validation middleware and expired token handling."],
    ["token refresh", "Token refresh flow and renewal token rotation for expired access tokens."],
    ["token ratelimit", "Rate limiting on token endpoints: ratelimit middleware for token issuance."],
    ["token metrics", "Token usage metrics collection and dashboard wiring for the gateway."],
];

type Folded = { core: ReturnType<typeof createCore>; config: Config; session: ReturnType<typeof getSession>; msgs: CoreMessage[] };

function foldBlocks(ccr: boolean): Folded {
    const core = createCore();
    const config = applyCompressSettings(defaultConfig(200_000), 200_000, { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: ccr, minToolTokens: 50 } }) as Config;
    const session = getSession(`sp-${Math.random().toString(36).slice(2)}`);
    if (ccr) storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const turn = core.processTurn({ messages: makeMsgs(40), state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({
        content: BLOCKS.map((t, i) => ({ startId: `m${pad(i * 5 + 1)}`, endId: `m${pad(i * 5 + 5)}`, summary: t[1], topic: t[0] })),
    }), ctx);
    assert.equal(session.state.blocks.filter((b) => b.active).length, 6, "six blocks created");
    return { core, config, session, msgs: turn.messages };
}

function blockByTopic(f: Folded, topic: string): { blockId: string } {
    const b = f.session.state.blocks.find((x) => x.active && x.topic === topic);
    assert.ok(b, `block "${topic}" exists`);
    return b as unknown as { blockId: string };
}

function ctxOf(f: Folded) {
    return { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
}

function planMessages(): CoreMessage[] {
    return [
        { id: "u_plan", role: "user", contentType: "text", text: "add ratelimit middleware to the token flow" },
        { id: "t_plan", role: "assistant", contentType: "tool-call", toolName: "TodoWrite", text: JSON.stringify({ todos: [{ content: "implement ratelimit middleware", status: "in_progress" }, { content: "wire token endpoint", status: "pending" }] }) },
    ];
}

function planOpts(f: Folded, logs: string[]) {
    return { messages: planMessages(), session: f.session, log: (msg: string) => logs.push(msg), protectedPatterns: f.config.protectedLatestTools };
}

test("extractPlanState: latest snapshot wins per pattern; user turn included", () => {
    const msgs: CoreMessage[] = [
        { id: "a", role: "assistant", contentType: "tool-call", toolName: "TodoWrite", text: JSON.stringify({ todos: [{ content: "zebra stripes migration" }] }) },
        { id: "b", role: "assistant", contentType: "tool-call", toolName: "TodoWrite", text: JSON.stringify({ todos: [{ content: "giraffe feed rollout" }] }) },
        { id: "c", role: "user", contentType: "text", text: "ship the giraffe feed today" },
    ];
    const st = extractPlanState(msgs);
    assert.ok(st, "plan state extracted");
    assert.ok(st!.terms.has("giraffe"), "newer snapshot terms present");
    assert.ok(!st!.terms.has("zebra"), "older snapshot superseded");
});

test("extractPlanState: honors extraPatterns; null when nothing usable is in context", () => {
    const custom: CoreMessage[] = [{ id: "p", role: "assistant", contentType: "tool-call", toolName: "MyPlanTool", text: "blueprint for the bridge" }];
    assert.equal(extractPlanState(custom), null, "unknown planning tool ignored without a pattern");
    assert.ok(extractPlanState(custom, ["MyPlanTool"]), "extra pattern honored");
    const noise: CoreMessage[] = [
        { id: "n1", role: "assistant", contentType: "text", text: "just prose, no plan" },
        { id: "n2", role: "user", contentType: "tool-result", toolName: "Bash", text: "tool output only" },
    ];
    assert.equal(extractPlanState(noise), null, "no planning tool and no user text → null");
});

test("extractPlanState: bounded to the last 40 messages", () => {
    const msgs: CoreMessage[] = [{ id: "old", role: "assistant", contentType: "tool-call", toolName: "TodoWrite", text: "ancient kubernetes upgrade plan" }];
    for (let i = 0; i < 48; i++) msgs.push({ id: `f${i}`, role: "assistant", contentType: "text", text: `filler ${i}` });
    msgs.push({ id: "now", role: "user", contentType: "text", text: "start the kubernetes upgrade" });
    const st = extractPlanState(msgs);
    assert.ok(st, "recent user turn still yields plan state");
    assert.ok(!st!.terms.has("ancient"), "snapshot outside the window ignored");
    assert.ok(st!.terms.has("kubernetes"), "in-window user turn term present");
});

test("byte-identical output when plan state is absent or the pool fits the limit", () => {
    const f = foldBlocks(true);
    const base = executeSearchContext({ query: "token" }, f.core, f.session.state);
    const emptyPlan = executeSearchContext({ query: "token" }, f.core, f.session.state, undefined, { messages: [], session: f.session, log: () => {} });
    assert.equal(emptyPlan, base, "no plan state in context → identical output");
    const wide = executeSearchContext({ query: "token", limit: 100 }, f.core, f.session.state);
    const widePlan = executeSearchContext({ query: "token", limit: 100 }, f.core, f.session.state, undefined, planOpts(f, []));
    assert.equal(widePlan, wide, "pool fits the limit → identical output even with plan state");
});

test("plan-aware re-ranking lifts the plan-relevant block to the top (deterministic)", () => {
    const f = foldBlocks(true);
    const plain = executeSearchContext({ query: "token" }, f.core, f.session.state);
    assert.match(plain, /Found 5 block\(s\) for "token"/);
    assert.ok(plain.indexOf('"token auth history"') < plain.indexOf('"token ratelimit"'), "lexical order without plan state");
    const logs: string[] = [];
    const aware = executeSearchContext({ query: "token" }, f.core, f.session.state, undefined, planOpts(f, logs));
    assert.notEqual(aware, plain, "re-ranking changed the output");
    assert.match(aware, /Found 5 block\(s\) for "token"/);
    assert.ok(aware.indexOf('"token ratelimit"') < aware.indexOf('"token auth history"'), "plan-relevant block ranked first");
    assert.ok(!aware.includes('"token metrics"'), "lowest-ranked block cut by the limit");
    assert.equal(logs.length, 1, "one inspectable scoring breakdown logged");
    assert.match(logs[0]!, /^\[acp-search-plan\] "token": \d+\/6 candidates plan-relevant → /);
    const again = executeSearchContext({ query: "token" }, f.core, f.session.state, undefined, planOpts(f, []));
    assert.equal(again, aware, "fully deterministic across calls");
});

test("steering output: top fetch targets first, repeat-retrieve hint only with history", () => {
    const f = foldBlocks(true);
    const b5 = blockByTopic(f, "token ratelimit");
    const b1 = blockByTopic(f, "token auth history");
    const aware = executeSearchContext({ query: "token" }, f.core, f.session.state, undefined, planOpts(f, []));
    assert.match(aware, /\n\n\[plan-aware\] top fetch targets: /);
    assert.match(aware, new RegExp(`top fetch targets: ${b5.blockId} \\[m00021\u2013m00025 · 5 msgs\\]`), "boosted block span listed first");
    assert.ok(!aware.includes("retrieved "), "no repeat hint without retrieve history");
    recordRetrieveHit(f.session, "m00003");
    recordRetrieveHit(f.session, "m00003");
    const aware2 = executeSearchContext({ query: "token" }, f.core, f.session.state, undefined, planOpts(f, []));
    assert.match(aware2, new RegExp(`m00003 retrieved 2 times this session \u2014 decompress\\(\\{blockId:"${b1.blockId}",startId:"m00003",endId:"m00003"}\\)`));
});

test("whole-block restore stats feed the RETRIEVAL QUALITY line", () => {
    const f = foldBlocks(true);
    const b = blockByTopic(f, "token auth history");
    resolveDecompress({ blockId: b.blockId }, ctxOf(f));
    assert.equal(f.session.stats.wholeBlockRestores, 1);
    assert.equal(f.session.stats.wholeBlockRestoresPreciseAvailable, 1, "precise path existed (CCR armed + span recorded)");
    const status = handleAcpStatus({}, ctxOf(f));
    assert.match(status, /RETRIEVAL QUALITY — whole-block restores: 1 total, 1 had a cheaper precise path available \(100%\)/);
});

test("whole-block restore without CCR: counted, precise path not credited", () => {
    const f = foldBlocks(false);
    const b = blockByTopic(f, "token auth history");
    resolveDecompress({ blockId: b.blockId }, ctxOf(f));
    assert.equal(f.session.stats.wholeBlockRestores, 1);
    assert.equal(f.session.stats.wholeBlockRestoresPreciseAvailable ?? 0, 0);
});

test("recordRetrieveHit: per-ref counts with a bounded map", () => {
    const s = getSession(`sp-cap-${Math.random().toString(36).slice(2)}`);
    for (let i = 0; i < 520; i++) recordRetrieveHit(s, `m${String(i).padStart(5, "0")}`);
    recordRetrieveHit(s, "m00000");
    assert.ok((s.retrieveCountsByRef?.size ?? 0) <= 512, "map stays under the cap");
    assert.equal(s.retrieveCountsByRef?.get("m00000"), 1, "FIFO-evicted ref restarts its count");
});

test("own-session target entry point: flag off → plain; flag on → re-ranked", () => {
    const f = foldBlocks(true);
    storeEffectiveSearchPlanAware(f.session, false);
    const off = executeSearchContextTarget({ query: "token" }, f.core, f.session.id, f.session.state, { messages: planMessages(), config: f.config, session: f.session, log: () => {} });
    assert.equal(off, executeSearchContext({ query: "token" }, f.core, f.session.state), "unflagged ctx → plain output");
    storeEffectiveSearchPlanAware(f.session, true);
    const on = executeSearchContextTarget({ query: "token" }, f.core, f.session.id, f.session.state, { messages: planMessages(), config: f.config, session: f.session, log: () => {} });
    assert.notEqual(on, off, "flagged ctx → re-ranked output");
    assert.equal(effectiveSearchPlanAware(f.session), true);
});

test("foreign-session search stays read-only lexical (no plan state, no steering)", () => {
    const a = foldBlocks(true);
    storeEffectiveSearchPlanAware(a.session, true);
    const foreign = getSession(`sp-foreign-${Math.random().toString(36).slice(2)}`);
    const fcore = createCore();
    const fconfig = applyCompressSettings(defaultConfig(200_000), 200_000, {}) as Config;
    const fturn = fcore.processTurn({ messages: makeMsgs(40), state: foreign.state, config: fconfig, tokenCount: 9999, renderTags: "text-only" });
    foreign.state = fturn.state;
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Foreign early history about tokens.", topic: "token foreign history" }] }), { core: fcore, config: fconfig, messages: fturn.messages, session: foreign, log: () => {} });
    const plain = executeSearchContext({ query: "token" }, fcore, foreign.state, foreign.id);
    const viaTarget = executeSearchContextTarget({ query: "token", conversation_id: foreign.id }, a.core, a.session.id, a.session.state, { messages: planMessages(), config: a.config, session: a.session, log: () => {} });
    assert.equal(viaTarget, plain, "foreign result byte-identical to a direct foreign search");
    assert.ok(!viaTarget.includes("[plan-aware]"), "no steering on foreign lookups");
});

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function anthropicToolUseSse(res: http.ServerResponse, id: string, name: string, inputJson: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("message_start", { message: { id, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 500 } } }));
    res.write(sseBlock("content_block_start", { index: 0, content_block: { type: "tool_use", id: `tu_${name}`, name, input: {} } }));
    res.write(sseBlock("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: inputJson } }));
    res.write(sseBlock("content_block_stop", { index: 0 }));
    res.write(sseBlock("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }));
    res.write(sseBlock("message_stop", {}));
    res.end();
}

function anthropicTextSse(res: http.ServerResponse, id: string, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("message_start", { message: { id, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 500 } } }));
    res.write(sseBlock("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    res.write(sseBlock("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
    res.write(sseBlock("content_block_stop", { index: 0 }));
    res.write(sseBlock("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
    res.write(sseBlock("message_stop", {}));
    res.end();
}

function listen(server: http.Server | ReturnType<typeof startServer> extends Promise<infer R> ? Awaited<R> : never): Promise<void> {
    if ((server as { listening?: boolean }).listening) return Promise.resolve();
    return once(server as http.Server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function systemAnchorHasCc(body: string): boolean {
    const sent = JSON.parse(body) as { system?: unknown };
    if (!Array.isArray(sent.system)) return false;
    return sent.system.some((b: { text?: string; cache_control?: unknown }) => typeof b.text === "string" && b.text.includes("SYS ANCHOR") && !!b.cache_control);
}

function searchResultText(body: string): string {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    for (const m of parsed.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
            if (c.type === "tool_result" && c.tool_use_id === "tu_search_context") {
                if (typeof c.content === "string") return c.content;
                if (Array.isArray(c.content)) return (c.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("");
            }
        }
    }
    return "";
}

async function startPlanProxy(captured: string[], planAware: boolean): Promise<{ proxyPort: number; upstreamPort: number; closeAll: () => Promise<void> }> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const n = captured.length;
            if (n === 1) {
                anthropicToolUseSse(res, "msg_c", "compress", JSON.stringify({ content: [
                    { startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" },
                    { startId: "m00008", endId: "m00014", summary: "Mid history: messages 8-14 about ratelimit and token endpoint design.", topic: "Mid history" },
                ] }));
            } else if (n === 2) {
                anthropicToolUseSse(res, "msg_s", "search_context", JSON.stringify({ query: "history", limit: 1 }));
            } else {
                anthropicTextSse(res, "msg_d", "done");
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, minCompressRangeChars: 1000, ccr: { enabled: true }, search: planAware ? { planAware: true } : undefined },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxyPort, upstreamPort, closeAll: async () => { await close(proxy as unknown as http.Server); await close(upstream); } };
}

function planProxyMsgs(): Array<{ role: string; content: string }> {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Historical detail ${i}. ${"y".repeat(2000)}` }));
    msgs.push({ role: "assistant", content: "Working on it — checking the current plan state first." });
    msgs.push({ role: "user", content: "Now add ratelimit middleware to the token flow." });
    return msgs;
}

test("e2e anthropic: plan-aware steering rides the search tool result; cache_control stays stable", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const { proxyPort, upstreamPort, closeAll } = await startPlanProxy(captured, true);
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sp-e2e-on", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: true, system: [{ type: "text", text: "SYS ANCHOR", cache_control: { type: "ephemeral" } }], messages: planProxyMsgs() }),
        });
        const sse = await res.text();
        assert.ok(res.ok, `client turn failed: HTTP ${res.status}: ${sse}`);
        assert.equal(captured.length, 3, "initial request + one re-request per executed tool");
        assert.match(captured[1]!, /Early history: messages 1-7 covered initial setup\./, "fold carried into the re-request");
        const txt = searchResultText(captured[2]!);
        assert.ok(txt.length > 0, "search tool result present on the re-request");
        assert.match(txt, /Found 1 block\(s\) for "history"/);
        assert.ok(txt.includes('"Mid history"'), "plan-relevant block returned despite the lexical tie");
        assert.ok(!txt.includes('"Early history"'), "lexically-tied block displaced by plan ranking");
        const steer = txt.match(/\[plan-aware\] top fetch targets: (b\d+) \[(m\d+\u2013m\d+) · 7 msgs\]/);
        assert.ok(steer, "steering section carries the returned block's ref span");
        assert.match(txt, new RegExp(`${steer![1]} \\(T1\\) "Mid history"`), "steered block is the returned one");
        for (let i = 0; i < captured.length; i++) assert.ok(systemAnchorHasCc(captured[i]!), `request ${i + 1}: client anchor cache_control stable`);
    } finally {
        await closeAll();
    }
});

test("e2e anthropic: planAware off (default) leaves the search output untouched", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const { proxyPort, upstreamPort, closeAll } = await startPlanProxy(captured, false);
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sp-e2e-off", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: true, system: [{ type: "text", text: "SYS ANCHOR", cache_control: { type: "ephemeral" } }], messages: planProxyMsgs() }),
        });
        const sse = await res.text();
        assert.ok(res.ok, `client turn failed: HTTP ${res.status}: ${sse}`);
        assert.equal(captured.length, 3);
        const txt = searchResultText(captured[2]!);
        assert.ok(txt.length > 0, "search tool result present");
        assert.ok(txt.includes('"Early history"'), "lexical winner returned");
        assert.ok(!txt.includes('"Mid history"'), "limit 1 cuts the tied block");
        assert.ok(!txt.includes("[plan-aware]"), "no steering when the feature is off");
        for (let i = 0; i < captured.length; i++) assert.ok(systemAnchorHasCc(captured[i]!), `request ${i + 1}: client anchor cache_control stable`);
    } finally {
        await closeAll();
    }
});
