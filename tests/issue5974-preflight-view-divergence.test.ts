import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, estimateCoreMessages, type PreflightDeps } from "../src/preflight.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #5974 (#4543-①): the preflight walk judges fit on its own BLIND view —
// processTurn on the client re-send, the same array every round — while the
// outbound body comes from the full pipeline rebuild (snapshot render,
// fold-reconcile repair, reasoning drop, wire render). Under switch-pass id
// churn the two pipelines disagree: the view declares "fits" while the
// reconstruction measures over the window, so every turn under-folds by the
// divergence and the session crawls forward ~5k tokens at a time at the
// window edge. The fix forces the fit judgment through the post-reconstruction
// single source of truth (issue expectation clause ②): the caller measures the
// fresh rebuild, and when it exceeds the view by a material amount the bounded
// corrective second pass runs with that measured divergence as its exit bar
// (`viewDeltaCorrection`). Absent/zero correction must stay byte-identical to
// the legacy walk.
//
// Pinned both directions (#3617):
//   case 1 — legacy baseline: no correction → early-fit exit on the blind view
//            (failure undefined, fitsWindow true, foldable pool left behind);
//   case 2 — positive: a correction larger than the blind-fit residual keeps
//            the walk folding until the CORRECTED scale fits (strictly more
//            ranges than case 1, corrected total under the window);
//   case 3 — negative bound: a correction no amount of folding can absorb
//            never yields a declared fit (the legacy walk would have stopped
//            at the blind fit and declared one); the #1841 futility discipline
//            may legitimately bail early on the corrected scale;
//   case 4 — safe default: an explicit zero correction reproduces case 1
//            field-for-field (delta=0 ⇒ byte-identical legacy);
//   case 5 — full-server common path: a plain-lane request that folds to fit
//            in one pass still forwards exactly once with the new
//            probe/corrective plumbing in place (divergence below the noise
//            floor → no corrective pass, probe rebuild reused).
//
// All token math is ASCII filler at the host estimator's rate; the fixture
// self-checks its own overflow so a drifted estimator fails loudly instead of
// silently de-sizing the scenario.

const LIMIT = 40_000;
// ~30 chars of summary ≈ tens of tokens — comfortably above minSummaryLength,
// negligible against a 9K-token range.
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";
// 4 foldable ranges of 36K chars each (≈8–10K tok) separated by hard-protected
// bash pairs (≈2.2K tok each), short open tail. Entry ≈ 1.1–1.2× the window
// (deliberately below the entry-overshoot escalation regime), foldable pool ≈
// 36–40K tok — enough for the corrected passes below, scarce enough that the
// blind view fits after ONE fold.
const RANGE_CHARS = 36_000;
const BASH_CHARS = 8_000;
// Case 2: bigger than the post-blind-fit residual margin (~0.6–4K across
// estimator rates) → forces exactly one additional fold.
const DELTA_CORRECTED_FIT = 8_000;
// Case 3: bigger than the ENTIRE pool's savings (~36K) → no corrected fit is
// reachable; the walk must exhaust instead of claiming one.
const DELTA_EXHAUSTION = 36_000;

function makeUpstream(): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            // Every request reaching this mock is a summarization call — the
            // unit cases never forward a payload.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({ server, port: (server.address() as { port: number }).port }));
}

function coreMessages(tag: string): CoreMessage[] {
    let i = 0;
    const nid = (): string => `${tag}-m${++i}`;
    const text = (role: "user" | "assistant", s: string): CoreMessage => ({ id: nid(), role, contentType: "text", text: s });
    const bashPair = (n: number): CoreMessage[] => [
        { id: nid(), role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: `${tag}-call${n}`, text: "{}" },
        { id: nid(), role: "tool", contentType: "tool-result", toolCallId: `${tag}-call${n}`, text: `BASH_RESULT_${n}_`.repeat(Math.floor(BASH_CHARS / 14)) },
    ];
    const range = (mark: string): CoreMessage[] => [
        text("user", mark.repeat(Math.floor(RANGE_CHARS / mark.length))),
        text("assistant", `ack-${mark[0].toLowerCase()}`),
    ];
    return [
        ...range("OLD_WORK_A "),
        ...bashPair(1),
        ...range("OLD_WORK_B "),
        ...bashPair(2),
        ...range("OLD_WORK_C "),
        ...bashPair(3),
        ...range("OLD_WORK_D "),
        ...bashPair(4),
        text("user", "ok"),
        text("assistant", "done"),
    ];
}

