// #1179 CCR v2: fold-time storing (blocks record covered originals in the
// content store), range-level decompress (ephemeral channel, all failure
// modes), ID-returning search_context hits, acp_status BLOCK SPANS linkage,
// plus wire-level runs proving range restores ride the rewrite paths with
// client cache_control breakpoints kept stable (mirrors the v1
// retrieve-injection coverage discipline).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
    buildStoredPlaceholder,
    createContentStore,
    createCore,
    defaultConfig,
    storeOriginal,
    type Config,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { adoptContentStore, contentStoreOf, drainPendingRetrievals, storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { coveredRefSpan, executeSearchContext, resolveDecompress } from "../src/decompress-shared.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

// 20 messages so the m00001–m00007 fold range sits outside the kernel's
// protected recent zone (preserveRecentMessages=5 + preserveRecentTokens=5000
// cover roughly the last ten ~516-token messages).
function makeMsgs(): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    return msgs;
}

type FoldResult = {
    core: ReturnType<typeof createCore>;
    config: Config;
    session: ReturnType<typeof getSession>;
    msgs: CoreMessage[];
    blockId: string;
};

function fold(opts: { ccr: boolean; preStore?: MessageContentStore }): FoldResult {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: opts.ccr ? { enabled: true, minToolTokens: 50 } : { enabled: false, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`ccrv2-${Math.random().toString(36).slice(2)}`);
    if (opts.ccr) storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw = makeMsgs();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    if (opts.preStore) adoptContentStore(session, opts.preStore);
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

function ctxOf(f: FoldResult) {
    return { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
}

test("CCR v2 fold-time storing: folded originals land in the content store", () => {
    const f = fold({ ccr: true });
    const store = contentStoreOf(f.session);
    for (let i = 1; i <= 7; i++) {
        const entry = store.byRef[`m${pad(i)}`];
        assert.ok(entry, `m${pad(i)} stored`);
        assert.equal(entry.rawId, `h_${i - 1}`);
    }
    assert.equal(store.byRef["m00015"], undefined, "uncovered messages not stored");
    assert.match(store.byHash[store.byRef["m00003"]!.hash]!, /Historical detail 2\./);
    assert.ok(f.session.stats.storedBytes > 0, "storedBytes credited");
    assert.equal(f.session.contentStoreDirty, true);
});

test("CCR v2 fold-time storing: disabled CCR stores nothing", () => {
    const f = fold({ ccr: false });
    const store = contentStoreOf(f.session);
    assert.equal(Object.keys(store.byRef).length, 0);
    assert.equal(f.session.stats.storedBytes, 0);
});

test("CCR v2 first-write-wins: arrival entries survive fold-time storing", () => {
    // storeOriginal is immutable — chain the returned store.
    const pre = storeOriginal(createContentStore(), { ref: "m00003", rawId: "h_2", text: "ARRIVAL-WINS TEXT", kind: "text", tokens: 4, head: "ARRIVAL-WINS" });
    const f = fold({ ccr: true, preStore: pre });
    const store = contentStoreOf(f.session);
    assert.equal(store.byHash[store.byRef["m00003"]!.hash], "ARRIVAL-WINS TEXT");
    assert.ok(store.byRef["m00001"], "other covered refs still stored");
});

test("CCR v2 range decompress: restores only the span via ephemeral injection", () => {
    const f = fold({ ccr: true });
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctxOf(f));
    assert.match(ack, new RegExp(`\\[decompress ${f.blockId} m00002\u2013m00004: restored 3 item\\(s\\)`));
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1, "one ephemeral injection queued");
    const inj = injs[0]!;
    assert.equal(inj.id, `acp_retrieved_range_${f.blockId}_m00002-m00004`);
    assert.equal(inj.role, "system");
    assert.equal(inj.contentType, "text");
    assert.ok(inj.text!.startsWith(`[Block ${f.blockId} content \u2014 m00002\u2013m00004 \u2014 3 item(s)]`));
    assert.match(inj.text!, /Historical detail 1\./);
    assert.match(inj.text!, /Historical detail 2\./);
    assert.match(inj.text!, /Historical detail 3\./);
    assert.doesNotMatch(inj.text!, /Historical detail 0\./);
    assert.doesNotMatch(inj.text!, /Historical detail 4\./);
    assert.equal(f.session.stats.rangeRestores, 1);
    const block = f.session.state.blocks.find((b) => b.blockId === f.blockId);
    assert.equal(block?.active, true, "block stays active");
    assert.ok(f.session.blockContents.has(f.blockId), "whole-block cache untouched");
});

