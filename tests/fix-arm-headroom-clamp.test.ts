import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { inspectContextOverflow, reserveOutputHeadroom } from "../src/util.ts";

// A live limb against a 1,048,576-window upstream hit an unbounded 400 loop:
//
//   upstream HTTP 400
//   {"error":{"message":"This model's maximum context length is 1048576 tokens.
//     However, you requested 1097304 tokens (841304 in the messages, 256000 in
//     the completion). Please reduce the length of the messages or completion."}}
//
// Arithmetic against the shipped code:
//   reserveOutputHeadroom(1_048_576, 256_000, 0.25)  // util.ts:355
//     cap*window = 0.25 * 1_048_576 = 262_144
//     reserved   = min(256_000, 262_144) = 256_000
//     → effective judging window = 792_576            (handle.ts:2108 → 2137)
//   messages 841_304 exceed that by 48_728, so bili KNEW the payload did not
//   fit (server.ts:3143 payloadFitsWindow === false, :3067 triggerFires === true)
//   and forwarded it anyway (the :3102 estimate-only forward-once probe).
//
// The recovery path then failed to converge: the armed meter fed preflight's
// baseline floor as 1_048_576 while its target was the reserved 792_576, so the
// fold walk demanded more savings than the payload could pay and every turn
// failed instead of folding down to fit — 400/fail, re-arm, forever.
//
// The fix clamps the arm to min(stated, reserved), so an arm only ever lands at
// or below the limit the kernel actually judges against.

const WINDOW = 1_048_576;
const MAX_OUTPUT = 256_000;
const CAP_PCT = 0.25; // DEFAULT_OUTPUT_HEADROOM_MAX_PCT (util.ts:327)

const REJECT_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1097304 tokens (841304 in the messages, 256000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
    },
});

// The user's real payload: 841,304 tokens of messages. The test only needs the
// request to be large enough that preflight's trigger fires, so build a body of
// a realistic size with a max_tokens in the same shape as the limb's.
function bigMessages(): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    // ~48,730 tokens over the reserved judging limit (792,576), i.e. the limb's
    // exact overage, expressed at ~4 B/token.
    const target = 48_730 * 4;
    const per = 4_000;
    for (let n = 0; n * per < target; n++) {
        messages.push({
            role: n % 2 === 0 ? "user" : "assistant",
            content: `turn ${n}: ` + "f".repeat(per - 20),
        });
    }
    return messages;
}

type Call = { chars: number; usage: number | null };

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let chars = 0;
            let usage: number | null = null;
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
                const parsed = JSON.parse(raw) as {
                    messages?: Array<{ content?: unknown }>;
                    max_tokens?: number;
                };
                chars = (parsed.messages ?? []).reduce(
                    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
                    0,
                );
                if (typeof parsed.max_tokens === "number") usage = parsed.max_tokens;
            } catch {
                /* keep the zeroed counts; the body is unparseable */
            }
            calls.push({ chars, usage });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(REJECT_BODY);
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(
        proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }),
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
        },
        calls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

type Ctx = { url: string; headers: Record<string, string> };

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages, max_tokens: MAX_OUTPUT }),
    });

