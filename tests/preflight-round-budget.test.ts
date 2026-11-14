import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// The preflight folds ONE range per round and caps a range at CHUNK_FRACTION of
// the window (src/preflight.ts), so the round budget is a hard limit
// on how far a payload can be brought down. A session that is well over the
// window and split into many small ranges (a long agent history is exactly
// that) needs a deep fold, and the per-invocation budget of 8 left a live
// 1.39M-token Gemini session ~8k tokens short of fitting: it reported "the
// compress budget was exhausted after 8 rounds" and dropped the turn even
// though every fold it attempted had succeeded. #1933 made the depth dynamic:
// base MAX_PREFLIGHT_ROUNDS scales with the entry overshoot (payload vs window),
// capped at 2x the base — an ~11x overshoot like the first fixture below gets
// the full raised budget of 32 rounds / 32 summary calls. The second fixture
// sits in the zone #5671's adaptive bound rescues-or-exposes: below the 19.2x
// entry trigger but hopeless in BOTH fold regimes, so the invocation flips to
// digests mid-flight, proves the doom deterministically, and answers 413
// non-retryable instead of spinning a relay-dependent 502.

const WINDOW = 30_000;
const MESSAGES = 60;
const FILLER_REPEATS = 300;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index, so the folded view keeps everything the work still needs and drops only repetition.";

const CALLS: { summary: boolean; raw: string }[] = [];

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

function longMessages(count: number, repeats: number): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [];
    for (let i = 0; i < count; i++) {
        messages.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i}: ` + `FILLER_${i}_payload_`.repeat(repeats),
        });
    }
    return messages;
}

function materialiseTokens(count: number, repeats: number): number {
    return Math.round(longMessages(count, repeats).reduce((n, m) => n + m.content.length, 0) / 4);
}

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            const text = isSummary ? SUMMARY_TEXT : "forwarded answer";
            // The preflight summary call is not streaming; answer it in the
            // shape it asked for (the wire branch handles the Gemini case where
            // the endpoint streams regardless — that is a different defect).
            if (raw.includes('"stream":true')) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse(text));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
            }
        });
    });
}

function proxyOptions(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
    };
}

test("e2e preflight: a payload that needs more folds than one round allows is still brought under the window", async () => {
    CALLS.length = 0;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const payloadTokens = materialiseTokens(MESSAGES, FILLER_REPEATS);
        assert.ok(payloadTokens > WINDOW, `fixture must start over the window (${payloadTokens} vs ${WINDOW})`);

        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "budget-deep-fold" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: longMessages(MESSAGES, FILLER_REPEATS) }),
        });
        const body = await resp.text();
        const summaries = CALLS.filter((c) => c.summary);
        const forwarded = CALLS.filter((c) => !c.summary);

        assert.equal(resp.status, 200, `an over-window turn must be folded and forwarded, not refused: HTTP ${resp.status} ${body.slice(0, 240)}`);
        assert.ok(summaries.length > 8, `this payload needs a deeper fold than one round allows, got ${summaries.length} summary call(s)`);
        assert.ok(summaries.length <= 24, `the fold must stay bounded, got ${summaries.length} summary call(s)`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.ok(forwarded.some((f) => f.raw.includes(SUMMARY_TEXT.slice(0, 30))), "the folded summary must replace a raw range on the wire");
        const markers = forwarded.reduce((n, f) => n + (f.raw.match(/FILLER_\d+_payload_/g) ?? []).length, 0);
        assert.ok(markers < MESSAGES * FILLER_REPEATS, `the fold must drop raw range text, still carried ${markers}`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e preflight: a pool hopeless in both fold regimes fails fast with a deterministic non-retryable verdict", async () => {
    CALLS.length = 0;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // 600 small turns (~482k tokens vs a 30k window, ~16x overshoot):
        // below the 19.2x entry trigger, so the invocation starts on the LLM
        // path and #5671's adaptive bound flips it to digests mid-flight — but
        // the pool is hopeless in BOTH regimes: the LLM budget covers far too
        // little mass, and even fully digested the ~150 block summaries alone
        // exceed the 30k window. The walk must still fail fast with an honest
        // post-fold report instead of forwarding an over-window payload.
        const COUNT = 600;
        const REPEATS = 200;
        assert.ok(materialiseTokens(COUNT, REPEATS) > WINDOW * 3, `fixture must start well over the window (${materialiseTokens(COUNT, REPEATS)} vs ${WINDOW})`);

        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "budget-exhaust-state" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: longMessages(COUNT, REPEATS) }),
        });
        const body = await resp.text();
        assert.equal(resp.status, 413, `the deterministic can-never-fit pool must be refused 413: HTTP ${resp.status} ${body.slice(0, 240)}`);
        const json = JSON.parse(body) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false, `a deterministic doom must not invite host spin (got ${JSON.stringify(json.error?.retryable)})`);
        assert.match(json.error?.message ?? "", /could not bring it under/i, `reports the non-convergence verdict with context (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /down from ~\d+ before preflight/, `quotes the post-fold size, not only the original (got: ${json.error?.message})`);
        assert.match(json.error?.message ?? "", /compressible range\(s\) still visible/, `reports how many compressible ranges remain (got: ${json.error?.message})`);

        const summaries = CALLS.filter((c) => c.summary);
        assert.equal(summaries.length, 0, `the hopeless pool is fully digested mid-flight — no LLM summary call may fire (got ${summaries.length})`);
        assert.equal(CALLS.filter((c) => c.raw.includes('"stream":true')).length, 0, "the over-window payload was NOT forwarded");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