test("CCR v2 range decompress: falls back to the content store when the client view lacks originals (#1207 F1)", () => {
    const f = fold({ ccr: true });
    // Native-compaction archive adoption / client-side trimming / restart with
    // a compacted client: the re-sent history no longer carries the covered
    // originals — only the fold-time content store does.
    const trimmed = { core: f.core, config: f.config, messages: f.msgs.slice(10), session: f.session, log: () => {} };
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, trimmed);
    assert.match(ack, /restored 3 item\(s\)/, `store fallback should restore, got: ${ack.slice(0, 200)}`);
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1);
    assert.match(injs[0]!.text!, /Historical detail 1\./);
    assert.match(injs[0]!.text!, /Historical detail 3\./);
    assert.doesNotMatch(injs[0]!.text!, /Historical detail 0\./);
});

test("CCR v2 range decompress: store-first per-ref beats an arrival placeholder left in the exec-time view (#1283)", () => {
    // Oversized tool result stored at arrival: the store holds the original,
    // but a covered ref that stays visible in the exec-time view carries only
    // its 📦 placeholder (rebuild hides covered refs in real server flows;
    // direct core consumers and protect-zone edges do not). The old
    // all-or-nothing fallback let the placeholder win because parts was
    // non-empty; per-ref store-first must restore the stored original.
    const pre = storeOriginal(createContentStore(), { ref: "m00003", rawId: "h_2", text: "ARRIVAL-WINS FULL ORIGINAL", kind: "shell output", toolName: "bash", tokens: 40, head: "ARRIVAL-WINS HEAD" });
    const f = fold({ ccr: true, preStore: pre });
    const msgs = f.msgs.map((m) => (m.id === "h_2" ? { ...m, contentType: "text", toolName: undefined, text: buildStoredPlaceholder({ ref: "m00003", kind: "shell output", tokens: 40, head: "ARRIVAL-WINS HEAD", retrieveToolName: "acp_retrieve" }) } : m));
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, { core: f.core, config: f.config, messages: msgs, session: f.session, log: () => {} });
    assert.match(ack, /restored 3 item\(s\)/);
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1);
    assert.match(injs[0]!.text!, /ARRIVAL-WINS FULL ORIGINAL/, "stored original wins over the view placeholder");
    assert.doesNotMatch(injs[0]!.text!, /acp-stored/, "no placeholder leaks into the restored span");
});

test("CCR v2 range decompress: client retry dedupes the injection and the stat (#1207 F5)", () => {
    const f = fold({ ccr: true });
    const ctx = ctxOf(f);
    const a1 = resolveDecompress({ blockId: f.blockId, startId: "m00001", endId: "m00002" }, ctx);
    const a2 = resolveDecompress({ blockId: f.blockId, startId: "m00001", endId: "m00002" }, ctx);
    assert.match(a1, /restored 2 item\(s\)/);
    assert.equal(a2, a1, "retry re-acks identically");
    assert.equal(drainPendingRetrievals(f.session).length, 1, "no duplicate full-text injection");
    assert.equal(f.session.stats.rangeRestores, 1);
});

