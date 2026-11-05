import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on the very first 429 instead of the default 3 attempts with
// exponential backoff — these tests are about the post-retry behavior.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { createCore, defaultConfig, type Config } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { METADATA_FOLD_COVERAGE } from "../src/fold-reconcile.ts";
import { getSession } from "../src/session.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #301: when preflight (overflow) compression cannot proceed — the summary
// upstream is rate-limiting, or the compress budget is exhausted — the proxy
// must FAIL FAST with a structured error instead of forwarding the over-window
// payload as-is (guaranteed upstream 400, wasted quota, client retry storms;
// log evidence in #292). Forwarding as-is stays legal ONLY when the payload's
// own estimate actually fits the window (the trigger floors on
// stats.lastInputTokens, which can be stale — #300 double-counted usage).

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `MARKER_${i}_content_`.repeat(250);
        msgs.push({ role, content: `Message ${i} of the long conversation. ${filler}` });
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

function makeUpstream429(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(429, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
            }
        });
    });
}

// Upstream that succeeds on BOTH the forwarded (stream) request and the
// preflight summarization (non-stream) call — needed to exercise the #330
// relaxed-zone fold path end to end.
function makeUpstreamOk(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: the large recent user message was a deterministic load-growth payload; its raw content is no longer needed." }] }));
            }
        });
    });
}

// #4185: zero-evidence identified sessions with a DETERMINISTIC exhaustion
// (nothing compressible left after maximum folding) now forward once for
// upstream arbitration instead of failing fast locally. The seeded pins below
// are exactly that shape, so each carries a settled usage baseline to keep
// exercising the evidence-driven verdict; relay-dependent failures (429'd or
// empty summaries) stay on the classic path and need no seeding.
function seedEvidence(sessionId: string, upstreamPort: number): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 100;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, kernelOverrides?: Partial<Config>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, kernelOverrides),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

test("Responses short wire projection preserves main folds through the full request pipeline", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-short-wire": { context: 400_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const post = async (input: unknown[]) => {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": "short-wire-pipeline" },
            body: JSON.stringify({ model: "gpt-short-wire", stream: true, max_output_tokens: 1024, input }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body.slice(0, 300));
    };
    try {
        const main = Array.from({ length: 24 }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", content: `main turn ${i} ${"x".repeat(2000)}` }));
        await post(main);
        const session = getSession("short-wire-pipeline");
        const messages = session.lastMessages;
        assert.ok(messages && messages.length >= 24);
        session.state = createCore().applyCompression({
            ranges: [{ startRef: "m00001", endRef: "m00007", summary: "Compressed main history: seven early turns preserved the investigation, implementation decisions, and verified test evidence." }],
            messages, state: session.state, config: defaultConfig(400_000),
        }).state;
        assert.equal(session.state.blocks.length, 1);
        await post(main);
        const blockIds = session.state.blocks.map((b) => b.blockId);
        const coverage = structuredClone(session.metadata[METADATA_FOLD_COVERAGE]);
        assert.ok(coverage);
        const short = Array.from({ length: 6 }, (_, i) => ({
            type: "message", role: "user",
            content: Array.from({ length: 13 }, (_, j) => ({ type: "input_text", text: `utility ${i} part ${j}` })),
        }));
        for (let i = 0; i < 4; i++) await post(short);
        assert.deepEqual(session.metadata[METADATA_FOLD_COVERAGE], coverage, "auxiliary projection must not accumulate deletion evidence");
        assert.deepEqual(session.state.blocks.map((b) => b.blockId), blockIds);
        await post(main);
        assert.deepEqual(session.state.blocks.map((b) => b.blockId), blockIds);
        assert.ok(session.state.blocks.every((b) => b.active), "returning main history reactivates every retained fold");
    } finally {
        proxy.close(); proxy.closeIdleConnections?.();
        upstream.close(); upstream.closeIdleConnections?.();
        await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
    }
});

