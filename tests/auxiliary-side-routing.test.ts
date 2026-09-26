import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { listSessions } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _rememberedForTest } from "../src/plugin.ts";
import { AUXILIARY_MAX_MESSAGES, AUXILIARY_MIN_MAIN_VIEW, extractWireTexts, isAuxiliaryRequest, recordAnchorView } from "../src/server/side-request.ts";

// #1309/#1307: normal-budget auxiliary requests (auto-review/classifier/title-gen)
// ride the main session key with ≤2 brand-new messages and no tools. Primary
// discriminator: identity affinity against the remembered anchor view — a
// request whose every message is unknown to the anchor diverges from it at the
// first message → side-passthrough lane (no refs, no snapshot, no usage/nudge
// baseline, no orphan-GC feed). The resend latch corroborates: sessions that
// never re-send history (stateless light clients) never arm it and keep today's
// full pipeline — including the #1075 contract that a single no-tools
// normal-budget request consumes exactly one ref. Every affinity failure falls
// back to the full pipeline (owner-pinned fail-safe direction, #1309).

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

const openaiBody = (messages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: "gpt-test",
    max_tokens: 1024,
    stream: true,
    messages,
    ...extra,
});

test("isAuxiliaryRequest: fresh session (no main view yet) is never auxiliary", () => {
    const s = makeSession();
    const body = openaiBody([{ role: "user", content: "brand new opener" }]);
    assert.equal(isAuxiliaryRequest("openai", body, s), false, "first turn of a new session must run the full pipeline");
});

// Establishes the session the way a real agent conversation does: a qualifying
// main view (≥ AUXILIARY_MIN_MAIN_VIEW) followed by a turn that re-sends it
// verbatim (+1 new message) — this arms the resend latch and sets the anchor.
function establishResendLatch(s: Session): void {
    const v1 = [{ role: "user", text: "main one" }, { role: "assistant", text: "main two" }, { role: "user", text: "main three" }];
    recordAnchorView(s, v1);
    recordAnchorView(s, [...v1, { role: "assistant", text: "main four" }]);
}

test("isAuxiliaryRequest: <=2 fresh messages, no tools, latched session → auxiliary", () => {
    const s = makeSession();
    establishResendLatch(s);
    const body = openaiBody([{ role: "user", content: "SYNTHETIC review prompt" }]);
    assert.equal(isAuxiliaryRequest("openai", body, s), true);
});