test("CCR v2 range decompress: failure modes queue nothing", () => {
    const f = fold({ ccr: true });
    const ctx = ctxOf(f);
    assert.match(resolveDecompress({ blockId: f.blockId, startId: "m00002" }, ctx), /given together/);
    assert.match(resolveDecompress({ blockId: f.blockId, startId: "b1", endId: "m00004" }, ctx), /must be mNNNNN/);
    assert.match(resolveDecompress({ blockId: f.blockId, startId: "m00004", endId: "m00002" }, ctx), /swap them/);
    assert.match(resolveDecompress({ blockId: f.blockId, startId: "m00015", endId: "m00016" }, ctx), /covers no messages in m00015\u2013m00016/);
    assert.equal(drainPendingRetrievals(f.session).length, 0);
    assert.equal(f.session.stats.rangeRestores, 0);
    const g = fold({ ccr: false });
    assert.match(resolveDecompress({ blockId: g.blockId, startId: "m00002", endId: "m00004" }, ctxOf(g)), /requires CCR/);
});

test("CCR v2 whole-block decompress behavior unchanged", () => {
    const f = fold({ ccr: true });
    const out = resolveDecompress({ blockId: f.blockId }, ctxOf(f));
    // 7 x ~2KB exceeds the 10K inline threshold — file mode is the expected path.
    const m = out.match(/Content \((\d+) chars\) written to: (.+)\nUse the read tool/);
    assert.ok(m, `expected file-mode ack, got: ${out.slice(0, 200)}`);
    const fileBody = readFileSync(m[2]!, "utf8");
    for (let i = 0; i <= 6; i++) assert.match(fileBody, new RegExp(`Historical detail ${i}\\.`));
    assert.doesNotMatch(fileBody, /Historical detail 7\./);
    assert.equal(drainPendingRetrievals(f.session).length, 0, "whole-block path queues no injections");
    assert.equal(f.session.stats.rangeRestores, 0);
});

test("coveredRefSpan collapses contiguous refs", () => {
    const f = fold({ ccr: true });
    const block = f.session.state.blocks.find((b) => b.blockId === f.blockId)!;
    assert.deepEqual(coveredRefSpan(f.session.state, block), { text: "m00001\u2013m00007", count: 7 });
});

test("CCR v2 search_context hits carry covered spans", () => {
    const f = fold({ ccr: true });
    const out = executeSearchContext({ query: "Early" }, f.core, f.session.state);
    assert.match(out, /Early history/);
    assert.match(out, /\[m00001\u2013m00007 \u00b7 7 msgs\]/);
});

test("acp_status exposes BLOCK SPANS and counts range-restores separately", () => {
    const f = fold({ ccr: true });
    const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session };
    const out = handleAcpStatus({}, ctx);
    assert.match(out, /BLOCK SPANS \u2014 b\d+=m00001\u2013m00007/);
    resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctxOf(f));
    const after = handleAcpStatus({}, ctx);
    assert.match(after, /range-restored 1/);
});

