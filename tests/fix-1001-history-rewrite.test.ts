import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyCompactionArchive, detectUnannouncedHistoryRewrite, listSessions, markCompactionBoundary, preCompactionArchiveOf } from "../src/session.ts";
import { normalizeRangeOrder, applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1001: a client (opencode) silently native-compacted its own history mid-session
// after a model switch. bili saw the rewritten history with no announcement channel:
// A-era blocks orphaned (kernel renders them at the head), refs non-monotonic
// (preflight emitted reversed ranges), byRaw/byRef leaking dead ids.

const noLog = (_level: string, _msg: string): void => {};

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

// 24 real messages → processTurn assigns m00001..m00024 → compress the first half
// so the session carries one active A-era block.
function sessionWithBlockAndRefs(): { session: Session; blockId: string; all: CoreMessage[] } {
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
    return { session, blockId: session.state.blocks[session.state.blocks.length - 1].blockId, all: msgs };
}

test("#1001 detectUnannouncedHistoryRewrite: rewritten history (majority of raws gone) is detected", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    assert.equal(knownBefore.size, 24);
    // incoming = last 8 old + 16 brand-new (opencode kept a tail and appended fresh content)
    const tail: CoreMessage[] = [
        ...all.slice(16),
        ...Array.from({ length: 16 }, (_, k): CoreMessage => ({ id: `h_new${k}`, role: k % 2 === 0 ? "user" : "assistant", contentType: "text" as const, text: `new ${k}` })),
    ];
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, tail.map((m) => m.id));
    assert.equal(det.detected, true, `expected detection (${JSON.stringify(det)})`);
    assert.equal(det.knownBefore, 24);
    assert.equal(det.incomingTotal, 24);
    assert.equal(det.knownIncoming, 8);
});

test("#1001 detectUnannouncedHistoryRewrite: append-only growth is NOT detected", () => {
    const { session, all } = sessionWithBlockAndRefs();
    const knownBefore = new Set(Object.keys(session.state.messageRefs.byRaw));
    const tail: CoreMessage[] = [
        ...all,
        ...Array.from({ length: 4 }, (_, k): CoreMessage => ({ id: `h_new${k}`, role: k % 2 === 0 ? "user" : "assistant", contentType: "text" as const, text: `new ${k}` })),
    ];
    const det = detectUnannouncedHistoryRewrite(session, knownBefore, tail.map((m) => m.id));
    assert.equal(det.detected, false, `append-only must not trip the detector (${JSON.stringify(det)})`);
});

test("#1001 detectUnannouncedHistoryRewrite: fresh session / no blocks are NOT detected", () => {
    // fresh: fewer than REWRITE_MIN_KNOWN_REFS known refs
    const fresh = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const few: CoreMessage[] = Array.from({ length: 5 }, (_, i) => ({ id: `h_few${i}`, role: "user" as const, contentType: "text" as const, text: `few ${i}` }));
    fresh.state = core.processTurn({ messages: few, state: fresh.state, config, tokenCount: 100, renderTags: "text-only" }).state;
    const unknown = ["h_a", "h_b", "h_c", "h_d"];
    assert.equal(detectUnannouncedHistoryRewrite(fresh, new Set(Object.keys(fresh.state.messageRefs.byRaw)), unknown).detected, false);

    // mature refs but never compressed: nothing to archive
    const { session, all } = sessionWithBlockAndRefs();
    for (const b of session.state.blocks) b.active = false;
    const det = detectUnannouncedHistoryRewrite(session, new Set(all.map((m) => m.id)), all.slice(16).map((m) => m.id));
    assert.equal(det.detected, false, "no active blocks → nothing to archive → no boundary");
});

test("#1001 normalizeRangeOrder: swaps numerically-reversed mNNNNN pairs only", () => {
    const ranges = [
        { startRef: "m02243", endRef: "m00334" }, // reversed (the #1001 preflight shape)
        { startRef: "m00010", endRef: "m00020" }, // already ordered
        { startRef: "b3", endRef: "m00010" }, // mixed namespaces — leave to the kernel
        { startRef: "m00010", endRef: "b3" },
    ];
    const swapped = normalizeRangeOrder(ranges);
    assert.equal(swapped, 1);
    assert.deepEqual(ranges[0], { startRef: "m00334", endRef: "m02243" });
    assert.deepEqual(ranges[1], { startRef: "m00010", endRef: "m00020" });
    assert.deepEqual(ranges[2], { startRef: "b3", endRef: "m00010" });
    assert.deepEqual(ranges[3], { startRef: "m00010", endRef: "b3" });
    assert.equal(normalizeRangeOrder([]), 0);
});