test("e2e #301: overflow + summary upstream 429 → structured 503, over-window payload NOT forwarded", async () => {
    const calls: Call[] = [];
    // The preflight summarization call hits the same rate-limited upstream as
    // the main request (the #292 scenario).
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // Fresh session: a ~13k-token history against a 10k window — the
        // payload itself overflows, preflight fires, its summarization call
        // 429s. The proxy must fail fast, NOT forward the over-window body.
        // (#4185) the 429 is relay-dependent, so the identified-fresh escape
        // stays closed and this pin needs no evidence seeding.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-429-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r.status, 503, "fail-fast 503 when the summary upstream rate-limits");
        const json = JSON.parse(await r.text()) as { error?: { type?: string; code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.type, "server_error");
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, true);
        assert.ok(json.error?.message?.includes("429"), `message names the cause (got: ${json.error?.message})`);
        assert.ok(json.error?.message?.includes("NOT forwarded"), `message states the payload was withheld (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight attempted the (429'd) summarization call");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #301: fitting payload + stale usage floor → forwarded with zero summarization calls (#4288)", async () => {
    const calls: Call[] = [];
    let streamCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                streamCalls += 1;
                // The first forward (big model) reports a 300k-token context
                // — a stale floor for the later small-model request.
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 300_000 : 1000));
            } else {
                res.writeHead(429, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, {
        "claude-big": { context: 400_000 },
        "claude-small": { context: 20_000 },
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "preflight-fits-429-sess" };

        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // The ~13k-token conversation FITS the 20k window, but the trigger
        // fires on the stale 300k floor. Since #4288 the round-top exit judges
        // on the payload's own floorless estimate: preflight runs, spends ZERO
        // summarization calls (no 429 can even happen), and the proxy forwards
        // the fitting payload immediately instead of burning the ladder.
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r2.status, 200, "a fitting payload is forwarded past the stale floor");
        await r2.text();

        assert.equal(calls.filter((c) => !c.stream).length, 0, "#4288: no summarization call is spent on an already-fitting payload");
        assert.equal(calls.filter((c) => c.stream).length, 2, "both requests were forwarded upstream");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #301: over-window payload with nothing compressible → structured 413 (#3461), no summary call, no forward", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // #330: a lone large user message is now foldable (the soft recent zone is
    // relaxed under overflow), so the truly-incompressible case is a large
    // HARD-protected tool result: its paired tool_use (name "bash") is in
    // protectedTools, so the result is excluded from every compressible range
    // — even after the soft zone is relaxed.
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } }, { protectedTools: ["bash"] });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const filler = "FILLER_".repeat(7000);
        seedEvidence("preflight-exhausted-sess", upstreamPort);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-exhausted-sess" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "echo hi" } }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: filler }] },
                ],
            }),
        });
        assert.equal(r.status, 413, "fail-fast 413 when nothing is compressible (#3461: deterministic exhaustion is non-retryable)");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false);
        assert.ok(json.error?.message?.includes("NOT forwarded"), `message states the payload was withheld (got: ${json.error?.message})`);
        assert.ok(json.error?.message?.includes("Raise the model context window"), `actionable error names the operator remedy (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization call was spent on an incompressible payload");
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #330: over-window payload whose only foldable content is in the protected recent zone → soft zone relaxed, folded, forwarded", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // Three messages against a 10k window: a small opener plus two large
        // recent messages (~6k tokens each, ~12k total). All three sit inside
        // the soft-protected recent zone (preserveRecentMessages=5 covers all
        // three), so the normal pass finds nothing foldable. Before #330 this
        // 502'd forever; now preflight relaxes the soft zone, folds the oldest
        // large message, and forwards the now-fitting payload. #470: the wire
        // overhead (injected compress system prompt + ACP tools, ~2.4k tokens)
        // now counts toward every size decision, so post-fold fit needs the
        // second big message at 24k chars, not 32k (the pre-#470 test was
        // forwarding a payload whose real billed input exceeded the window).
        const big1 = "A".repeat(24000);
        const big2 = "B".repeat(24000);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-relax-sess" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "user", content: "start the task" },
                    { role: "assistant", content: big1 },
                    { role: "user", content: big2 },
                ],
            }),
        });
        assert.equal(r.status, 200, "the over-window payload is folded and forwarded, not 502'd");
        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight made the summarization call to fold the protected message");
        assert.equal(calls.filter((c) => c.stream).length, 1, "the folded payload was forwarded upstream");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #470: system + tools overhead counts in the preflight trigger — text fits, wire overflows → preflight folds", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // The message text alone (~8.5k) fits the 10k window, but the wire
        // payload carries more: user system (~2k) + user tool (~1.2k) + the
        // injected compress system prompt + ACP tools (~2.4k) — the billed
        // input overflows. Before #470 the trigger counted messages only and
        // forwarded the payload verbatim (guaranteed upstream 400 later).
        const big1 = "A".repeat(34_000);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-overhead-sess" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                system: "S".repeat(8_000),
                tools: [{ name: "lookup", description: "T".repeat(4_600), input_schema: { type: "object", properties: {} } }],
                messages: [
                    { role: "user", content: "start the task" },
                    { role: "assistant", content: big1 },
                    { role: "user", content: "wrap up" },
                ],
            }),
        });
        assert.equal(r.status, 200, "the over-window (incl. system+tools) payload is folded and forwarded");
        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight made the summarization call — the trigger counted the wire overhead");
        assert.equal(calls.filter((c) => c.stream).length, 1, "the folded payload was forwarded upstream");
        const forwarded = calls.find((c) => c.stream)?.body ?? "";
        assert.ok(!forwarded.includes("A".repeat(100)), "the folded big message did NOT ride the forwarded payload");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #736: operator-shrunk window (compress.modelContextLimit below the model's declared window) → fail-fast names the setting", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // Same incompressible-payload shape as the #301 exhausted test, but the
    // 4k window is an OPERATOR override of the model's declared 10k — the
    // fail-fast must point at compress.modelContextLimit, not just say
    // "raise the model context window" (which sends operators to the upstream).
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } }, { protectedTools: ["bash"] }, { modelContextLimit: 4_000 });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const filler = "FILLER_".repeat(7000);
        seedEvidence("preflight-shrink-sess", upstreamPort);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-shrink-sess" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "echo hi" } }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: filler }] },
                ],
            }),
        });
        assert.equal(r.status, 413, "fail-fast 413 when nothing is compressible under the shrunken window (#3461)");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        const msg = json.error?.message ?? "";
        assert.ok(msg.includes("NOT forwarded"), `payload withheld (got: ${msg})`);
        assert.ok(msg.includes("effective window 4000"), `names the shrunken effective window (got: ${msg})`);
        assert.ok(msg.includes("full window 10000"), `names the model's full window (got: ${msg})`);
        assert.ok(msg.includes("compress.modelContextLimit"), `points at the operator setting (got: ${msg})`);
        assert.ok(!/\.\./.test(msg), `no doubled period (got: ${msg})`);
        assert.equal(calls.length, 0, "no upstream call was spent on an incompressible payload");

        // Negative control: the same payload with NO operator override must not
        // carry the shrink note (effective === full window).
        const proxyPlain = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } }, { protectedTools: ["bash"] });
        await once(proxyPlain, "listening");
        const plainPort = (proxyPlain.address() as { port: number }).port;
        seedEvidence("preflight-shrink-plain-sess", upstreamPort);
        const r2 = await fetch(`http://127.0.0.1:${plainPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-shrink-plain-sess" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "echo hi" } }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: filler }] },
                ],
            }),
        });
        assert.equal(r2.status, 413);
        const msg2 = (JSON.parse(await r2.text()) as { error?: { message?: string } }).error?.message ?? "";
        assert.ok(!msg2.includes("full window"), `no shrink note when the window was not operator-shrunk (got: ${msg2})`);
        proxyPlain.close();
        proxyPlain.closeIdleConnections?.();
        await once(proxyPlain, "close");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// #737 review: the shrink note must fire ONLY when bili deliberately shrank the
// window (operator override / codex align). On a NON-Anthropic turn the per-request
// output-headroom reservation (reserveOutputHeadroom = window - max_tokens) ALSO
// lowers reqConfig.modelContextLimit below the resolved native window — with no
// operator setting involved. Gating the note on `limit < resolvedNativeWindow` alone
// (the pre-fix logic) therefore blamed compress.modelContextLimit for a reduction
// the operator never made. This guards that path: an OpenAI-chat incompressible
// payload under a headroom-shrunk window must NOT carry the shrink note.
test("e2e #737: output-headroom-shrunk window (non-Anthropic, no operator override) → fail-fast does NOT name compress.modelContextLimit", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // Model declares a 10k window (registry table), NO operator override. The
    // OpenAI-chat endpoint reserves output headroom: max_tokens 4000 shrinks the
    // effective window 10000 -> 6000. A ~12k incompressible (hard-protected bash)
    // tool result overflows 6000 → fail-fast.
    const proxy = await startProxy(upstreamPort, { "gpt-small": { context: 10_000 } }, { protectedTools: ["bash"] });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const filler = "FILLER_".repeat(7000);
        seedEvidence("preflight-headroom-sess", upstreamPort);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-headroom-sess" },
            body: JSON.stringify({
                model: "gpt-small",
                max_tokens: 4_000,
                stream: true,
                messages: [
                    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
                    { role: "tool", tool_call_id: "call_1", content: filler },
                ],
            }),
        });
        assert.equal(r.status, 413, "fail-fast 413 when nothing is compressible under the headroom-shrunk window (#3461)");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        const msg = json.error?.message ?? "";
        assert.ok(msg.includes("NOT forwarded"), `payload withheld (got: ${msg})`);
        // Proves the headroom path was exercised: the reported window is the
        // 7500 after the #896-capped headroom reservation (min(max_tokens,
        // outputHeadroomMaxPct·window) = min(4000, 2500) = 2500 off 10000), not
        // the declared 10000.
        assert.ok(msg.includes("model window 7500"), `effective window reflects headroom reservation (got: ${msg})`);
        // Regression guard: the reduction here came from output-headroom, NOT an
        // operator setting — the shrink note must stay silent.
        assert.ok(!msg.includes("full window"), `no shrink note for a headroom-shrunk window (got: ${msg})`);
        assert.ok(!msg.includes("compress.modelContextLimit"), `does not blame an untouched operator setting (got: ${msg})`);
        assert.equal(calls.length, 0, "no upstream call was spent on an incompressible payload");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
