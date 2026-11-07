// #4930: the zero-fold FINAL fit predicate discarded scoped estimate calibration.
//
// When preflight folds nothing, the outbound payload is byte-identical to the one
// measured at entry — so the entry-time scoped verdict (payloadFitsWindow: this
// route/model's k̂-scaled text + wire overhead + the UNSCALED image reserve, below
// the window) IS the final fit. The old code re-measured raw core text at the end:
// a deflated session (k̂<1) whose calibrated estimate fit the window was fail-fast'd
// on its raw over-window reading, and an inflated session (k̂>1) whose calibrated
// estimate exceeded the window was forwarded on its raw under-window reading.
//
// Each scenario drives the real gate (preflightCompressIfNeeded) with a forced
// zero-fold payload — the fold-epoch confirm pause returns before any candidate
// walk, so no upstream call is ever dialed (the dummy upstream URL fails loudly if
// one is attempted). The straddle preconditions are self-validated in-test against
// the server's own measurement (outboundPayloadBreakdown) so the fixture provably
// discriminates the calibrated verdict from the raw one. Guard scenarios pin the
// cases that must keep the raw verdict: route/model mismatch, invalid calibration,
// the unknown-baseline arbitration policy (#553/#3146), the prior-refusal hatch
// closure (#3846), unscaled image reserves (#1800), and the uncalibrated control.

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import { _setStoreForTest, SessionStore } from "../src/persist.js";
import { getSession } from "../src/session.js";
import { isPreflightFailFast, outboundPayloadBreakdown, preflightCompressIfNeeded } from "../src/server.js";
import type { Prepared } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";
import { estimateCoreMessages } from "../src/preflight.js";
import { normalizeUpstreamOrigin } from "../src/util.js";
import type { WireProtocol } from "../src/util.js";
import { CODEX_COMPACT_HEALTH_RATIO, codexHealthBarApplies } from "../src/codex-compact.js";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.js";

const WINDOW = 20_000;
const MODEL = "gpt-test";
// Unreachable on purpose: every scenario below is a zero-fold, so dialing this
// means a walk tried to fold — a loud failure, not a silent hang.
const UPSTREAM = "http://127.0.0.1:9999";
const ORIGIN = normalizeUpstreamOrigin(UPSTREAM);
assert.ok(ORIGIN, "test upstream must normalize to an origin");

// Raw text-token targets that straddle the window once scaled:
// deflation: raw ≈ 21_000 (≥ 20_000), ×0.9 → ≈ 18_900 (< 20_000)
// inflation: raw ≈ 19_000 (< 20_000), ×1.1 → ≈ 20_900 (≥ 20_000)
const RAW_OVER_TARGET = 21_000;
const RAW_UNDER_TARGET = 19_000;

const SENTENCE = "The proxy measures the outbound payload before it leaves the building. ";

function makeText(chars: number): string {
    let s = "";
    while (s.length < chars) s += SENTENCE;
    return s.slice(0, chars);
}

/** Pure-ASCII text lands at roughly chars/4 tokens under the CJK-aware estimator;
 *  iterate until the estimate sits within ±1% of the target. */
function sizeText(targetTokens: number): string {
    let chars = Math.max(4000, targetTokens * 4);
    for (let i = 0; i < 4; i++) {
        const text = makeText(chars);
        const measured = estimateCoreMessages([{ id: "probe", role: "user", contentType: "text", text }]);
        if (Math.abs(measured - targetTokens) <= Math.max(64, targetTokens * 0.01)) return text;
        chars = Math.round(chars * (targetTokens / measured));
    }
    throw new Error(`could not size text near ${targetTokens} tokens`);
}

/** Minimal PNG header (signature + IHDR with real dimensions) over a junk payload.
 *  The pixels-mode biller parses exactly this header (decodeImageDims reads the first
 *  32 decoded bytes) and charges the OpenAI high-detail tile model — deterministic,
 *  no container encoding needed. */