test("#1001 e2e openai-wire: silent client history rewrite → boundary marked, blocks archived, refs pruned, preflight still fits the window", async () => {
    const WINDOW = 10_000;
    const SID = "rewrite-e2e-sess";
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
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
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
        // Turn 1 (A-era under the hood): ~18k-token estimate vs 10k window → preflight
        // folds the oldest FILLER messages into a REAL proxy-created block.
        const r1 = await post("gpt-test", orig);
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID);
        assert.ok(sess, "session exists");
        assert.equal(Object.keys(sess!.state.messageRefs.byRaw).length, 24, "all 24 messages got refs");
        assert.ok(sess!.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");

        // The client silently rewrites its history mid-session (native compaction after
        // a model switch upstream): keeps the last 8 originals, appends 16 fresh ones.
        const rewritten = [...orig.slice(16), ...Array.from({ length: 16 }, (_, k) => msg(k, "NEWMSG"))];
        const r2 = await post("gpt-test", rewritten);
        assert.equal(r2.status, 200);

        sess = listSessions().find((s) => s.id === SID)!;
        const bound = sess.metadata.compactionBoundary as Record<string, unknown> | undefined;
        assert.ok(bound, "a compaction boundary was marked for the unannounced rewrite");
        assert.equal(bound.pending, false, "boundary consumed by applyCompactionArchive");
        const archivedIds = bound.archivedBlocks as string[];
        assert.ok(Array.isArray(archivedIds) && archivedIds.length >= 1, "turn-1 block(s) recorded in archivedBlocks");
        const archive = preCompactionArchiveOf(sess);
        for (const id of archivedIds) {
            assert.match(archive[id]!.reason, /native compaction/, "archive entry carries the reason");
        }
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 24, "byRaw pruned to live ids (no additive leak: 16 new raws replaced 16 dead ones)");
        const refVals = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals).size, refVals.length, "ref numbers never duplicated after the prune");
        assert.ok(!sess.state.blocks.some((b) => b.active && archivedIds.includes(b.blockId)), "archived blocks are not rendered as active");

        const forwards = calls.filter((c) => !/TASK: The conversation segment below/.test(c.raw));
        const fwd2 = forwards[forwards.length - 1]!;
        assert.ok(fwd2.raw.includes(SUMMARY_TEXT), "rebuilt payload carries the preflight summary");
        assert.ok(fwd2.raw.includes("NEWMSG_15_payload"), "recent tail survives in the payload");
        assert.ok(!fwd2.raw.includes("FILLER_0_payload"), "folded head is out of the payload");
        assert.ok(Buffer.byteLength(fwd2.raw) < Buffer.byteLength(JSON.stringify(rewritten)) * 1.5, "forwarded payload is smaller than the raw history");

        // Turn 3: normal append-only continuation after the rewrite — refs continue, no dupes.
        const r3 = await post("gpt-test", [...rewritten, msg(99, "MORE")]);
        assert.equal(r3.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 25, "byRaw tracks exactly the live ids after append");
        const refVals3 = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals3).size, refVals3.length, "still no duplicate refs after the prune");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