test("acp_status hides BLOCK SPANS when CCR is disarmed (#1207 review)", () => {
    const f = fold({ ccr: false });
    const out = handleAcpStatus({}, { core: f.core, config: f.config, messages: f.msgs, session: f.session });
    assert.doesNotMatch(out, /BLOCK SPANS/);
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function systemAnchorHasCc(body: string): boolean {
    const sent = JSON.parse(body) as { system?: unknown };
    if (!Array.isArray(sent.system)) return false;
    return sent.system.some((b: { text?: string; cache_control?: unknown }) => typeof b.text === "string" && b.text.includes("SYS ANCHOR") && !!b.cache_control);
}

function ccOnInjectedContent(body: string): boolean {
    const sent = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    for (const m of sent.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content as Array<{ text?: string; cache_control?: unknown }>) {
            if (typeof c.text === "string" && (c.text.includes("restored 3 item(s)") || c.text.includes("[Block b1 content")) && c.cache_control) return true;
        }
    }
    return false;
}

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

async function startV2Proxy(captured: string[], noCcr?: boolean): Promise<{ proxyPort: number; upstreamPort: number; closeAll: () => Promise<void> }> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const n = captured.length;
            if (n === 1) {
                anthropicToolUseSse(res, "msg_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }));
            } else if (n === 2) {
                anthropicToolUseSse(res, "msg_d", "decompress", JSON.stringify({ blockId: "b1", startId: "m00002", endId: "m00004" }));
            } else {
                anthropicTextSse(res, "msg_e", "done");
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
        compress: noCcr ? { injectTool: true, minCompressRangeChars: 1000 } : { injectTool: true, minCompressRangeChars: 1000, ccr: { enabled: true } },
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
    return { proxyPort, upstreamPort, closeAll: async () => { await close(proxy); await close(upstream); } };
}

test("e2e CCR v2 streaming: range restore rides the re-request with pair integrity; cache_control stays stable", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const { proxyPort, upstreamPort, closeAll } = await startV2Proxy(captured);
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Historical detail ${i}. ${"y".repeat(2000)}` }));
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ccr-v2-e2e-sse", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: true, system: [{ type: "text", text: "SYS ANCHOR", cache_control: { type: "ephemeral" } }], messages: msgs }),
        });
        const sse = await res.text();
        assert.ok(res.ok, `client turn failed: HTTP ${res.status}: ${sse}`);

        assert.equal(captured.length, 3, "initial request + one re-request per executed tool");
        const r2txt = captured[1]!;
        assert.match(r2txt, /Early history: messages 1-7 covered initial setup\./, "re-request after compress carries the fold");
        // Kernel head anchor: rebuildMessages keeps the first user message visible even when a block covers it.
        assert.match(r2txt, /Historical detail 0\./, "first user message survives the fold (kernel head anchor)");
        for (let d = 1; d <= 6; d++) assert.doesNotMatch(r2txt, new RegExp(`Historical detail ${d}\\.`), `folded detail ${d} gone from the wire`);

        const r3txt = captured[2]!;
        assert.match(r3txt, /restored 3 item\(s\)/, "ack rides the tool result");
        assert.match(r3txt, /\[Block b1 content \u2014 m00002\u2013m00004 \u2014 3 item\(s\)\]/, "injected span header present");
        assert.match(r3txt, /Historical detail 1\./);
        assert.match(r3txt, /Historical detail 3\./);
        assert.doesNotMatch(r3txt, /Historical detail 4\./, "span upper bound excluded (also outside the fold)");

        const r3 = JSON.parse(captured[2]!) as { messages: Array<{ role: string; content?: unknown }> };
        const useIdx = r3.messages.findIndex((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type?: string; id?: string }>).some((c) => c.type === "tool_use" && c.id === "tu_decompress"));
        const resIdx = r3.messages.findIndex((m) => m.role === "user" && Array.isArray(m.content) && (m.content as Array<{ type?: string; tool_use_id?: string }>).some((c) => c.type === "tool_result" && c.tool_use_id === "tu_decompress"));
        assert.ok(useIdx >= 0 && resIdx > useIdx, "decompress tool_use/tool_result pair intact and ordered");

        for (let i = 0; i < captured.length; i++) {
            assert.ok(systemAnchorHasCc(captured[i]!), `request ${i + 1}: client cache_control survives on the anchor block`);
        }
        assert.equal(ccOnInjectedContent(captured[2]!), false, "no breakpoint lands on injected range-restore content");
    } finally {
        await closeAll();
    }
});

test("e2e CCR v2 default-on: no ccr config at any level arms the session — range restore works (#1425 supersedes #1207)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const { proxyPort, upstreamPort, closeAll } = await startV2Proxy(captured, true);
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Historical detail ${i}. ${"y".repeat(2000)}` }));
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ccr-v2-e2e-default-on", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: true, system: [{ type: "text", text: "SYS ANCHOR", cache_control: { type: "ephemeral" } }], messages: msgs }),
        });
        const sse = await res.text();
        assert.ok(res.ok, `client turn failed: HTTP ${res.status}: ${sse}`);
        assert.equal(captured.length, 3, "initial request + one re-request per executed tool");
        // [#1425 owner decision] supersedes the #1207 opt-in rule: no ccr key at
        // any level leaves the session armed with the base defaults, so the fold
        // stores the covered originals and the range restore delivers them.
        assert.match(captured[2]!, /restored 3 item\(s\)/, "range restore works without any ccr config");
    } finally {
        await closeAll();
    }
});

