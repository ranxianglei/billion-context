// #5223: after a cross-provider re-serialization drifts the whole history,
// repair mode re-emits the unfolded originals AND a kernel-transform failure
// leaves prepared.processedMessages EMPTY while the outbound body IS the raw
// client history. preflightCompressIfNeeded then judged fit on the empty
// array ("0 + overhead < window"), logged "payload fits; forwarding as-is"
// and shipped a ~50MB / ~5.5M-token body upstream — guaranteed 413 plus a
// wasted upload per turn. These tests pin every forward decision in that
// state to the view that ACTUALLY ships (the #1498-F2 fallback the sibling
// branches already use), including the #1839 arbitration escape, which now
// carries the same doomed-bytes bar (#2490/#2313) as its sibling escapes.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { type ProxyOptions } from "../src/config.ts";
import { preflightCompressIfNeeded, type Prepared } from "../src/server.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));
const SUMMARY = "SUMMARY: preserve the task goal and acceptance criteria; the repeated fixture output is disposable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

async function withRelay(run: (url: string) => Promise<void>) {
    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeIdleConnections?.();
        server.closeAllConnections();
        await closed;
    }
}

function fixture(url: string, window: number, fillerChars: number, protocol: "openai" | "responses") {
    const session = getSession(`issue5223-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(window, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(Math.floor(fillerChars / 7)) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const rawBody = protocol === "openai"
        ? JSON.stringify({ model: "test-model", stream: true, messages: messages.map(m => ({ role: m.role, content: m.text })) })
        : JSON.stringify({ model: "test-model", stream: true, input: messages.map(m => ({ role: m.role, content: m.text })) });
    // The transform-failure shape prepareOpenai leaves behind (prepare-openai.ts
    // catch): processedMessages empty, originalMessages holding the full raw
    // history, body still the inbound JSON.
    const prepared: Prepared = {
        body: rawBody,
        session, processedMessages: [], originalMessages: messages,
        protocol, stream: true, compressInjected: false,
    };
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: window, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const logs: string[] = [];
    const log = (_level: string, message: string) => { logs.push(message); };
    return { session, core, config, messages, prepared, req, res, opts, log, logs };
}

type Fixture = ReturnType<typeof fixture>;
function gate(f: Fixture, rebuild: () => Promise<Prepared>) {
    return preflightCompressIfNeeded(f.prepared, rebuild, f.req, Buffer.from(f.prepared.body), f.res,
        f.opts, f.core, f.config, f.config.modelContextLimit, "test-model", undefined, undefined, undefined, undefined, false, f.log, "issue5223");
}

// A healthy identified session: usage evidence present (the reporter's shape —
// healthy turns right before the drift reported real input tokens), so the
// trigger rides the usage baseline floor even though the current payload view
// is the unmeasured raw history.
function primeUsageEvidence(f: Fixture) {
    f.session.stats.lastInputTokens = 100_000;
    f.session.stats.lastInputTokensSource = "usage";
}

test("zero-fold preflight fails fast locally instead of forwarding an over-window raw body after a transform failure (#5223)", async () => {
    const f = fixture("http://127.0.0.1:9/v1/chat/completions", 6000, 120_000, "openai");
    // #3641 latch: the drift was total (no anchor match, no word evidence), so
    // folding is paused and preflight returns instantly with zero ranges.
    f.session.metadata["foldEpochConfirmPending"] = true;
    primeUsageEvidence(f);
    const result = await gate(f, async () => assert.fail("a zero-progress fold must not rebuild"));
    assert.ok("failFast" in result, "expected a local fail-fast — the gate returned a forward carrying the raw history");
    assert.equal(result.status, 502);
    assert.equal(result.respond, true);
    assert.equal(result.retryable, false);
    assert.ok(String(result.message).includes("fold-drift epoch confirmation pending"), String(result.message));
});

test("an over-window MEASURED view still fails fast locally while folding is paused (control: transform succeeded)", async () => {
    const f = fixture("http://127.0.0.1:9/v1/chat/completions", 6000, 120_000, "openai");
    f.session.metadata["foldEpochConfirmPending"] = true;
    primeUsageEvidence(f);
    f.prepared.processedMessages = f.messages;
    const result = await gate(f, async () => assert.fail("a zero-progress fold must not rebuild"));
    assert.ok("failFast" in result, "the over-window measured view must never leave the process");
    assert.equal(result.status, 502);
});

test("a FITTING raw body still forwards as-is when the transform failed and folding is paused (no regression on passthrough)", async () => {
    const f = fixture("http://127.0.0.1:9/v1/chat/completions", 6000, 8_000, "openai");
    f.session.metadata["foldEpochConfirmPending"] = true;
    primeUsageEvidence(f);
    const result = await gate(f, async () => assert.fail("a zero-progress fold must not rebuild"));
    assert.ok(!("failFast" in result), "a fitting raw body must forward, not fail fast");
    const fwd = result as Prepared;
    assert.equal(typeof fwd.body, "string");
    assert.ok(fwd.body.includes("FILLER_"), "the forwarded body is the raw client history");
});

test("the #1839 arbitration escape is withheld when the rebuilt body is mathematically doomed (#5223)", { timeout: 30_000 }, async () => {
    await withRelay(async url => {
        // 2.1M chars of core text clears the doomed bar (max(2MB, window×7.5B))
        // for a 6000-token window — past any tokenizer density, no upstream
        // can accept this body, so "let the upstream arbitrate" is a lie.
        const f = fixture(url, 6000, 2_100_000, "responses");
        primeUsageEvidence(f);
        const result = await gate(f, async () => f.prepared);
        assert.ok(f.session.state.blocks.length > 0, "the walk must have folded the giant filler first");
        assert.ok("failFast" in result, "a doom-bytes rebuilt body must fail fast, not ride the #1839 escape");
        assert.equal(result.status, 502);
        assert.equal(result.retryable, false);
    });
});
