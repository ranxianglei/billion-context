import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, outboundContextEstimate, outboundContextEstimates } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import { currentCalibrationFactor } from "../src/util.ts";
import { displayContextBest, getSession, listSessions, resetSessionCompression, zeroStats, type Session } from "../src/session.ts";

// #2117: the admin bar showed the char-count UPPER BOUND of the in-flight send
// (every character = 1 token — up to ~3.5x over-count on ASCII-heavy tool
// output) as if it were the context size, then snapped to the real billed
// input when the usage report landed (repro: 206K "估算" → 98K measured).
// Fix A separates the calibers: forward() publishes the billing-caliber
// estimate of THIS send alongside the bound, display surfaces pick by
// provenance (usage > calibrated estimate > upper bound), and the bound stays
// visible only as a labeled bound. Fix B keys the learned estimator scale k̂
// by route AND model so a mid-session model switch relearns instead of
// deciding with a cross-model billing scale. Decision paths keep their exact
// formulas; this pins the new seams and the refactored estimator split.

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i2117-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

test("currentCalibrationFactor: invalid factors degrade to absent", () => {
    assert.equal(currentCalibrationFactor({}, "m"), undefined);
    assert.equal(currentCalibrationFactor({ calibratedEstimate: 0 }, "m"), undefined);
    assert.equal(currentCalibrationFactor({ calibratedEstimate: Number.NaN }, "m"), undefined);
    assert.equal(currentCalibrationFactor({ calibratedEstimate: Number.POSITIVE_INFINITY }, "m"), undefined);
    assert.equal(currentCalibrationFactor({ calibratedEstimate: -0.5 }, "m"), undefined);
});

test("currentCalibrationFactor: cross-model factors act as absent, missing info keeps them", () => {
    const st = { calibratedEstimate: 0.5 };
    // Legacy factor (never recorded a model) or unknown current model — missing
    // information must NOT invalidate evidence; rollover retires it naturally.
    assert.equal(currentCalibrationFactor(st, "gpt-x"), 0.5);
    assert.equal(currentCalibrationFactor(st, undefined), 0.5);
    assert.equal(currentCalibrationFactor({ ...st, calibratedEstimateModel: "gpt-x" }, undefined), 0.5);
    // Both known and equal → applies.
    assert.equal(currentCalibrationFactor({ ...st, calibratedEstimateModel: "gpt-x" }, "gpt-x"), 0.5);
    // Both known and different → absent (the dangerous direction: stale k̂<1
    // would deflate the estimate and delay the trigger on the new model).
    assert.equal(currentCalibrationFactor({ ...st, calibratedEstimateModel: "gpt-x" }, "gpt-y"), undefined);
});

type PreparedLike = Parameters<typeof outboundContextEstimates>[0];
type OptsLike = Parameters<typeof outboundContextEstimates>[2];
type Proto = Parameters<typeof outboundContextEstimates>[0]["protocol"];

const OPTS = { routes: {} } as unknown as OptsLike;
const UPSTREAM = "https://upstream.example/v1";

function makePrepared(protocol: Proto): PreparedLike {
    return {
        body: "",
        session: { id: "t-2117" },
        processedMessages: [],
        originalMessages: [],
        protocol,
        stream: false,
        compressInjected: false,
    } as unknown as PreparedLike;
}

const FIXTURES: Array<[Proto, Record<string, unknown>]> = [
    ["anthropic", { model: "m", max_tokens: 100, system: "S".repeat(4000), messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }], tools: [{ name: "t", description: "D".repeat(2000), input_schema: {} }] }],
    ["openai", { model: "m", messages: [{ role: "system", content: "SYS ".repeat(300) }, { role: "user", content: "hello world" }], tools: [{ type: "function", function: { name: "t", description: "D".repeat(2000) } }] }],
    ["responses", { model: "m", instructions: "I".repeat(4000), input: [{ type: "message", role: "user", content: "hello world" }], tools: [{ type: "function", name: "t", description: "D".repeat(2000) }] }],
    ["google", { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4000) }] }, contents: [{ role: "user", parts: [{ text: "hello world" }] }] }],
];