test("isAuxiliaryRequest: side-shaped views before any qualifying main view never bootstrap the anchor (no anchor poisoning, #1309)", () => {
    const s = makeSession();
    recordAnchorView(s, [{ role: "user", text: "hello" }]);
    recordAnchorView(s, [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
    assert.equal(isAuxiliaryRequest("openai", openaiBody([{ role: "user", content: "brand new opener A" }, { role: "user", content: "brand new opener B" }]), s), false, `views < ${AUXILIARY_MIN_MAIN_VIEW} msgs never establish an anchor → nothing to diverge from → full pipeline`);
});

test("isAuxiliaryRequest: stateless client (never re-sends history) is never demoted (#1075 contract)", () => {
    const s = makeSession();
    recordAnchorView(s, [{ role: "user", text: "P1" }]);
    assert.equal(isAuxiliaryRequest("openai", openaiBody([{ role: "user", content: "P2" }]), s), false, "1-msg views never establish an anchor or arm the latch → full pipeline");
    recordAnchorView(s, [{ role: "user", text: "P2" }]);
    assert.equal(isAuxiliaryRequest("openai", openaiBody([{ role: "user", content: "P3" }]), s), false, "still no anchor after zero-overlap turns → full pipeline");
});

test("isAuxiliaryRequest: any recognized message (at any position) keeps it main-line — front-trim/edit/retry continuation (#1309 fail-safe)", () => {
    const s = makeSession();
    establishResendLatch(s);
    // Front-trimmed tail + one new message: carries a recognized identity
    // (not at position 0 — the client trimmed ahead of it) → legitimate
    // divergence, full pipeline, never isolation.
    const overlapping = openaiBody([{ role: "user", content: "main three" }, { role: "user", content: "totally new" }]);
    assert.equal(isAuxiliaryRequest("openai", overlapping, s), false, "a resending client is a main turn even at 2 messages");
    // A role-flipped resend is NEW content under the kernel's own identity
    // contract (deriveMessageId hashes `${role}|${contentType}|...|${text}`),
    // so classifying it as novel is consistent with how the pipeline sees it.
    const roleMismatch = openaiBody([{ role: "assistant", content: "main one" }]);
    assert.equal(isAuxiliaryRequest("openai", roleMismatch, s), true, "role is part of message identity (kernel deriveMessageId)");
});

test("isAuxiliaryRequest: non-empty tools array marks a main turn (#546)", () => {
    const s = makeSession();
    establishResendLatch(s);
    const body = openaiBody([{ role: "user", content: "novel" }], { tools: [{ type: "function", function: { name: "bash" } }] });
    assert.equal(isAuxiliaryRequest("openai", body, s), false);
});

test("isAuxiliaryRequest: more than 2 messages are never auxiliary", () => {
    const s = makeSession();
    establishResendLatch(s);
    const body = openaiBody([
        { role: "user", content: "novel a" },
        { role: "assistant", content: "novel b" },
        { role: "user", content: "novel c" },
    ]);
    assert.equal(body.messages.length, AUXILIARY_MAX_MESSAGES + 1);
    assert.equal(isAuxiliaryRequest("openai", body, s), false);
});

test("isAuxiliaryRequest: repeated identical aux request stays auxiliary (retries do not self-promote)", () => {
    const s = makeSession();
    establishResendLatch(s);
    const body = openaiBody([{ role: "user", content: "SYNTHETIC retry" }]);
    assert.equal(isAuxiliaryRequest("openai", body, s), true);
    assert.equal(isAuxiliaryRequest("openai", body, s), true, "aux requests never update the reference view");
});

test("extractWireTexts: multi-part content arrays join text parts and skip non-text", () => {
    const texts = extractWireTexts("openai", openaiBody([
        { role: "user", content: [{ type: "text", text: "part one" }, { type: "image_url", image_url: { url: "http://x/y.png" } }, { type: "text", text: "part two" }] },
        { role: "assistant", content: "plain" },
    ]));
    assert.deepEqual(texts, [
        { role: "user", text: "part one\npart two" },
        { role: "assistant", text: "plain" },
    ]);
});

test("extractWireTexts: unrecognized shapes return undefined (fail-safe to main-line)", () => {
    assert.equal(extractWireTexts("openai", { model: "gpt" }), undefined);
    assert.equal(extractWireTexts("openai", { messages: [{ role: 42 }] }), undefined);
    assert.equal(extractWireTexts("responses", { input: { weird: true } }), undefined);
    assert.deepEqual(extractWireTexts("responses", { input: "just a string" }), [{ role: "user", text: "just a string" }]);
});

test("extractWireTexts: responses and google wire shapes", () => {
    const resp = extractWireTexts("responses", { input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "function_call_output", call_id: "c1", output: "x" },
    ] });
    assert.deepEqual(resp, [
        { role: "user", text: "hello" },
        { role: "function_call_output", text: "" },
    ]);
    const google = extractWireTexts("google", { contents: [{ role: "user", parts: [{ text: "g1" }, { text: "g2" }] }] });
    assert.deepEqual(google, [{ role: "user", text: "g1\ng2" }]);
});

function maxRefNum(s: Session): number {
    return Math.max(...Object.keys(s.state.messageRefs.byRef).map((r) => Number(r.slice(1))));
}