test("the stated-window arm is clamped to the headroom-reserved judging limit", async () => {
    const { ctx, calls, close } = await setup();

    // The reservation the shipped code computes for this exact limb.
    const reserved = reserveOutputHeadroom(WINDOW, MAX_OUTPUT, CAP_PCT);
    assert.equal(reserved, WINDOW - MAX_OUTPUT, "sanity: 1,048,576 - 256,000 = 792,576");
    assert.equal(MAX_OUTPUT, 256_000);
    assert.ok(CAP_PCT * WINDOW >= MAX_OUTPUT, "sanity: 0.25 * 1,048,576 = 262,144 caps at maxOutput");

    // The upstream really did state 1,048,576 in the rejection body.
    const info = inspectContextOverflow(400, REJECT_BODY);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, WINDOW);

    ctx.headers["x-acp-session"] = "limb-arm-clamp";
    await post(ctx, bigMessages());

    const s = getSession("limb-arm-clamp");
    assert.ok(s, "session exists after the upstream 400");

    // The arm must be upstream-truth AND fit under the judging limit. Before
    // the fix it was `info.window` (1,048,576) — strictly above `reserved`
    // (792,576) — so no nudge band could ever fire and the client kept
    // re-sending the same oversized payload into the same 400.
    assert.equal(
        s.stats.lastInputTokensSource,
        "overflow-arm",
        "the rejection must arm the emergency shrink baseline",
    );
    assert.ok(
        s.stats.lastInputTokens < WINDOW,
        `arm ${s.stats.lastInputTokens} must sit BELOW the stated window ${WINDOW}`,
    );
    // The reserved judging limit, read exactly the way relay.ts does (#4205:
    // per-request twin of the unreserved display window; `metadata` values are
    // typed loosely, so narrow before comparing).
    const judgingLimit =
        typeof s.metadata.reservedContextLimit === "number" && s.metadata.reservedContextLimit > 0
            ? s.metadata.reservedContextLimit
            : typeof s.metadata.effectiveContextLimit === "number" && s.metadata.effectiveContextLimit > 0 ? s.metadata.effectiveContextLimit : 0;
    assert.ok(judgingLimit > 0, "handle must have recorded the reserved judging limit");
    assert.ok(
        s.stats.lastInputTokens <= judgingLimit,
        `arm ${s.stats.lastInputTokens} must be ≤ the judging limit ${judgingLimit} — ` +
            "an arm above it can never trigger the fold it exists to cause",
    );
    assert.equal(
        s.stats.lastInputTokens,
        reserved,
        "this limb: the clamp is exactly the headroom reservation",
    );
    // Since #3450 the guard input intentionally diverges from the nudge
    // baseline: it keeps the RAW stated ceiling because the side-request
    // guard reserves each request's own output FROM this value itself —
    // feeding it the pre-reserved limit would double-subtract the headroom.
    assert.equal(
        s.stats.overflowArmTokens,
        WINDOW,
        "guard keeps the stated ceiling — it self-reserves headroom (#3450)",
    );

    // The request that produced the rejection must actually have carried the
    // output budget that causes the reservation — otherwise the test would be
    // asserting the clamp on a session with no headroom at all.
    assert.ok(calls.length > 0, "the upstream was reached");
    assert.equal(calls[0].usage, MAX_OUTPUT, "the forwarded request carried max_tokens 256,000");

    await close();
});

test("the stated-window arm is the upstream truth when no headroom reservation applies", async () => {
    const { ctx, calls, close } = await setup();

    // No output budget on the wire and none resolvable from the registry →
    // reserveOutputHeadroom is a no-op and the judging limit IS the declared
    // window. The clamp must not silently shrink the arm in that case: the
    // upstream-stated number is the strongest evidence available.
    const reserved = reserveOutputHeadroom(WINDOW, 0, CAP_PCT);
    assert.equal(reserved, WINDOW, "sanity: no output budget → no reservation");

    ctx.headers["x-acp-session"] = "limb-arm-unreserved";
    // Deliberately NO max_tokens — this is the control case.
    await fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages: bigMessages() }),
    });

    const s = getSession("limb-arm-unreserved");
    assert.ok(s, "session exists after the upstream 400");
    assert.equal(s.stats.lastInputTokensSource, "overflow-arm");
    assert.equal(
        s.metadata.effectiveContextLimit,
        WINDOW,
        "control: with no output budget no headroom reservation is recorded",
    );
    // Since #3450 the stated MESSAGE COUNT is booked when the body carries
    // one — stronger upstream evidence than the ceiling. The no-reservation
    // clamp stays a no-op: nothing is ever shrunk below the measurement.
    assert.equal(
        s.stats.lastInputTokens,
        841_304,
        "with no reservation the arm books the stated message count (≤ the stated window)",
    );
    assert.ok(calls.length > 0, "the upstream was reached");
    assert.notEqual(calls[0].usage, MAX_OUTPUT, "control: no max_tokens was forwarded");

    await close();
});



