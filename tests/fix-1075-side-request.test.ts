import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { detectUnannouncedHistoryRewrite, listSessions } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1075: clients stamp auxiliary side-requests (Claude Code WebSearch query
// refinement, title generation) with the SAME session id as the main
// conversation. The #1001 detector read the 0/N known-ratio of such tiny
// all-new payloads as an unannounced history rewrite, wiped byRaw/byRef via
// applyCompactionArchive, and each following full-history replay burned N
// fresh refs until m99999 exhausted (observed: +6,301 refs per WebSearch).

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

// 24 real messages → processTurn assigns m00001..m00024 → compress the first
// half so the session carries one active block (same shape as fix-1001).
function sessionWithBlockAndRefs(): { session: Session; all: CoreMessage[] } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 24; i++) {
        msgs.push({ id: `h_distinct${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00012", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    return { session, all: msgs };
}

test("#1075 single-message side request (WebSearch shape) is NOT a rewrite", () => {
    const { session } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    assert.equal(knownBefore.size, 24);
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, ["side_websearch_query"]);
    assert.equal(det.detected, false, `1-message all-new payload must not trip the detector (${JSON.stringify(det)})`);
    assert.equal(det.incomingTotal, 1);
    assert.equal(det.knownIncoming, 0);
});

test("#1075 all-new batch below the floor is NOT a rewrite", () => {
    const { session } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, Array.from({ length: 9 }, (_, k) => `side_${k}`));
    assert.equal(det.detected, false, `9-message all-new payload must not trip the detector (${JSON.stringify(det)})`);
});

test("#1075 all-new batch at the floor with zero history overlap is NOT a rewrite", () => {
    const { session } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, Array.from({ length: 12 }, (_, k) => `side_${k}`));
    assert.equal(det.detected, false, `zero-overlap payload must not trip the detector (${JSON.stringify(det)})`);
});

test("#1075 genuine shrinkage with overlap stays detected (#1001 shape)", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const incoming = [
        ...all.slice(16).map((m) => m.id),
        ...Array.from({ length: 16 }, (_, k) => `h_new${k}`),
    ];
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, incoming);
    assert.equal(det.detected, true, `genuine rewrite must stay detected (${JSON.stringify(det)})`);
    assert.equal(det.incomingTotal, 24);
    assert.equal(det.knownIncoming, 8);
});

test("#1075 shrinkage right at the floor with one surviving known message stays detected", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const incoming = [all[23]!.id, ...Array.from({ length: 11 }, (_, k) => `h_new${k}`)];
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, incoming);
    assert.equal(det.detected, true, `floor-size shrinkage with overlap must stay detected (${JSON.stringify(det)})`);
});

function maxRefNum(s: Session): number {
    return Math.max(...Object.keys(s.state.messageRefs.byRef).map((r) => Number(r.slice(1))));
}

test("#1075 e2e openai-wire: 1-message side request neither wipes ref maps nor inflates the ref cursor", async () => {
    const WINDOW = 10_000;
    const SID = "side-req-e2e-sess";
    const SUMMARY_TEXT =
        "PREFLIGHT SUMMARY of the folded segment: multi-step debugging work on the billing pipeline. " +
        "Key decisions: chose retry with backoff over fail-fast because upstream flakiness was intermittent. " +
        "Files touched: src/a.ts:10, src/b.ts:20. Outcome: verified green.";

    function msg(i: number, tag: string): { role: string; content: string } {
        return { role: i % 2 === 0 ? "user" : "assistant", content: `${tag}_${i}_payload_`.repeat(180) };
    }
    const orig = Array.from({ length: 24 }, (_, i) => msg(i, "FILLER"));

    const calls: Array<{ raw: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            calls.push({ raw });
            if (/TASK: The conversation segment below/.test(raw)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", created: 1, model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                return;
            }
            const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
                `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chunk({ role: "assistant" }, null) + chunk({ content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, { preserveRecentMessages: 2, preserveRecentTokens: 2000, compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`;
    const post = (model: string, messages: Array<{ role: string; content: string }>): Promise<{ status: number; body: string }> =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": SID }, body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages }) }).then(async (r) => ({ status: r.status, body: await r.text() }));

    try {
        // Turn 1: ~18k-token estimate vs 10k window → preflight folds the oldest
        // FILLER messages into a REAL proxy-created block.
        const r1 = await post("gpt-test", orig);
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID);
        assert.ok(sess, "session exists");
        assert.equal(Object.keys(sess!.state.messageRefs.byRaw).length, 24, "all 24 messages got refs");
        assert.ok(sess!.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");
        const origRefs = new Map(Object.entries(sess!.state.messageRefs.byRaw));

        // The client fires a standalone auxiliary prompt (WebSearch query
        // refinement) stamped with the same session id — 1 brand-new message.
        const r2 = await post("gpt-test", [{ role: "user", content: "SIDEREQ_refine_search_query" }]);
        assert.equal(r2.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(sess.metadata.compactionBoundary, undefined, "a 1-message side request must not mark a compaction boundary");
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 25, "ref maps survive the side request (no archive+prune)");
        assert.equal(maxRefNum(sess), 25, "the side request consumes exactly one ref");

        // Next main turn resends the full history WITHOUT the side message.
        const r3 = await post("gpt-test", [...orig, msg(99, "MORE")]);
        assert.equal(r3.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        for (const [rawId, ref] of origRefs) {
            assert.equal(sess.state.messageRefs.byRaw[rawId], ref, `original ${ref} kept its ref across the side request`);
        }
        assert.equal(maxRefNum(sess), 26, "full-history replay reuses existing refs — no snowball (pre-fix this read 50)");
        const refVals = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals).size, refVals.length, "no duplicate refs after the side request");
        assert.ok(sess.state.blocks.some((b) => b.active), "turn-1 block survived the side request (orphan GC needs 3 turns)");

        const forwards = calls.filter((c) => !/TASK: The conversation segment below/.test(c.raw));
        const fwd3 = forwards[forwards.length - 1]!;
        assert.ok(fwd3.raw.includes(SUMMARY_TEXT), "rebuilt payload still carries the preflight summary");
        assert.ok(fwd3.raw.includes("MORE_99_payload"), "new tail survives in the payload");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