const CONFIG = defaultConfig(LIMIT, {
    preserveRecentMessages: 2,
    preserveRecentTokens: 200,
    protectedTools: ["bash"],
    compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
});

const core = createCore();

function makeDeps(sessionId: string, port: number, extra?: Partial<PreflightDeps>): PreflightDeps {
    return {
        core,
        session: getSession(sessionId),
        config: CONFIG,
        compressReason: "overflow",
        prompts: defaultPrompts,
        protocol: "openai",
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        headers: { "content-type": "application/json" },
        model: "gpt-test",
        log: () => {},
        ...extra,
    };
}

_setStoreForTest(new SessionStore({ enabled: false }));

let legacyBaseline: Awaited<ReturnType<typeof preflightCompress>>;

test("#5974 case 1 (legacy baseline): without correction the walk exits at the blind-view fit, leaving the pool behind", async () => {
    const up = await makeUpstream();
    try {
        const est0 = estimateCoreMessages(coreMessages("c1"));
        assert.ok(est0 > LIMIT, `fixture must overflow the window (${est0} vs ${LIMIT})`);
        const r = await preflightCompress(makeDeps("issue5974-case1", up.port), coreMessages("c1"));
        assert.equal(r.failure, undefined, "an early-fit exit leaves no failure verdict");
        assert.equal(r.fitsWindow, true, "the blind view declares a fit");
        assert.ok(r.compressedRanges >= 1 && r.compressedRanges <= 2, `the small deficit needs at most two folds, got ${r.compressedRanges}`);
        assert.ok(r.rangesRemaining > 0, "foldable pool must remain after the blind fit");
        legacyBaseline = r;
    } finally {
        up.server.close();
        await once(up.server, "close");
    }
});

test("#5974 case 2 (positive): a measured view/rebuild divergence keeps the walk folding until the CORRECTED scale fits", async () => {
    const up = await makeUpstream();
    try {
        const r = await preflightCompress(makeDeps("issue5974-case2", up.port, { viewDeltaCorrection: DELTA_CORRECTED_FIT }), coreMessages("c2"));
        assert.equal(r.failure, undefined, "the corrected walk reaches a genuine corrected-scale fit");
        assert.equal(r.fitsWindow, true, "fitsWindow reflects the corrected scale");
        assert.ok(r.payloadEstimate + DELTA_CORRECTED_FIT < LIMIT, `corrected total must sit under the window: ~${Math.round(r.payloadEstimate)}+${DELTA_CORRECTED_FIT} vs ${LIMIT}`);
        assert.ok(r.compressedRanges > legacyBaseline.compressedRanges, `the corrected pass must fold strictly more than the blind pass (${r.compressedRanges} vs ${legacyBaseline.compressedRanges})`);
        assert.ok(r.payloadEstimate <= legacyBaseline.payloadEstimate, "the corrected view can only shrink relative to the blind one");
    } finally {
        up.server.close();
        await once(up.server, "close");
    }
});

test("#5974 case 3 (negative bound): a divergence no folding can absorb never yields a declared fit", async () => {
    const up = await makeUpstream();
    try {
        const r = await preflightCompress(makeDeps("issue5974-case3", up.port, { viewDeltaCorrection: DELTA_EXHAUSTION }), coreMessages("c3"));
        // The #1841 futility discipline runs on the corrected scale too: when
        // the pool provably cannot close gap+Δ the walk bails early instead of
        // burning summary calls — so the pin is the VERDICT, not the call
        // count. Legacy code would have exited at the blind fit (no failure,
        // fit declared); the corrected walk must say the reconstruction still
        // overflows.
        assert.equal(r.fitsWindow, false, "the corrected scale cannot fit — the walk must not declare a fit");
        // The mock upstream never transiently fails and no client signal aborts
        // this call, so any failure here must be the honest exhaustion verdict
        // — pin the KIND, not just the presence, so a future regression that
        // misclassifies the bail as a relay failure ("upstream") or an abort is
        // caught.
        assert.ok(r.failure === undefined || r.failure.kind === "exhausted", `an unabsorbable divergence must surface as an honest exhaustion verdict, never a relay-failure misclassification (got ${r.failure?.kind ?? "none"})`);
    } finally {
        up.server.close();
        await once(up.server, "close");
    }
});

