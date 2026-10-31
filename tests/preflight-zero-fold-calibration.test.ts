import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { outboundPayloadBreakdown, preflightCompressIfNeeded, type Prepared } from "../src/server.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

type Scenario = {
    k?: number;
    windowRatio: number;
    otherOrigin?: boolean;
    otherModel?: boolean;
    imageBytes?: number;
    anonymous?: boolean;
    plugin?: boolean;
    codex?: boolean;
    emptyProcessed?: boolean;
    localRefusal?: boolean;
};

// Exercise the real preflight and caller. The only HTTP peer is this local
// summary mock; an intentionally growing summary must never become a fold.
async function run(s: Scenario) {
    let summaryCalls = 0;
    const summary = "An unusably growing summary. ".repeat(6000);
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            summaryCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/responses`;
    const session = getSession(`zero-fold-calibration-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(10_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the goal and acceptance criteria." },
        { id: "output", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue." },
    ];
    const input: unknown[] = messages.map(m => ({ role: m.role, content: m.text }));
    if (s.imageBytes) input.push({ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(s.imageBytes)}` }] });
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", stream: true, input }),
        session, processedMessages: s.emptyProcessed ? [] : messages,
        originalMessages: messages, protocol: "responses", stream: true,
        compressInjected: false, pluginMode: s.plugin,
    };
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: config.modelContextLimit, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const route = { upstream: url, rewrittenUrl: url };
    const parts = outboundPayloadBreakdown(prepared, opts, route, "/responses");
    const rawText = parts.textEstimate + parts.overheadEstimate;
    const limit = Math.ceil(rawText * s.windowRatio);
    config.modelContextLimit = limit;
    opts.modelContextLimit = limit;
    session.stats.lastInputTokens = s.anonymous ? 0 : Math.ceil(limit * (s.codex ? 0.2 : 1.05));
    session.stats.lastInputTokensSource = "usage";
    session.stats.lastInputTokensOrigin = origin;
    session.stats.calibratedEstimate = s.k;
    session.stats.calibratedEstimateOrigin = s.otherOrigin ? "http://other.invalid" : origin;
    session.stats.calibratedEstimateModel = s.otherModel ? "another-model" : "test-model";
    session.metadata.lastModel = "test-model";
    if (s.localRefusal) session.metadata.localRefusals = [{ origin, model: "test-model", window: limit, at: Date.now() }];
    // Keep the normal no-ranges shortcut out of the way: this is the caller's
    // post-walk zero-fold gate, not its earlier fitting/no-candidates escape.
    const turn = core.processTurn({ messages, state: session.state, config,
        tokenCount: Math.ceil(limit * 1.05), renderTags: "text-only" });
    prepared.nudge = turn.nudge ?? undefined;
    assert.ok((prepared.nudge?.compressibleRanges.length ?? 0) > 0, "fixture needs an advertised candidate");
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = "/responses";
    req.headers = { "content-type": "application/json", ...(s.codex ? { "user-agent": "codex_cli_rs/0.163.0" } : {}) };
    const res = new http.ServerResponse(req);
    const logs: string[] = [];
    let rebuilds = 0;
    try {
        const result = await preflightCompressIfNeeded(prepared, async () => {
            rebuilds++;
            return prepared;
        }, req, Buffer.from(prepared.body), res, opts, core, config, limit,
        "test-model", undefined, undefined, route, undefined, s.anonymous ?? false,
        (_level, msg) => logs.push(msg), "zero-fold-test");
        assert.equal(rebuilds, 0, "a rejected or unnecessary summary cannot rebuild the payload");
        assert.equal(session.state.blocks.length, 0, "no growing summary may land");
        assert.ok(logs.some(line => line.includes("preflight compressing before forward")), "must exercise preflight");
        return { result, prepared, logs, summaryCalls, rawText, imageTokens: parts.imageTokens, limit };
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        upstream.closeAllConnections();
        await closed;
        req.destroy();
        res.destroy();
    }
}

for (const plugin of [false, true]) {
    test(`zero folds: fitting calibrated payload forwards (plugin=${plugin})`, { timeout: 15_000 }, async () => {
        const f = await run({ k: 0.25, windowRatio: 0.6, plugin });
        assert.ok(f.rawText > f.limit && f.rawText * 0.25 < f.limit);
        assert.ok(f.result === f.prepared, JSON.stringify(f.logs));
    });
    test(`zero folds: inflated calibrated payload remains blocked (plugin=${plugin})`, { timeout: 15_000 }, async () => {
        const f = await run({ k: 2, windowRatio: 1.5, plugin });
        assert.ok(f.rawText < f.limit && f.rawText * 2 > f.limit);
        assert.ok("failFast" in f.result, JSON.stringify(f.logs));
        assert.ok(f.summaryCalls > 0, "must reject a growing summary, not bypass the walk");
    });
}

test("Codex health target: a non-shrinking summary does not block a fitting payload", { timeout: 15_000 }, async () => {
    const f = await run({ k: 0.25, windowRatio: 0.25 / 0.95, codex: true });
    assert.ok(f.rawText * 0.25 >= f.limit * 0.9 && f.rawText * 0.25 < f.limit);
    assert.ok(f.summaryCalls > 0);
    assert.ok(f.result === f.prepared, JSON.stringify(f.logs));
    assert.ok(f.logs.some(line => /summary.*(?:grow|larger|not shorter)|no.?shrink/i.test(line)));
});

for (const scenario of [
    { name: "no calibration", k: undefined },
    { name: "different upstream", k: 0.25, otherOrigin: true },
    { name: "different model", k: 0.25, otherModel: true },
    { name: "invalid calibration", k: Number.NaN },
    { name: "raw-body fallback after transform failure", emptyProcessed: true },
]) {
    test(`zero folds: ${scenario.name} does not gain a false fit`, { timeout: 15_000 }, async () => {
        const f = await run({ windowRatio: 0.6, ...scenario });
        assert.ok("failFast" in f.result, JSON.stringify(f.logs));
    });
}

test("zero folds: anonymous unknown baseline retains size-arbitration policy", { timeout: 15_000 }, async () => {
    const f = await run({ windowRatio: 0.6, anonymous: true });
    assert.ok(f.result === f.prepared, JSON.stringify(f.logs));
    assert.ok(f.logs.some(line => line.includes("forwarding once for the upstream to arbitrate")));
});

test("zero folds: a prior scoped refusal still blocks anonymous size arbitration", { timeout: 15_000 }, async () => {
    const f = await run({ windowRatio: 0.6, anonymous: true, localRefusal: true });
    assert.ok("failFast" in f.result, JSON.stringify(f.logs));
    assert.ok(f.logs.some(line => line.includes("NOT re-forwarding for size arbitration")));
});

test("zero folds: image reserve is not deflated by text calibration", { timeout: 15_000 }, async () => {
    const f = await run({ k: 0.25, windowRatio: 0.6, imageBytes: 60_000 });
    assert.ok(f.imageTokens > 0);
    assert.ok(f.rawText * 0.25 < f.limit && f.rawText * 0.25 + f.imageTokens > f.limit);
    assert.ok("failFast" in f.result, JSON.stringify(f.logs));
});