test("outboundContextEstimates: upperBound ≡ legacy outboundContextEstimate, all protocols", () => {
    for (const [protocol, obj] of FIXTURES) {
        const s = JSON.stringify(obj);
        const p = makePrepared(protocol);
        const legacy = outboundContextEstimate(p, s, OPTS, UPSTREAM, obj);
        const e = outboundContextEstimates(p, s, OPTS, UPSTREAM, obj);
        assert.equal(e.upperBound, legacy, `${protocol}: upperBound must equal the legacy value`);
        assert.ok(e.upperBound >= e.textOverhead, `${protocol}: the bound must never undershoot the billing caliber`);
        assert.ok(e.imageTokens === 0, `${protocol}: no images in the fixtures`);
    }
});

test("outboundContextEstimates: ASCII-heavy payload — bound over-counts the billing caliber", () => {
    const ascii = { model: "m", max_tokens: 100, system: "", messages: [{ role: "user", content: "f".repeat(4000) }] };
    const s = JSON.stringify(ascii);
    const e = outboundContextEstimates(makePrepared("openai"), s, OPTS, UPSTREAM, ascii);
    // Every character counts as one token in the bound (~4000+) while the
    // billing caliber counts ~chars/4 — the repro's 2.1x gap, made sharp.
    assert.ok(e.upperBound - e.textOverhead > 2000, `expected a wide gap, got ${e.upperBound} vs ${e.textOverhead}`);
});

test("displayContextBest: provenance picks usage > anchored estimate > upper bound", () => {
    // Usage-grade reading wins whenever present, carrying its timestamp.
    let s = makeSession();
    s.metadata = { contextTokensAt: 1234 };
    s.stats = { ...zeroStats(), contextTokens: 98_000, contextTokensSource: "usage", contextEstimateTokens: 206_000, contextEstimateCalibrated: true };
    assert.deepEqual(displayContextBest(s), { tokens: 98_000, kind: "usage", at: 1234 });

    // Estimate-grade turn WITH a usage anchor: show the calibrated billing
    // estimate of the current send, not the char-count bound.
    s = makeSession();
    s.stats = { ...zeroStats(), contextTokens: 206_000, contextTokensSource: "estimate", contextEstimateTokens: 101_000, contextEstimateCalibrated: true, lastUsageGradeTokens: 98_000 };
    assert.deepEqual(displayContextBest(s), { tokens: 101_000, kind: "estimate", calibrated: true });

    // Uncalibrated estimate keeps the uncalibrated flag.
    s = makeSession();
    s.stats = { ...zeroStats(), contextTokens: 206_000, contextTokensSource: "estimate", contextEstimateTokens: 101_000, contextEstimateCalibrated: false, lastUsageGradeTokens: 98_000 };
    assert.deepEqual(displayContextBest(s), { tokens: 101_000, kind: "estimate" });

    // NEVER-reporting upstream (no anchor): fail-closed — the upper bound
    // stays the displayed value (#553/#728 discipline), labeled as a bound.
    s = makeSession();
    s.stats = { ...zeroStats(), contextTokens: 206_000, contextTokensSource: "estimate", contextEstimateTokens: 101_000 };
    assert.deepEqual(displayContextBest(s), { tokens: 206_000, kind: "upper" });

    // Legacy session files (field absent) fall through to today's behavior.
    s = makeSession();
    s.stats = { ...zeroStats(), contextTokens: 206_000, contextTokensSource: "estimate" };
    assert.deepEqual(displayContextBest(s), { tokens: 206_000, kind: "upper" });

    // Nothing observed yet.
    s = makeSession();
    assert.equal(displayContextBest(s), null);

    // Usage source drained to zero does not win; the bound remains.
    s = makeSession();
    s.stats = { ...zeroStats(), contextTokens: 0, contextTokensSource: "usage" };
    assert.equal(displayContextBest(s), null);
});