function fakePngB64(width: number, height: number): string {
    const head = Buffer.alloc(33);
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    head.writeUInt32BE(13, 8);
    head.write("IHDR", 12, "ascii");
    head.writeUInt32BE(width, 16);
    head.writeUInt32BE(height, 20);
    head[24] = 8;
    head[25] = 2;
    return (head.toString("base64") + "A".repeat(512)).slice(0, 556);
}

interface GateOpts {
    /** Target raw TEXT tokens of the single user message (channel adds wire overhead). */
    textTarget: number;
    window?: number;
    protocol?: WireProtocol;
    pluginMode?: boolean;
    anonymous?: boolean;
    /** stats.calibratedEstimate — omit for an uncalibrated session. */
    k?: number;
    /** stats.calibratedEstimateOrigin — defaults to the test route origin. */
    kOrigin?: string;
    /** stats.calibratedEstimateModel (the #2117 B provenance gate). */
    kModel?: string;
    baseline?: { tokens: number; source: "usage" | "estimate" | "overflow-arm"; origin?: string };
    /** Seed a covering local refusal (#3846) for the test route + model + window. */
    refusal?: boolean;
    /** Kernel-transform-failure view: processed empty, raw original body rides (#1498-F2). */
    processedEmpty?: boolean;
    headers?: Record<string, string>;
    /** OpenAI data-URL image parts in the outbound BODY only (invisible to the kernel text model, #488). */
    imageParts?: { width: number; height: number }[];
    /** Skip the epoch-confirm pause lever — let the real walk run (the zero-fold then comes from minCompressRange). */
    walk?: boolean;
    minCompressRange?: number;
}

interface GateResult {
    outcome: Awaited<ReturnType<typeof preflightCompressIfNeeded>>;
    logs: string[];
    /** The server's own entry-time measurement of this payload. */
    t: number;
    oh: number;
    i: number;
    window: number;
}

let seq = 0;

async function runGate(o: GateOpts): Promise<GateResult> {
    const window = o.window ?? WINDOW;
    const protocol: WireProtocol = o.protocol ?? "openai";

    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = getSession(`issue4930-${++seq}`);
    session.metadata.lastModel = MODEL;
    if (o.k !== undefined) {
        session.stats.calibratedEstimate = o.k;
        session.stats.calibratedEstimateOrigin = o.kOrigin ?? ORIGIN;
        if (o.kModel !== undefined) session.stats.calibratedEstimateModel = o.kModel;
    }
    if (o.baseline !== undefined) {
        session.stats.lastInputTokens = o.baseline.tokens;
        session.stats.lastInputTokensSource = o.baseline.source;
        session.stats.lastInputTokensOrigin = o.baseline.origin ?? ORIGIN;
    }
    if (o.refusal) {
        session.metadata.localRefusals = [{ origin: ORIGIN, model: MODEL, window: Math.floor(window), at: Date.now() }];
    }
    if (!o.walk) {
        // The zero-fold lever: an epoch-confirm pause makes preflight return before any
        // candidate walk — compressedRanges 0, no failure stamped, no upstream traffic.
        session.metadata.foldEpochConfirmPending = true;
    }

    const core = createCore();
    const config = defaultConfig(window, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    if (o.minCompressRange !== undefined) config.compress.minCompressRange = o.minCompressRange;

    const text = sizeText(o.textTarget);
    const messages: CoreMessage[] = [{ id: "m1", role: "user", contentType: "text", text }];
    const imageUrls = (o.imageParts ?? []).map((d) => `data:image/png;base64,${fakePngB64(d.width, d.height)}`);
    const bodyObj = protocol === "responses"
        ? { model: MODEL, stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] }
        : { model: MODEL, stream: true, messages: [{ role: "user", content: imageUrls.length > 0 ? [{ type: "text", text }, ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))] : text }] };
    const body = JSON.stringify(bodyObj);

    const prepared: Prepared = {
        body,
        session,
        processedMessages: o.processedEmpty ? [] : messages,
        originalMessages: messages,
        protocol,
        stream: true,
        compressInjected: false,
        ...(o.pluginMode ? { pluginMode: true } : {}),
    };
    prepared.nudge = core.processTurn({ messages, state: session.state, config, tokenCount: window, renderTags: "text-only" }).nudge;

    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
    req.headers = { ...(o.headers ?? {}) };
    const res = new http.ServerResponse(req);
    const logs: string[] = [];
    const opts: ProxyOptions = {
        host: "127.0.0.1",
        port: 0,
        upstream: UPSTREAM,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: window,
        kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const route = { upstream: UPSTREAM, rewrittenUrl: UPSTREAM };
    const ch = outboundPayloadBreakdown(prepared, opts, route, req.url!);

    const outcome = await preflightCompressIfNeeded(
        prepared,
        async () => prepared,
        req,
        Buffer.from(body),
        res,
        opts,
        core,
        config,
        window,
        MODEL,
        undefined,
        undefined,
        route,
        undefined,
        o.anonymous ?? false,
        (_lvl, msg) => { logs.push(msg); },
        "issue4930-instance",
    );
    return { outcome, logs, t: ch.textEstimate, oh: ch.overheadEstimate, i: ch.imageTokens, window };
}