// #2598: the same silent-rewrite failure domain on the Google wire. The detector
// is protocol-agnostic and the consumer side (applyCompactionArchive) was already
// wired into prepare-google.ts — this pins the producer trio (pre-turn snapshot +
// detect + markCompactionBoundary) on the Gemini lane end-to-end.
test("#1001/#2598 e2e google-wire: silent client history rewrite → boundary marked, blocks archived, refs pruned", async () => {
    const WINDOW = 10_000;
    const SID = "rewrite-e2e-google";
    const SUMMARY_TEXT =
        "PREFLIGHT SUMMARY of the folded segment: multi-step debugging work on the billing pipeline. " +
        "Key decisions: chose retry with backoff over fail-fast because upstream flakiness was intermittent. " +
        "Files touched: src/a.ts:10, src/b.ts:20. Outcome: verified green.";
    const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 };

    function msg(i: number, tag: string): { role: string; parts: { text: string }[] } {
        return { role: i % 2 === 0 ? "user" : "model", parts: [{ text: `${tag}_${i}_payload_`.repeat(180) }] };
    }
    const orig = Array.from({ length: 24 }, (_, i) => msg(i, "FILLER"));

    const calls: Array<{ raw: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            calls.push({ raw });
            const summaryRequest = /TASK: The conversation segment below/.test(raw);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: summaryRequest ? SUMMARY_TEXT : "ok" }] }, finishReason: "STOP", index: 0 }],
                usageMetadata: USAGE,
                modelVersion: "gemini-test",
            }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: WINDOW } } } } as ProxyOptions["routes"],
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
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:generateContent`;
    const post = (contents: Array<{ role: string; parts: { text: string }[] }>): Promise<{ status: number; body: string }> =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": SID }, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }) }).then(async (r) => ({ status: r.status, body: await r.text() }));

    try {
        // Turn 1 (A-era under the hood): ~18k-token estimate vs 10k window → preflight
        // folds the oldest FILLER messages into a REAL proxy-created block.
        const r1 = await post(orig);
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID);
        assert.ok(sess, "session exists");
        assert.equal(sess!.meta.protocol, "google", "the request was recognized as the Google wire");
        assert.equal(Object.keys(sess!.state.messageRefs.byRaw).length, 24, "all 24 messages got refs");
        assert.ok(sess!.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");

        // The client silently rewrites its history mid-session (native compaction):
        // keeps the last 8 originals, appends 16 fresh ones.
        const rewritten = [...orig.slice(16), ...Array.from({ length: 16 }, (_, k) => msg(k, "NEWMSG"))];
        const r2 = await post(rewritten);
        assert.equal(r2.status, 200);

        sess = listSessions().find((s) => s.id === SID)!;
        const bound = sess.metadata.compactionBoundary as Record<string, unknown> | undefined;
        assert.ok(bound, "a compaction boundary was marked for the unannounced rewrite (#2598 gap)");
        assert.equal(bound.pending, false, "boundary consumed by applyCompactionArchive");
        const archivedIds = bound.archivedBlocks as string[];
        assert.ok(Array.isArray(archivedIds) && archivedIds.length >= 1, "turn-1 block(s) recorded in archivedBlocks");
        const archive = preCompactionArchiveOf(sess);
        for (const id of archivedIds) {
            assert.match(archive[id]!.reason, /native compaction/, "archive entry carries the reason");
        }
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 24, "byRaw pruned to live ids (no additive leak: 16 new raws replaced 16 dead ones)");
        const refVals = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals).size, refVals.length, "ref numbers never duplicated after the prune");
        assert.ok(!sess.state.blocks.some((b) => b.active && archivedIds.includes(b.blockId)), "archived blocks are not rendered as active");

        const forwards = calls.filter((c) => !/TASK: The conversation segment below/.test(c.raw));
        const fwd2 = forwards[forwards.length - 1]!;
        assert.ok(fwd2.raw.includes(SUMMARY_TEXT), "rebuilt payload carries the preflight summary");
        assert.ok(fwd2.raw.includes("NEWMSG_15_payload"), "recent tail survives in the payload");
        assert.ok(!fwd2.raw.includes("FILLER_0_payload"), "folded head is out of the payload");
        assert.ok(Buffer.byteLength(fwd2.raw) < Buffer.byteLength(JSON.stringify(rewritten)) * 1.5, "forwarded payload is smaller than the raw history");

        // Turn 3: normal append-only continuation after the rewrite — refs continue, no dupes.
        const r3 = await post([...rewritten, msg(98, "MORE")]);
        assert.equal(r3.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 25, "byRaw tracks exactly the live ids after append");
        const refVals3 = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals3).size, refVals3.length, "still no duplicate refs after the prune");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

// #1001 问题3: the documented line form split across sibling array elements
// (refs header + summary as separate strings) previously died with
// kind=no-valid-ranges, dropped=2. Kernel 0.0.79 coalesces them; this guards
// the pinned kernel actually carries the fix through the bili funnel.
test("#1001 问题3: split-element line form compresses instead of failing (kernel coalesce)", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 24; i++) {
        msgs.push({ id: `h_split${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `message ${i} ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const logs: string[] = [];
    const out = applyRanges(
        parseCompressInput({ content: ["m00001\u2013m00012 前期调试与决策", "## TASK AS OF THIS BLOCK\n- goal\n- decisions with reasons"] }),
        { core, config, messages: turn.messages, session, log: (m: string) => logs.push(m) },
    ).text;
    assert.ok(!out.startsWith("[Compression FAILED"), `split line form must parse: ${out}`);
    assert.ok(session.state.blocks.length > 0, "one block created from the coalesced range");
    assert.match(logs.join("\n"), /compress requested 1 range\(s\): m00001\u2013m00012/, "range reached the compress funnel");
});