test("#5974 case 4 (safe default): an explicit zero correction reproduces the legacy walk field-for-field", async () => {
    const up = await makeUpstream();
    try {
        const r = await preflightCompress(makeDeps("issue5974-case4", up.port, { viewDeltaCorrection: 0 }), coreMessages("c4"));
        assert.equal(r.compressedRanges, legacyBaseline.compressedRanges, "same folds as the uncorrected walk");
        assert.equal(r.payloadEstimate, legacyBaseline.payloadEstimate, "same final estimate as the uncorrected walk");
        assert.equal(r.fitsWindow, legacyBaseline.fitsWindow, "same fit verdict as the uncorrected walk");
        assert.equal(r.failure, legacyBaseline.failure, "same verdict as the uncorrected walk");
    } finally {
        up.server.close();
        await once(up.server, "close");
    }
});

// ---------------------------------------------------------------------------
// Case 5 — full-server common path (startServer + mock upstream, #1841-style
// harness): the new probe/corrective plumbing must leave the happy path
// untouched. The payload folds to fit in ONE pass; the probe rebuild then
// measures at or under the window, so the inner gate (probe ≥ limit AND
// divergence ≥ noise floor) can never fire — exactly one forward, nothing
// doubled.
type Call = { summary: boolean; raw: string };
let CALLS: Call[] = [];

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockForwardingUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            if (!isSummary) {
                if (raw.includes('"stream":true')) {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(chatSse("forwarded answer", "stop"));
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-fwd", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "forwarded answer" }, finish_reason: "stop" }] }));
                }
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
        });
    });
}

async function bootE2E(): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockForwardingUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: LIMIT } } } } as ProxyOptions["routes"],
        modelContextLimit: LIMIT,
        kernelConfig: defaultConfig(LIMIT, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

test("#5974 case 5 (full server, common path): a one-pass fold-to-fit still forwards exactly once with the probe/corrective plumbing in place", async () => {
    CALLS = [];
    const p = await bootE2E();
    try {
        // #1841-control sizing: four 4.4K-tok plain runs (foldable pool 17.6K)
        // over two hard-protected bash bulk pairs — the payload clears the
        // window after a handful of folds, so the walk exits early-fit in ONE
        // pass and the probe rebuild measures at-or-under the window.
        const REPEAT = 2127;
        const messages: Array<Record<string, unknown>> = [
            { role: "user", content: "OLD_WORK_A ".repeat(1600) },
            { role: "assistant", content: "ANSWER_A ".repeat(1600) },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
            { role: "tool", tool_call_id: "call_1", content: `BASH_RESULT_1_payload_`.repeat(REPEAT) },
            { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
            { role: "tool", tool_call_id: "call_2", content: `BASH_RESULT_2_payload_`.repeat(REPEAT) },
            { role: "user", content: "OLD_WORK_B ".repeat(1600) },
            { role: "assistant", content: "ANSWER_B ".repeat(1600) },
            { role: "user", content: "ok" },
            { role: "assistant", content: "done" },
        ];
        const resp = await fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue5974-common-path" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });
        const body = await resp.text();
        assert.equal(resp.status, 200, `a one-pass fold-to-fit must forward: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.equal(CALLS.filter((c) => !c.summary).length, 1, `exactly ONE forwarded request (got ${CALLS.filter((c) => !c.summary).length}) — no corrective pass may fire when the rebuild fits`);
        assert.ok(CALLS.filter((c) => c.summary).length >= 1, "the walk must have summarized at least one range");
    } finally {
        await p.cleanup();
    }
});