// --- Case 3: the recovery the clamp restores — same-request rescue, then
//     next-turn convergence ---
//
// Cases 1-2 pin the invariant (arm <= judging limit). This case pins the
// BEHAVIOR that invariant exists for: after an overflow 400 arms the shrink,
// the payload gets folded down to the reserved judging limit and the forward
// succeeds — instead of looping on 400s.
//
// Since #3450 the 400 body's stated counts sharpen that recovery: the
// same-request refold folds against window − proven completion share (not the
// bare window), so when the provider bills messages+completion against one
// wall, the REJECTED request itself is rescued (the client sees the retry's
// 200, not the 400); the next turn then converges on the stored folds.
// (Pre-#3450 the refold targeted the bare window, the completion share pushed
// the retry back over the wall, and the 400 surfaced until the next turn.)
//
// The mock prices ~10% denser than the proxy's own estimator
// (defaultCountTokens * 1.1): the class of provider-vs-heuristic tokenizer
// divergence that let the live limb's real payload (841,304 tokens) exceed
// what the planner believed (<= 792,576) and ride the #453 max_tokens clamp
// uncapped. After such a rejection the ARM is the only upstream-proven anchor
// bili holds; sitting above the judging limit, it makes the next turn's fold
// walk demand phantom savings that the payload cannot pay.

const CONVERGE_WINDOW = 100_000;
const CONVERGE_MAX_OUTPUT = 60_000;
const CONVERGE_CAP_PCT = 0.9; // compress.outputHeadroomMaxPct
const CONVERGE_LIMIT = 40_000; // reserved judging limit = 100,000 - 60,000
const CONVERGE_TOLERANCE = 4_000; // acceptance band: priced + max_tokens <= window + tol

const CONVERGE_REJECT_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 100000 tokens. However, you requested 160000 tokens (100000 in the messages, 60000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
    },
});
const CONVERGE_HICCUP_BODY = JSON.stringify({ error: { message: "upstream relay hiccup", type: "server_error" } });
const CONVERGE_SUMMARY_TEXT = "CONVERGE-FOLD-SUMMARY covering the earliest folded turns of this session";

function convergeSmall(): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 4; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `SMALLMARKER_${i}_`.repeat(80) });
    }
    return out;
}

function convergeBig(): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 24; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `MARKER_${i}_content_`.repeat(880) });
    }
    return out;
}

function convergeSummaryJson(): string {
    return JSON.stringify({
        id: "cs",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: CONVERGE_SUMMARY_TEXT }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });
}

type CCall = { raw: string; stream: boolean; maxTok: number };

function convergeUpstream(): { server: http.Server; calls: CCall[] } {
    let mainSeen = 0;
    const calls: CCall[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = {};
            }
            const stream = parsed.stream === true;
            const maxTok = typeof parsed.max_tokens === "number" ? (parsed.max_tokens as number) : 0;
            const messages = Array.isArray(parsed.messages) ? (parsed.messages as Array<{ content?: unknown }>) : [];
            // Provider-side pricing runs ~10% denser than the proxy's own
            // estimator — see the case header for why that gap matters.
            const priced = messages.reduce(
                (n, m) => n + (typeof m.content === "string" ? Math.ceil(defaultCountTokens(m.content) * 1.1) : 0),
                0,
            );
            calls.push({ raw, stream, maxTok });
            // Nudge-decide probes carry a tiny output budget — answer no-fold.
            if (maxTok <= 200) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ compress: false }));
                return;
            }
            // bili's own preflight summary probes are non-streaming completions.
            if (!stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(convergeSummaryJson());
                return;
            }
            mainSeen += 1;
            if (mainSeen === 1) {
                // Transient relay hiccup on the first turn: it arms the
                // estimate baseline (source "estimate") that lets the big turn
                // below take the forward-once-for-evidence path instead of
                // folding first — the incident's entry regime.
                res.writeHead(500, { "content-type": "application/json" });
                res.end(CONVERGE_HICCUP_BODY);
                return;
            }
            // Enforce the stated window like the real upstream does.
            if (priced + maxTok > CONVERGE_WINDOW + CONVERGE_TOLERANCE) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(CONVERGE_REJECT_BODY);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5000, completion_tokens: 3, total_tokens: 5003 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    return { server, calls };
}