/** The calibrated payload exactly as the server computes it: (text+overhead)·k̂ + images (unscaled). */
function calibrated(t: number, oh: number, i: number, k: number): number {
    return (t + oh) * k + i;
}
function raw(t: number, oh: number, i: number): number {
    return t + oh + i;
}

function assertDeflationStraddle(t: number, oh: number, i: number, k: number, window: number, healthBar = false): void {
    const c = calibrated(t, oh, i, k);
    const r = raw(t, oh, i);
    assert.ok(c < window, `fixture must be calibrated-fitting: ${c} < ${window}`);
    assert.ok(r >= window, `fixture must be raw-over-window: ${r} >= ${window}`);
    if (healthBar) assert.ok(c >= window * CODEX_COMPACT_HEALTH_RATIO, `fixture must sit above the health bar: ${c} >= ${window * CODEX_COMPACT_HEALTH_RATIO}`);
}

function assertInflationStraddle(t: number, oh: number, i: number, k: number, window: number): void {
    const c = calibrated(t, oh, i, k);
    const r = raw(t, oh, i);
    assert.ok(r < window, `fixture must be raw-fitting: ${r} < ${window}`);
    assert.ok(c >= window, `fixture must be calibrated-over-window: ${c} >= ${window}`);
}

function expectForward(outcome: GateResult["outcome"], logs: string[]): void {
    assert.equal(isPreflightFailFast(outcome), false, `expected forward, got fail-fast: ${isPreflightFailFast(outcome) ? outcome.message : ""}`);
    assert.ok(logs.some((l) => l.includes("forwarding as-is")), `expected the zero-fold forward log, got: ${logs.join(" | ")}`);
}

function expectFailFast(outcome: GateResult["outcome"]): { status: number; message: string; retryable: boolean } {
    assert.ok(isPreflightFailFast(outcome), "expected fail-fast, got a forward");
    assert.match(outcome.message, /NOT forwarded/i, `fail-fast message must say the payload was not forwarded: ${outcome.message}`);
    return { status: outcome.status, message: outcome.message, retryable: outcome.retryable };
}

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "zero-fold scenarios must leave no upstream timers behind");
    _resetFetchUtilForTest();
});

// ── Both calibration directions, proxy + plugin modes ─────────────────────────

test("#4930 deflation straddle (k̂<1), proxy mode: a fitting calibrated payload forwards instead of failing fast", async () => {
    const r = await runGate({ textTarget: RAW_OVER_TARGET, k: 0.9, baseline: { tokens: WINDOW + 500, source: "usage" } });
    assertDeflationStraddle(r.t, r.oh, r.i, 0.9, r.window);
    expectForward(r.outcome, r.logs);
});

