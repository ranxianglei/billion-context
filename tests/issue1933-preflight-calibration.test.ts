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
import { settleUsageReport } from "../src/cache-ledger.ts";
import { applyEstimateCalibration, normalizeUpstreamOrigin } from "../src/util.ts";
import { resetSessionCompression, getSession, listSessions, type Session } from "../src/session.ts";

// #1933: the preflight trigger judged max(local estimate, provider usage
// baseline), but the local chars/4 estimator's ratio to real billing varies
// per upstream (observed 1.3–2.5x on one relay vs ~1.0x on another in the
// SAME session), so on over-billing relays the raw estimate alone crossed the
// target while the provider measured 59–63% of the window — preflight fired
// early every turn, and after a mid-session provider switch the stale
// cross-provider baseline fired it even on small payloads. Unit half pins the
// calibration math (k̂ learning in settleUsageReport, apply-on-same-route-only);
// the e2e half drives the real proxy against billing-factor mocks and pins the
// two sharp regressions: no false trigger when the calibrated estimate fits,
// and no stale cross-origin baseline after a route switch.

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i1933-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

test("normalizeUpstreamOrigin: URL forms collapse to origin, garbage degrades safely", () => {
    assert.equal(normalizeUpstreamOrigin("http://a:8080/v1/chat/completions?x=1"), "http://a:8080");
    assert.equal(normalizeUpstreamOrigin("https://a:8443"), "https://a:8443");
    // #2645: a provider route's mitm:// config-lookup scheme must collapse to its
    // https egress key, or it normalizes to the opaque "null" origin and can never
    // match the https origin the egress path records (pck ablation / baseline compare).
    assert.equal(normalizeUpstreamOrigin("mitm://a:8443/v1/chat"), "https://a:8443");
    assert.equal(normalizeUpstreamOrigin("  http://a  "), "http://a");
    assert.equal(normalizeUpstreamOrigin(""), undefined);
    assert.equal(normalizeUpstreamOrigin(undefined), undefined);
    assert.equal(normalizeUpstreamOrigin("not a url"), "not a url");
});

test("applyEstimateCalibration: scales only on the learned route, passes raw otherwise", () => {
    assert.equal(applyEstimateCalibration(10000, 0.5, "http://a", "http://a/v1"), 5000);
    assert.equal(applyEstimateCalibration(10000, undefined, "http://a", "http://a"), 10000);
    assert.equal(applyEstimateCalibration(-5, 0.5, "http://a", "http://a"), -5);
    assert.equal(applyEstimateCalibration(0, 0.5, "http://a", "http://a"), 0);
    assert.equal(applyEstimateCalibration(10000, 0.5, undefined, "http://a"), 10000);
    assert.equal(applyEstimateCalibration(10000, 0.5, "http://a", undefined), 10000);
    assert.equal(applyEstimateCalibration(10000, 0.5, "http://a", "http://b"), 10000);
    // Invalid factors (persisted garbage, null from JSON, 0, NaN, Infinity)
    // degrade to no-correction — raw×0 would blind the estimate arm.
    assert.equal(applyEstimateCalibration(10000, 0, "http://a", "http://a"), 10000);
    assert.equal(applyEstimateCalibration(10000, null as unknown as number, "http://a", "http://a"), 10000);
    assert.equal(applyEstimateCalibration(10000, Number.NaN, "http://a", "http://a"), 10000);
    assert.equal(applyEstimateCalibration(10000, Number.POSITIVE_INFINITY, "http://a", "http://a"), 10000);
    assert.equal(applyEstimateCalibration(10000, -0.5, "http://a", "http://a"), 10000);
});

// One settled pair (pending estimate + its usage report) on a route.
function pair(s: Session, est: number, origin: string, billed: number): void {
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

test("settleUsageReport: k̂ publishes only after two consistent same-route samples", () => {
    const s = makeSession();
    const st = s.stats;

    // First sample alone proves nothing — ring holds it, nothing published.
    pair(s, 10000, "http://a", 5000);
    assert.equal(st.calibratedEstimate, undefined, "one sample must not publish a factor");
    assert.deepEqual(st.calibrationRing?.values, [0.5]);
    assert.equal(st.lastInputTokensOrigin, "http://a");
    assert.equal(st.lastLocalTextEstimate, undefined, "the pending pair is consumed, not reused");

    // Second agreeing sample (11000/20000 = 0.55): publish the clamped mean.
    pair(s, 20000, "http://a", 11000);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9, `expected mean 0.525, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateOrigin, "http://a");
});

test("settleUsageReport: cross-route starts a fresh ring and clears the old factor", () => {
    const s = makeSession();
    const st = s.stats;
    pair(s, 10000, "http://a", 5000);
    pair(s, 20000, "http://a", 11000);
    assert.equal(st.calibratedEstimate, 0.525);

    // A first sample from another route must NOT blend two providers' scales
    // and must retire the stale factor until its own evidence agrees.
    pair(s, 10000, "http://b", 20000);
    assert.equal(st.calibratedEstimate, undefined, "cross-route single sample clears the old k̂");
    assert.equal(st.calibratedEstimateOrigin, undefined);
    assert.deepEqual(st.calibrationRing?.values, [2]);
    assert.equal(st.lastInputTokensOrigin, "http://b");

    pair(s, 10000, "http://b", 21000);
    // 2.0/2.1 are consistent under-estimate evidence (billing ABOVE the local
    // estimate). #2366 made calibration two-way (clamp [0.25, 4]): the mean
    // publishes as-is — under-estimating routes (CJK-heavy content) must learn
    // their real billing scale instead of being clamped back to the raw proxy.
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 2.05) < 1e-9, `under-estimate route learns k̂≈2.05, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateOrigin, "http://b");
});