test("stated-count overflow is rescued within the SAME request, then converges next turn (the recovery #3450 restores)", async (t) => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = convergeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${uPort}`]: { models: { "gpt-converge": { context: CONVERGE_WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: CONVERGE_WINDOW,
        kernelConfig: defaultConfig(CONVERGE_WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true, outputHeadroomMaxPct: CONVERGE_CAP_PCT },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const pPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${pPort}/bili/http://127.0.0.1:${uPort}/chat/completions`;
    const headers = { "content-type": "application/json", "x-acp-session": "limb-arm-converge" };
    const close = async (): Promise<void> => {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
    };
    t.after(close);
    const post = (messages: Array<{ role: string; content: string }>) =>
        fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-converge", stream: true, messages, max_tokens: CONVERGE_MAX_OUTPUT }),
        });

    const reserved = reserveOutputHeadroom(CONVERGE_WINDOW, CONVERGE_MAX_OUTPUT, CONVERGE_CAP_PCT);
    assert.equal(reserved, CONVERGE_WINDOW - CONVERGE_MAX_OUTPUT, "sanity: 100,000 - 60,000 = 40,000");

    // Turn 0: a transient hiccup arms the estimate baseline.
    const r0 = await post(convergeSmall());
    assert.equal(r0.status, 500, "the hiccup passes through verbatim");
    await r0.arrayBuffer();
    let s = getSession("limb-arm-converge");
    assert.ok(s, "session exists after the 500");
    assert.equal(s.stats.lastInputTokensSource, "estimate", "armFailureShrink arms the estimate baseline");
    assert.ok(s.stats.lastInputTokens > 0, "the estimate baseline is positive");

    // Turn 1: the oversized turn rides the forward-once-for-evidence path
    // (estimate baseline, no usage-grade floor) and hits the real 400. The
    // same-request refold then folds against window − proven completion share
    // (100,000 − 60,000 = 40,000 here — the same number as the clamped judging
    // limit), so the retry fits the mock's acceptance band and the client sees
    // the rescue's 200 instead of the 400.
    const r1 = await post(convergeBig());
    assert.equal(r1.status, 200, "the stated-count refold rescues the request in-flight");
    await r1.arrayBuffer();
    {
        const mains = calls.filter((c) => c.stream);
        const r1fwd = mains[mains.length - 1];
        assert.ok(r1fwd.raw.includes(CONVERGE_SUMMARY_TEXT), "the folded summary rides the retry wire");
        assert.ok(r1fwd.raw.includes("MARKER_23_"), "the recent tail survives the fold");
        let distinct = 0;
        for (let i = 0; i < 24; i++) {
            if (r1fwd.raw.includes(`MARKER_${i}_content_`)) distinct += 1;
        }
        assert.ok(
            distinct <= 12,
            `substantial folding expected: ${distinct}/24 conversation turns still raw on the wire`,
        );
    }
    s = getSession("limb-arm-converge");
    assert.ok(s, "session survives the rescued turn");
    // The 400 armed the shrink (clamped baseline, ceiling guard, proven
    // reservation); the rescued response's usage report then retired the pair
    // in one settle — #3450's paired-retirement contract.
    assert.equal(s.stats.lastInputTokensSource, "usage", "the rescued usage report retires the arm");
    assert.ok(s.stats.lastInputTokens > 0, "the baseline is replaced by the real usage figure");
    assert.equal(s.stats.overflowArmTokens, undefined, "#1129: the arm sidecar retires with the arm");
    assert.equal(s.stats.overflowArmCompletionReserve, undefined, "#3450: the reservation retires with the arm");

    // Turn 2: the client re-sends the same history. The folds stored by the
    // in-flight rescue ride the reconciliation, the payload stays under the
    // reserved limit, and the forward succeeds again — no loop.
    const r2 = await post(convergeBig());
    assert.equal(r2.status, 200, "the next turn converges instead of looping");
    await r2.arrayBuffer();
    const mains = calls.filter((c) => c.stream);
    const r2fwd = mains[mains.length - 1];
    assert.ok(r2fwd.raw.includes(CONVERGE_SUMMARY_TEXT), "the folded summary rides the wire");
    assert.ok(r2fwd.raw.includes("MARKER_23_"), "the recent tail survives the fold");
    let distinct = 0;
    for (let i = 0; i < 24; i++) {
        if (r2fwd.raw.includes(`MARKER_${i}_content_`)) distinct += 1;
    }
    assert.ok(
        distinct <= 12,
        `substantial folding expected: ${distinct}/24 conversation turns still raw on the wire`,
    );
    s = getSession("limb-arm-converge");
    assert.ok(s, "session survives the successful turn");
    assert.equal(s.stats.lastInputTokensSource, "usage", "judging stays on real usage after the rescue");
    assert.equal(s.stats.overflowArmTokens, undefined, "no stale arm lingers past the settled usage");
    assert.equal(s.stats.overflowArmCompletionReserve, undefined, "no stale reservation lingers past the settled usage");

    await close();
});