test("#4930 deflation straddle (k̂<1), plugin mode: same verdict on the plugin lane", async () => {
    const r = await runGate({ textTarget: RAW_OVER_TARGET, k: 0.9, pluginMode: true, baseline: { tokens: WINDOW + 500, source: "usage" } });
    assertDeflationStraddle(r.t, r.oh, r.i, 0.9, r.window);
    expectForward(r.outcome, r.logs);
});

test("#4930 inflation straddle (k̂>1), proxy mode: an over-window calibrated payload fails fast instead of blind-forwarding", async () => {
    const r = await runGate({ textTarget: RAW_UNDER_TARGET, k: 1.1, baseline: { tokens: 19_500, source: "usage" } });
    assertInflationStraddle(r.t, r.oh, r.i, 1.1, r.window);
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502, "the epoch-confirm pause stamps no deterministic failure, so the relay-dependent 502 contract holds");
    assert.equal(ff.retryable, false);
});

test("#4930 inflation straddle (k̂>1), plugin mode: same verdict on the plugin lane", async () => {
    const r = await runGate({ textTarget: RAW_UNDER_TARGET, k: 1.1, pluginMode: true, baseline: { tokens: 19_500, source: "usage" } });
    assertInflationStraddle(r.t, r.oh, r.i, 1.1, r.window);
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});

// ── Codex health target ────────────────────────────────────────────────────────

test("#4930 codex health target: the 0.9 bar lowers the fold target, not the fit verdict — a full-window calibrated fit forwards", async () => {
    const headers = { "user-agent": "codex_cli_rs/1.0.0" };
    assert.ok(codexHealthBarApplies(headers), "precondition: the health bar must apply to this client shape");
    const r = await runGate({
        textTarget: RAW_OVER_TARGET,
        k: 0.9,
        protocol: "responses",
        headers,
        baseline: { tokens: WINDOW + 500, source: "usage" },
    });
    // Calibrated sits between the health bar (18_000) and the full window (20_000):
    // folding cannot reach the bar (non-shrinking summary territory), but the
    // payload fits the window — the verdict must be the full-window one.
    assertDeflationStraddle(r.t, r.oh, r.i, 0.9, r.window, true);
    expectForward(r.outcome, r.logs);
});

// ── Guards that must keep the raw verdict ─────────────────────────────────────

test("#4930 route mismatch: a factor learned on another route acts absent — the raw verdict stands", async () => {
    const r = await runGate({
        textTarget: RAW_OVER_TARGET,
        k: 0.9,
        kOrigin: "http://other.example:443",
        baseline: { tokens: WINDOW + 500, source: "usage" },
    });
    const c = calibrated(r.t, r.oh, r.i, 0.9);
    assert.ok(c < r.window && raw(r.t, r.oh, r.i) >= r.window, "straddle precondition");
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});

test("#4930 model mismatch: a factor learned on another model acts absent (#2117 B) — the raw verdict stands", async () => {
    const r = await runGate({
        textTarget: RAW_OVER_TARGET,
        k: 0.9,
        kModel: "other-model",
        baseline: { tokens: WINDOW + 500, source: "usage" },
    });
    const c = calibrated(r.t, r.oh, r.i, 0.9);
    assert.ok(c < r.window && raw(r.t, r.oh, r.i) >= r.window, "straddle precondition");
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});

test("#4930 invalid calibration: NaN/0/negative/infinite factors act absent — the raw verdict stands", async () => {
    for (const k of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
        const r = await runGate({ textTarget: RAW_OVER_TARGET, k, baseline: { tokens: WINDOW + 500, source: "usage" } });
        // Every one of these factors acts absent, so the operative reading is the raw one.
        assert.ok(raw(r.t, r.oh, r.i) >= r.window, `raw must measure over-window (k=${String(k)})`);
        const ff = expectFailFast(r.outcome);
        assert.equal(ff.status, 502, `k=${k} must keep the raw fail-fast verdict`);
    }
});

test("#4930 raw-body fallback: processed-empty views measure the original body, not zero (#1498-F2)", async () => {
    const r = await runGate({ textTarget: RAW_UNDER_TARGET, k: 1.1, processedEmpty: true });
    assertInflationStraddle(r.t, r.oh, r.i, 1.1, r.window);
    // The old predicate measured estimateCoreMessages([]) = 0 here and forwarded
    // a payload whose calibrated estimate exceeds the window.
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});