function makeHarness(): Promise<{ url: string; calls: Array<{ raw: string }>; close: () => Promise<void> }> {
    const WINDOW = 10_000;
    const SUMMARY_TEXT =
        "PREFLIGHT SUMMARY of the folded segment: multi-step debugging work on the billing pipeline. " +
        "Key decisions: chose retry with backoff over fail-fast because upstream flakiness was intermittent. " +
        "Files touched: src/a.ts:10, src/b.ts:20. Outcome: verified green.";
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
    return new Promise((resolve) => {
        upstream.listen(0, "127.0.0.1", () => {
            const upstreamPort = upstream.address().port;
            void (async () => {
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
                    sessionHeader: "x-acp-session",
                    log: false,
                    debug: false,
                    passthrough: false,
                    autoUpdate: false,
                    mitm: { enabled: false, domains: [] },
                } as ProxyOptions);
                await once(proxy, "listening");
                const proxyPort = proxy.address().port;
                resolve({
                    url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
                    calls,
                    close: async () => {
                        proxy.close();
                        await once(proxy, "close");
                        upstream.close();
                        await once(upstream, "close");
                    },
                });
            })();
        });
    });
}

function msg(i: number, tag: string): { role: string; content: string } {
    return { role: i % 2 === 0 ? "user" : "assistant", content: `${tag}_${i}_payload_`.repeat(180) };
}