test("settleUsageReport: implausible pairs never enter the ring", () => {
    const s = makeSession();
    const st = s.stats;
    pair(s, 10000, "http://a", 5000);
    pair(s, 20000, "http://a", 11000);
    assert.equal(st.calibratedEstimate, 0.525);

    // Tiny estimates are noise — below the floor they must not touch the ring.
    pair(s, 1000, "http://a", 2000);
    assert.deepEqual(st.calibrationRing?.values, [0.5, 0.55], "tiny-estimate pairs are ignored");

    // Out-of-band ratios (<0.2 / >5) mean the report does not correspond to
    // this payload (placeholder billing, relay echo) — discarded, ring intact.
    pair(s, 10000, "http://a", 100000);
    pair(s, 10000, "http://a", 100);
    assert.deepEqual(st.calibrationRing?.values, [0.5, 0.55], "out-of-band samples are discarded");
    assert.equal(st.calibratedEstimate, 0.525);

    // Disagreement (spread > x2 across the window) clears the factor back to raw.
    pair(s, 10000, "http://a", 30000);
    assert.equal(st.calibratedEstimate, undefined, "inconsistent evidence must clear k̂");
    assert.equal(st.calibratedEstimateOrigin, undefined);

    // The ring is bounded at three samples (oldest shifts out).
    pair(s, 10000, "http://a", 4500);
    pair(s, 10000, "http://a", 4600);
    pair(s, 10000, "http://a", 4700);
    assert.equal(st.calibrationRing?.values.length, 3, "ring capped at CALIBRATION_SAMPLE_WINDOW");
});

test("settleUsageReport: published factors clamp to [0.25, 4] — bounded both ways (#2366)", () => {
    const hi = makeSession();
    pair(hi, 10000, "http://e", 45000);
    pair(hi, 10000, "http://e", 50000);
    assert.equal(hi.stats.calibratedEstimate, 4, "mean 4.75 clamps down to 4: inflation is real on under-estimating (CJK) routes but bounded — and below the sample band max 5, so non-corresponding reports are still rejected first");

    const lo = makeSession();
    pair(lo, 10000, "http://f", 2200);
    pair(lo, 10000, "http://f", 2400);
    assert.equal(lo.stats.calibratedEstimate, 0.25, "mean 0.23 clamps up to 0.25");

    // The corrected reading can now move either way, always inside the clamp
    // band: applying the hi factor inflates to the bound (raw × 4), applying
    // the lo one deflates (raw × 0.25).
    assert.equal(applyEstimateCalibration(10000, hi.stats.calibratedEstimate, "http://e", "http://e"), 40000);
    assert.equal(applyEstimateCalibration(10000, lo.stats.calibratedEstimate, "http://f", "http://f"), 2500);
});

test("settleUsageReport: a report without a known upstream neither learns nor re-provenances", () => {
    const s = makeSession();
    const st = s.stats;
    pair(s, 10000, "http://a", 5000);
    pair(s, 20000, "http://a", 11000);
    assert.equal(st.lastInputTokensOrigin, "http://a");
    st.lastLocalTextEstimate = 10000;
    st.lastLocalTextEstimateOrigin = "http://a";
    settleUsageReport(s, { total: 5000, reportedCached: null });
    assert.equal(st.calibratedEstimate, 0.525, "no-route reports must not disturb the ring");
    assert.equal(st.lastInputTokensOrigin, "http://a");
    assert.equal(st.lastLocalTextEstimate, undefined);
});

test("resetSessionCompression drops calibration + baseline provenance at the compaction boundary", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = getSession("i1933-reset");
    const st = s.stats;
    st.lastInputTokens = 12345;
    st.lastInputTokensSource = "usage";
    st.lastInputTokensOrigin = "http://a";
    st.calibratedEstimate = 0.7;
    st.calibratedEstimateOrigin = "http://a";
    st.calibrationRing = { origin: "http://a", values: [0.7] };
    st.lastLocalTextEstimate = 999;
    st.lastLocalTextEstimateOrigin = "http://a";
    resetSessionCompression(s);
    assert.equal(st.lastInputTokensOrigin, undefined);
    assert.equal(st.calibratedEstimate, undefined);
    assert.equal(st.calibratedEstimateOrigin, undefined);
    assert.equal(st.calibrationRing, undefined);
    assert.equal(st.lastLocalTextEstimate, undefined);
    assert.equal(st.lastLocalTextEstimateOrigin, undefined);
});

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";