test("#4930 unknown-baseline arbitration is untouched: anonymous fresh sessions still forward once for the upstream to arbitrate (#553/#3146)", async () => {
    const r = await runGate({ textTarget: RAW_OVER_TARGET, k: 0.9, anonymous: true });
    // Over-window even by the char-count upper bound regime — the unknown-baseline
    // arm judges result.fitsWindow (the loop's own raw-based value), NOT k̂.
    assert.ok(raw(r.t, r.oh, r.i) >= r.window, "payload must measure over-window raw");
    assert.equal(isPreflightFailFast(r.outcome), false, "the forward-once arbitration must survive the fix");
    assert.ok(r.logs.some((l) => l.includes("arbitrate size before failing fast")), `expected the #3146 arbitration log, got: ${r.logs.join(" | ")}`);
});

test("#4930 prior refusal closes the hatch: a deterministic exhaustion under a calibrated over-window verdict with a covering local refusal fails 413, no re-bet (#3846)", async () => {
    // This one runs the REAL walk (no pause lever): minCompressRange above every
    // span keeps it candidate-free, so it ends in DETERMINISTIC exhaustion (the
    // #4185 shape) — the only shape that opens the no-upstream-evidence arm.
    const r = await runGate({ textTarget: RAW_UNDER_TARGET, k: 1.1, walk: true, minCompressRange: 100_000, refusal: true });
    assertInflationStraddle(r.t, r.oh, r.i, 1.1, r.window);
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 413, "deterministic exhaustion + calibrated over-window = 413");
    assert.equal(ff.retryable, false);
    assert.ok(r.logs.some((l) => l.includes("NOT re-forwarding for size arbitration")), `expected the #3846 fall-through log, got: ${r.logs.join(" | ")}`);
});

test("#4930 image reserve stays unscaled: the fit verdict prices images at their billed tokens, never ×k̂ (#1800)", async () => {
    // Three 4096×4096 PNGs bill 3 × pixelTileEstimate(4096,4096) = 3 × 2805 = 8415
    // tokens in the default pixels mode. With t ≈ 12_000, k̂ = 0.8, window 17_250:
    //   correct (t+oh)·k̂ + i ≈ 18_0xx  ≥ window  → reject
    //   naive   (t+oh+i)·k̂   ≈ 16_4xx  < window  → would wrongly forward
    //   raw     t+oh+i        ≈ 20_5xx  ≥ window  → reject
    // A covering usage baseline closes the #1800 image-arbitration escape so the
    // verdict comes from the fit predicate itself.
    const r = await runGate({
        textTarget: 12_000,
        k: 0.8,
        window: 17_250,
        imageParts: [{ width: 4096, height: 4096 }, { width: 4096, height: 4096 }, { width: 4096, height: 4096 }],
        baseline: { tokens: 17_500, source: "usage" },
    });
    assert.equal(r.i, 8_415, "pixels-mode billing must price each 4096² PNG at the 2805 tile-model ceiling");
    const c = calibrated(r.t, r.oh, r.i, 0.8);
    const naive = raw(r.t, r.oh, r.i) * 0.8;
    const rw = raw(r.t, r.oh, r.i);
    assert.ok(naive < r.window && c >= r.window && rw >= r.window, `discriminating straddle: naive ${naive} < ${r.window} <= correct ${c} and raw ${rw} >= ${r.window}`);
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});

test("#4930 uncalibrated control: without k̂ the verdict is byte-identical to the legacy raw predicate", async () => {
    const r = await runGate({ textTarget: RAW_OVER_TARGET, baseline: { tokens: WINDOW + 500, source: "usage" } });
    assert.ok(raw(r.t, r.oh, r.i) >= r.window, "payload must measure over-window raw");
    const ff = expectFailFast(r.outcome);
    assert.equal(ff.status, 502);
});