test("#1309 e2e openai-wire: normal-budget auxiliary requests stay off the pipeline", async () => {
    const h = await makeHarness();
    const SID = "aux-route-e2e-sess";
    const orig = Array.from({ length: 24 }, (_, i) => msg(i, "FILLER"));
    const post = (body: Record<string, unknown>): Promise<{ status: number }> =>
        fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": SID }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status }));

    try {
        const r1 = await post(openaiBody(orig));
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 24, "turn 1 assigned refs to all 24 messages");
        assert.ok(sess.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");
        const origRefs = new Map(Object.entries(sess.state.messageRefs.byRaw));

        // Turn 2 re-sends turn 1 verbatim + one new message: a normal agent
        // turn that sets the resend latch arming auxiliary classification.
        const tail = { role: "user", content: "TAIL_25_payload" };
        const r2 = await post(openaiBody([...orig, tail]));
        assert.equal(r2.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(maxRefNum(sess), 25, "turn 2 (overlap) ran the pipeline and consumed one ref");
        const ctxBeforeStorm = sess.stats.contextTokens;

        // Three DISTINCT normal-budget auxiliary prompts (the DSH auto-review
        // storm shape: 1 fresh message, no tools, healthy max_tokens).
        for (let i = 1; i <= 3; i++) {
            const r = await post(openaiBody([{ role: "user", content: `AUXREVIEW_${i}_synthetic_prompt_payload` }]));
            assert.equal(r.status, 200, `aux request ${i} forwarded`);
        }
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(Object.keys(sess.state.messageRefs.byRaw).length, 25, "aux requests consume no refs");
        assert.equal(maxRefNum(sess), 25, "ref cursor untouched by aux requests");
        assert.equal(sess.metadata.compactionBoundary, undefined, "aux requests mark no compaction boundary");
        assert.equal(sess.lastMessages?.length, 25, "snapshot/export view not clobbered by the 1-message aux views");
        assert.equal(sess.stats.contextTokens, ctxBeforeStorm, "usage/nudge baseline untouched by aux requests");
        assert.ok(sess.state.blocks.some((b) => b.active), "block survived 3 consecutive aux requests (pre-fix: reaped silently on the 3rd)");
        const auxForward = h.calls.filter((c) => c.raw.includes("AUXREVIEW_1_synthetic"));
        assert.equal(auxForward.length, 1, "aux request reached the upstream exactly once");
        assert.ok(!auxForward[0]!.raw.includes("\x3cacp "), "forwarded verbatim — no tag/nudge injection on the aux lane");

        // A retry of the SAME aux body must not self-promote to main-line.
        const rRetry = await post(openaiBody([{ role: "user", content: "AUXREVIEW_1_synthetic_prompt_payload" }]));
        assert.equal(rRetry.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(maxRefNum(sess), 25, "retried aux request still consumes no ref");

        // Legitimate short follow-up (resends history verbatim + 1 new message)
        // MUST keep running the full pipeline — the false-positive guard.
        const followUp = [orig[22]!, orig[23]!, { role: "user", content: "FOLLOWUP_legitimate_new_user_message" }];
        assert.equal(followUp.length, 3);
        const rFollow = await post(openaiBody(followUp));
        assert.equal(rFollow.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        assert.equal(maxRefNum(sess), 26, "overlapping short turn ran the pipeline and consumed one ref");

        // Full-history replay: original refs intact, exactly one new ref, no snowball.
        const replay = [...orig, tail, { role: "user", content: "MORE_99_payload" }];
        const r3 = await post(openaiBody(replay));
        assert.equal(r3.status, 200);
        sess = listSessions().find((s) => s.id === SID)!;
        for (const [rawId, ref] of origRefs) {
            assert.equal(sess.state.messageRefs.byRaw[rawId], ref, `original ${ref} kept its ref across the aux storm`);
        }
        assert.equal(maxRefNum(sess), 27, "replay assigns exactly one new ref — no snowball");
        const refVals = Object.values(sess.state.messageRefs.byRef);
        assert.equal(new Set(refVals).size, refVals.length, "no duplicate refs");
        assert.ok(sess.state.blocks.some((b) => b.active), "turn-1 block still anchored after the replay");
        const fwd = h.calls.filter((c) => !/TASK: The conversation segment below/.test(c.raw)).pop()!;
        assert.ok(fwd.raw.includes("PREFLIGHT SUMMARY of the folded segment"), "rebuilt payload still carries the preflight summary");
        assert.ok(fwd.raw.includes("MORE_99_payload"), "new tail survives in the payload");
    } finally {
        await h.close();
    }
});

test("#1309 e2e plugin-mode: auxiliary requests do not clobber the remembered anchor view (#1307 repro)", async () => {
    const h = await makeHarness();
    const SID = "aux-plugin-e2e-sess";
    const orig = Array.from({ length: 24 }, (_, i) => msg(i, "PFILLER"));
    const headers = { "content-type": "application/json", "x-acp-session": SID, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": SID };
    const post = (body: Record<string, unknown>): Promise<{ status: number }> =>
        fetch(h.url, { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status }));
    try {
        const r1 = await post(openaiBody(orig));
        assert.equal(r1.status, 200);
        // Turn 2 re-sends turn 1 verbatim + one new message: sets the resend
        // latch so subsequent novel short views are classified as auxiliary.
        const ptail = { role: "user", content: "PTAIL_25_payload" };
        const r2 = await post(openaiBody([...orig, ptail]));
        assert.equal(r2.status, 200);
        let mem = _rememberedForTest().get(SID);
        assert.ok(mem, "main turns remembered the anchor view");
        assert.equal(mem!.original.length, 25, "remembered view covers the full 25-message main view");
        assert.ok((mem!.original[0]?.text ?? "").startsWith("PFILLER_0_payload_"), "anchor view starts at the first main message");

        for (let i = 1; i <= 3; i++) {
            const r = await post(openaiBody([{ role: "user", content: `PAUXREVIEW_${i}_synthetic_review_blob_`.repeat(50) }]));
            assert.equal(r.status, 200);
        }
        mem = _rememberedForTest().get(SID);
        assert.ok(mem && mem.original.length === 25, "#1307: the remembered anchor view must survive consecutive normal-budget aux requests (pre-fix: clobbered to the 1-message review view, compress failed 163/163)");
        assert.ok((mem?.original[0]?.text ?? "").startsWith("PFILLER_0_payload_"), "anchor head not replaced by aux content");

        const sess = listSessions().find((s) => s.id === SID)!;
        assert.ok(sess.state.blocks.some((b) => b.active), "blocks survive the aux storm in plugin mode too");
    } finally {
        await h.close();
    }
});