test("e2e CCR v2 non-stream: fold persists across turns; range restore delivered inline", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            if (captured.length === 1) {
                res.end(JSON.stringify({ id: "msg_c", type: "message", role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "tu_compress", name: "compress", input: { content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] } }], stop_reason: "tool_use", usage: { input_tokens: 500, output_tokens: 20 } }));
            } else {
                res.end(JSON.stringify({ id: "msg_d", type: "message", role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "tu_decomp", name: "decompress", input: { blockId: "b1", startId: "m00002", endId: "m00004" } }], stop_reason: "tool_use", usage: { input_tokens: 400, output_tokens: 10 } }));
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
        compress: { injectTool: true, minCompressRangeChars: 1000, ccr: { enabled: true } },
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
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const headers = { "content-type": "application/json", "x-acp-session": "ccr-v2-e2e-json", "anthropic-version": "2023-06-01" };

    try {
        const baseMsgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Historical detail ${i}. ${"y".repeat(2000)}` }));
        const sys = { type: "text", text: "SYS ANCHOR", cache_control: { type: "ephemeral" } };

        const res1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: false, system: [sys], messages: baseMsgs }) });
        const body1 = await res1.text();
        assert.ok(res1.ok, `turn 1 failed: HTTP ${res1.status}: ${body1}`);
        const j1 = JSON.parse(body1) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
        // Non-stream rewrite converts the proxy tool_use into an inline text block (v1 semantics — no tool_result pair on this wire).
        assert.equal(j1.stop_reason, "end_turn");
        assert.match(j1.content.map((c) => c.text ?? "").join("\n"), /\[Compressed m00001\u2013m00007/);

        const ackText = j1.content.map((c) => c.text ?? "").join("\n");
        const res2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: false, system: [sys], messages: [...baseMsgs, { role: "assistant", content: ackText }, { role: "user", content: "what was detail 2?" }] }) });
        const body2 = await res2.text();
        assert.ok(res2.ok, `turn 2 failed: HTTP ${res2.status}: ${body2}`);
        const j2 = JSON.parse(body2) as { content: Array<{ type: string; text?: string }> };
        const out2 = j2.content.map((c) => c.text ?? "").join("\n");
        assert.match(out2, /restored 3 item\(s\)/, "range ack delivered inline");
        assert.match(out2, /\[Block b1 content \u2014 m00002\u2013m00004 \u2014 3 item\(s\)\]/, "injected span rides inline after the ack");
        assert.match(out2, /Historical detail 1\./);
        assert.match(out2, /Historical detail 3\./);
        assert.doesNotMatch(out2, /Historical detail 0\./);
        assert.doesNotMatch(out2, /Historical detail 4\./);

        assert.match(captured[1]!, /Early history: messages 1-7 covered initial setup\./, "turn 2 outbound carries the folded view");
        assert.match(captured[1]!, /Historical detail 0\./, "head anchor visible in turn 2 outbound");
        for (let d = 1; d <= 6; d++) assert.doesNotMatch(captured[1]!, new RegExp(`Historical detail ${d}\\.`));

        for (let i = 0; i < captured.length; i++) {
            assert.ok(systemAnchorHasCc(captured[i]!), `request ${i + 1}: client cache_control survives on the anchor block`);
        }
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