type Call = { summary: boolean; stream: boolean };

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
        messages.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i}: ` + "f".repeat(pad),
        });
    }
    return messages;
}

// Bills what it receives: sum(messages[].content chars)/4 x factor — the same
// caliber bili estimates with, scaled to simulate a provider whose tokenizer
// counts more (factor > 1) or fewer (factor < 1) tokens than chars/4.
function makeUpstream(factor: number): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                calls.push({ summary: isSummary, stream: !!parsed.stream });
                if (!isSummary) {
                    const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                    const billed = Math.round((chars / 4) * factor);
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(chatSse("forwarded answer", { prompt_tokens: billed, completion_tokens: 3 }));
                    return;
                }
            } catch { /* fall through */ }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
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

test("e2e F1: a relay billing below the local estimator teaches k̂<1 — the calibrated estimate keeps an over-raw payload under the trigger", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream(0.5);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`;
    const post = (messages: Array<{ role: string; content: string }>) =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i1933-f1" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });

    try {
        // Turns 1–2: growth traffic whose settled pairs teach the route its
        // billing scale (each pair: billed = est x 0.5, ring needs two
        // agreeing samples before a factor publishes).
        const t1 = longMessages(4, 4000);
        const r1 = await post(t1);
        assert.equal(r1.status, 200, `turn 1 must forward: HTTP ${r1.status}`);
        await r1.text();

        const t2msgs = [...t1, ...longMessages(4, 4000)];
        const r2 = await post(t2msgs);
        assert.equal(r2.status, 200, `turn 2 must forward: HTTP ${r2.status}`);
        await r2.text();

        const learned = listSessions().find((s) => s.id === "i1933-f1")?.stats?.calibratedEstimate;
        assert.ok(learned !== undefined && learned > 0.3 && learned < 0.6, `two consistent samples must publish k̂≈0.4–0.5, got ${learned}`);

        // Turn 3: full-history resend sized so the RAW local estimate crosses
        // the 20k target (~22k+) while the calibrated one stays far under
        // (~9–10k). Pre-#1933 the raw estimate alone fired preflight here.
        const t3msgs = [...t2msgs, ...longMessages(14, 4000)];
        const r3 = await post(t3msgs);
        const body = await r3.text();
        assert.equal(r3.status, 200, `calibrated-fit payload must forward, not fold: HTTP ${r3.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.equal(calls.filter((c) => c.summary).length, 0, `no preflight summarization may have run (got ${calls.filter((c) => c.summary).length})`);
        assert.equal(calls.filter((c) => c.stream).length, 3, "all three turns were forwarded as-is");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e F2: a route switch demotes the stale usage-baseline — the small post-switch request is not folded", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const a = makeUpstream(1.4);
    const b = makeUpstream(1.0);
    a.server.listen(0, "127.0.0.1");
    await once(a.server, "listening");
    const portA = (a.server.address() as { port: number }).port;
    b.server.listen(0, "127.0.0.1");
    await once(b.server, "listening");
    const portB = (b.server.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({
        [`http://127.0.0.1:${portA}`]: { models: { "gpt-test": { context: WINDOW } } },
        [`http://127.0.0.1:${portB}`]: { models: { "gpt-test": { context: WINDOW } } },
    }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // Turn 1 on route A: the relay bills 1.4x the local estimate, so its
        // usage report lands ABOVE the 20k window target even though the local
        // estimate (~16k incl. overhead) stayed under it — no trigger, forward.
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portA}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i1933-f2" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: longMessages(15, 4000) }),
        });
        assert.equal(r1.status, 200, `turn 1 must forward: HTTP ${r1.status}`);
        await r1.text();

        // Turn 2 switches to route B with a SMALL payload. Pre-#1933 the
        // baseline floor (route A's ~21k usage) alone crossed the target and
        // folded this request; now the provenance mismatch demotes it.
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${portB}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i1933-f2" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: longMessages(6, 4000) }),
        });
        const body = await r2.text();
        assert.equal(r2.status, 200, `stale cross-route baseline must not fold this request: HTTP ${r2.status} ${body.slice(0, 240)}`);
        assert.ok(body.includes("forwarded answer"), "the model reply must reach the client");
        assert.equal(b.calls.filter((c) => c.summary).length, 0, `no preflight summarization on the switched route (got ${b.calls.filter((c) => c.summary).length})`);
        assert.equal(a.calls.filter((c) => c.summary).length, 0, "no preflight summarization on the original route either");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        a.server.close();
        a.server.closeIdleConnections?.();
        await once(a.server, "close");
        b.server.close();
        b.server.closeIdleConnections?.();
        await once(b.server, "close");
    }
});