// One settled pair (pending estimate + its usage report) on a route+model.
function pair(s: Session, est: number, origin: string, billed: number, model?: string): void {
    if (model !== undefined) s.metadata = { lastModel: model };
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

test("settleUsageReport B: same route+model publishes with model provenance", () => {
    const s = makeSession();
    const st = s.stats;
    pair(s, 10_000, "http://a", 5_000, "gpt-x");
    assert.equal(st.calibratedEstimate, undefined, "one sample must not publish");
    assert.equal(st.calibrationRing?.model, "gpt-x");
    pair(s, 20_000, "http://a", 11_000, "gpt-x");
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9, `expected mean 0.525, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateOrigin, "http://a");
    assert.equal(st.calibratedEstimateModel, "gpt-x");
});

test("settleUsageReport B: a model switch starts a fresh ring and clears the old factor", () => {
    const s = makeSession();
    const st = s.stats;
    pair(s, 10_000, "http://a", 5_000, "gpt-x");
    pair(s, 20_000, "http://a", 11_000, "gpt-x");
    assert.equal(st.calibratedEstimate, 0.525);

    // First sample on the new model must NOT blend into the old evidence nor
    // republish the cross-model factor — discard-and-relearn.
    pair(s, 10_000, "http://a", 5_000, "gpt-y");
    assert.equal(st.calibratedEstimate, undefined, "cross-model single sample clears the old k̂");
    assert.equal(st.calibratedEstimateModel, undefined);
    assert.deepEqual(st.calibrationRing?.values, [0.5]);
    assert.equal(st.calibrationRing?.model, "gpt-y");

    // Two agreeing samples on the new model republish it.
    pair(s, 20_000, "http://a", 11_000, "gpt-y");
    assert.equal(st.calibratedEstimate, 0.525);
    assert.equal(st.calibratedEstimateModel, "gpt-y");

    // Switching BACK to gpt-x discards again — no cross-model memory either way.
    pair(s, 10_000, "http://a", 5_000, "gpt-x");
    assert.equal(st.calibratedEstimate, undefined);
    assert.equal(st.calibrationRing?.model, "gpt-x");
});

test("settleUsageReport B: a legacy ring without a model key continues and adopts the model (#2129)", () => {
    const s = makeSession();
    const st = s.stats;
    // Pre-upgrade / post-restart shape: published factor + ring with no model
    // dimension (the load whitelist drops the model fields — #2141). The k̂ is
    // still provenance-matched to the session's model and must survive the
    // first known-model settle instead of being discarded-and-cleared.
    st.calibratedEstimate = 0.5;
    st.calibratedEstimateOrigin = "http://a";
    st.calibrationRing = { origin: "http://a", values: [0.5, 0.55] };
    pair(s, 10_000, "http://a", 5_000, "gpt-x");
    assert.ok((st.calibratedEstimate ?? 0) > 0, "missing model info must not invalidate a published k̂");
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - ((0.5 + 0.55 + 0.5) / 3)) < 1e-9, `expected re-published mean, got ${st.calibratedEstimate}`);
    assert.deepEqual(st.calibrationRing?.values, [0.5, 0.55, 0.5]);
    assert.equal(st.calibrationRing?.model, "gpt-x");
    assert.equal(st.calibratedEstimateModel, "gpt-x");
});

test("settleUsageReport B: unknown model keeps the legacy behavior (ring continues)", () => {
    const s = makeSession();
    const st = s.stats;
    // No model stamp anywhere (requests without a model id): rings stay keyed
    // by origin alone, exactly as before this change.
    pair(s, 10_000, "http://a", 5_000);
    pair(s, 20_000, "http://a", 11_000);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9);
    assert.equal(st.calibratedEstimateModel, undefined);
    assert.equal(st.calibrationRing?.model, undefined);
    // A model-stamped sample arriving later adopts the model on the existing
    // ring — no discard (same missing-info discipline as the legacy case).
    pair(s, 10_000, "http://a", 5_000, "gpt-x");
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - ((0.5 + 0.55 + 0.5) / 3)) < 1e-9);
    assert.equal(st.calibrationRing?.model, "gpt-x");
    assert.equal(st.calibratedEstimateModel, "gpt-x");
});

test("resetSessionCompression drops the new provenance/display fields at the boundary", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = getSession("i2117-reset");
    const st = s.stats;
    st.calibratedEstimate = 0.7;
    st.calibratedEstimateOrigin = "http://a";
    st.calibratedEstimateModel = "gpt-x";
    st.calibrationRing = { origin: "http://a", model: "gpt-x", values: [0.7] };
    st.contextEstimateTokens = 12_000;
    st.contextEstimateCalibrated = true;
    resetSessionCompression(s);
    assert.equal(st.calibratedEstimateModel, undefined);
    assert.equal(st.calibrationRing, undefined);
    assert.equal(st.contextEstimateTokens, undefined);
    assert.equal(st.contextEstimateCalibrated, undefined);
});

const WINDOW = 20_000;

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function longMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const pad = Math.max(1, charsPerMsg - 12);
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

// Bills what it receives: sum(messages[].content chars)/4 x factor — the same
// caliber bili estimates with, scaled to simulate a relay whose tokenizer
// counts fewer tokens than chars/4 (factor < 1 → k̂ learns below 1).
function makeUpstream(factor: number): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                const billed = Math.round((chars / 4) * factor);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: billed, completion_tokens: 3 }));
                return;
            } catch { /* fall through */ }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
    });
}

test("e2e: forward() publishes both calibers; usage wins the display after settle", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = makeUpstream(0.5);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
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
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`;
    const post = (messages: Array<{ role: string; content: string }>) =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "i2117-e2e" }, body: JSON.stringify({ model: "gpt-test", stream: true, messages }) });

    try {
        const r1 = await post(longMessages(4, 4000));
        assert.equal(r1.status, 200, `turn 1 must forward: HTTP ${r1.status}`);
        await r1.text();
        let s = listSessions().find((x) => x.id === "i2117-e2e");
        assert.ok(s, "session must exist");
        // Post-settle: the measured usage owns the context value...
        assert.equal(s!.stats.contextTokensSource, "usage");
        assert.ok((s!.stats.lastInputTokens ?? 0) > 0);
        assert.equal(s!.stats.contextTokens, s!.stats.lastInputTokens);
        // ...while the per-send estimates survive alongside it. The billing
        // caliber of THIS send was written pre-forward and must sit well
        // BELOW the char-count bound for this ASCII-heavy payload.
        assert.ok(typeof s!.stats.contextEstimateTokens === "number" && s!.stats.contextEstimateTokens > 0, "billing-caliber estimate must be published");
        assert.ok((s!.stats.localInputEstimate ?? 0) > s!.stats.contextEstimateTokens!, `bound (${s!.stats.localInputEstimate}) must exceed the billing caliber (${s!.stats.contextEstimateTokens})`);
        assert.equal(s!.stats.contextEstimateCalibrated, false, "no k̂ after one sample");
        // Display: usage wins with its kind.
        assert.deepEqual({ tokens: displayContextBest(s!)!.tokens, kind: displayContextBest(s!)!.kind }, { tokens: s!.stats.lastInputTokens, kind: "usage" });

        // Turn 2 teaches the second sample → k̂ publishes (route+model gpt-test).
        const r2 = await post([...longMessages(4, 4000), ...longMessages(4, 4000)]);
        assert.equal(r2.status, 200);
        await r2.text();
        s = listSessions().find((x) => x.id === "i2117-e2e");
        assert.ok(s!.stats.calibratedEstimate !== undefined && s!.stats.calibratedEstimate! < 1, `two consistent 0.5-ratio samples must publish k̂<1, got ${s!.stats.calibratedEstimate}`);
        assert.equal(s!.stats.calibratedEstimateModel, "gpt-test");

        // Turn 3: the forward-time estimate is scaled by the matching factor.
        const r3 = await post([...longMessages(8, 4000), ...longMessages(4, 4000)]);
        assert.equal(r3.status, 200);
        await r3.text();
        s = listSessions().find((x) => x.id === "i2117-e2e");
        assert.equal(s!.stats.contextEstimateCalibrated, true, "matching route+model factor must scale the displayed estimate");
        assert.ok(s!.stats.contextEstimateTokens! < (s!.stats.localInputEstimate ?? 0) / 2, `calibrated estimate (${s!.stats.contextEstimateTokens}) must be far below the bound (${s!.stats.localInputEstimate})`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
