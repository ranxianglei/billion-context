import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Zero the replay backoff so retry-budget assertions run instantly; the attempt
// COUNT (not the delay) is what those tests pin.
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { BILLING_ATTRIBUTION_PREFIX, extractBillingAttributionBlock, isCredentialShapeRejection } from "../src/preflight.ts";

// #2189: under subscription-OAuth Anthropic credentials the upstream answers
// every call whose system lacks Claude Code's billing-attribution block with
// 429 rate_limit_error "Error" — a credential-shape rejection wearing a
// rate-limit costume. The preflight summary side-path sent bili's own prompt
// string as the WHOLE system, so every summary call got 429, the over-window
// payload could never be folded, and the session fail-fast looped at 503
// forever. Fix: carry the client's billing-attribution block (verbatim,
// cache_control dropped) as system[0] of every anthropic summary call with the
// summary prompt at system[1]; and treat the bare-"Error" 429 signature as a
// deterministic rejection (one attempt, retryable=false, dead-end cooldown
// arms) instead of burning the 3-attempt replay budget each round.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed.";

const BILLING_TEXT = `${BILLING_ATTRIBUTION_PREFIX} cc_version=2.1.289.6d2; cc_entrypoint=cli; cch=00000;`;

const SHAPE_429_BODY = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "Error" },
    request_id: "req_2189_shape",
});
const GENUINE_429_BODY = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "Rate limit reached on requests. Please slow down." },
    request_id: "req_2189_genuine",
});

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

function ccSystem(): Array<{ type: string; text: string; cache_control?: { type: string } }> {
    return [
        { type: "text", text: BILLING_TEXT, cache_control: { type: "ephemeral" } },
        { type: "text", text: "You are Claude Code, an interactive CLI tool." },
    ];
}

type Call = { stream: boolean; body: string };

function makeUpstream(calls: Call[], summaryStatus: number, summaryBody: string): http.Server {
    let streamCalls = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                // Main-lane forward: normal 200 SSE. The first one reports a
                // 300k-token context (arms the session baseline) so the next
                // small-window request triggers preflight.
                streamCalls += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 300_000 : 1000));
            } else if (summaryStatus >= 400) {
                res.writeHead(summaryStatus, { "content-type": "application/json" });
                res.end(summaryBody);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
}

async function makePair(calls: Call[], summaryStatus: number, summaryBody: string, log = false) {
    const upstream = makeUpstream(calls, summaryStatus, summaryBody);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: 12_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

function drive(proxyPort: number, upstreamPort: number, sid: string, body: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sid },
        body: JSON.stringify(body),
    });
}

test("#2189 extractBillingAttributionBlock finds the client attribution block", () => {
    const out = extractBillingAttributionBlock(ccSystem());
    assert.deepEqual(out, { type: "text", text: BILLING_TEXT });
    // Mid-array placement survives too — scan, not index-0-only.
    const mid = extractBillingAttributionBlock([
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: BILLING_TEXT, cache_control: { type: "ephemeral" } },
    ]);
    assert.deepEqual(mid, { type: "text", text: BILLING_TEXT });
    // Leading whitespace tolerated; the returned text is verbatim.
    const ws = extractBillingAttributionBlock([{ type: "text", text: `  ${BILLING_TEXT}` }]);
    assert.deepEqual(ws, { type: "text", text: `  ${BILLING_TEXT}` });
    assert.equal(extractBillingAttributionBlock("plain string system"), undefined);
    assert.equal(extractBillingAttributionBlock(undefined), undefined);
    assert.equal(extractBillingAttributionBlock([]), undefined);
    assert.equal(extractBillingAttributionBlock([{ type: "text", text: "no attribution here" }]), undefined);
    assert.equal(extractBillingAttributionBlock([{ type: "text", text: "X-Anthropic-Billing-Header: wrong case" }]), undefined);
    assert.equal(extractBillingAttributionBlock([{ type: "image", text: BILLING_TEXT }]), undefined);
});

test("#2189 isCredentialShapeRejection matches only the bare-Error 429 signature", () => {
    assert.equal(isCredentialShapeRejection(429, SHAPE_429_BODY), true);
    assert.equal(isCredentialShapeRejection(429, GENUINE_429_BODY), false, "descriptive limit wording must not trip it");
    assert.equal(isCredentialShapeRejection(500, SHAPE_429_BODY), false);
    assert.equal(isCredentialShapeRejection(429, "not json"), false);
    assert.equal(isCredentialShapeRejection(429, JSON.stringify({ error: { message: "Error" } })), false);
    assert.equal(isCredentialShapeRejection(429, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Error" } })), false);
    assert.equal(isCredentialShapeRejection(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error!" } })), false);
});

test("#2189 anthropic summary carries the client billing-attribution block at system[0]", async () => {
    const calls: Call[] = [];
    const { proxy, upstream, proxyPort, upstreamPort } = await makePair(calls, 200, "");
    try {
        const r1 = await drive(proxyPort, upstreamPort, "s2189-main", {
            model: "claude-big", max_tokens: 1024, stream: true, system: ccSystem(), messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await drive(proxyPort, upstreamPort, "s2189-main", {
            model: "claude-small", max_tokens: 1024, stream: true, system: ccSystem(), messages: bigConversation(),
        });
        assert.equal(r2.status, 200, "preflight must succeed once the summary call carries the attribution block");
        await r2.text();

        const summaries = calls.filter((c) => !c.stream);
        assert.ok(summaries.length >= 1, `expected summarization call(s), got ${calls.length} total`);
        for (const s of summaries) {
            const parsed = JSON.parse(s.body) as { system?: unknown };
            assert.ok(Array.isArray(parsed.system), "summary system must be a block array when the client sent one");
            const arr = parsed.system as Array<Record<string, unknown>>;
            assert.equal(arr.length, 2, "attribution block + summary prompt, nothing else");
            assert.deepEqual(arr[0], { type: "text", text: BILLING_TEXT }, "system[0] is the client block verbatim");
            assert.equal(Object.keys(arr[0]!).sort().join(","), "text,type", "cache_control and any other keys are dropped");
            assert.match(String(arr[1]?.text), /compress/i, "system[1] is the bili summary prompt");
        }

        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward?.body.includes(BILLING_TEXT), "the MAIN forward still carries the client attribution block (main lane untouched)");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#2189 legacy string system keeps the byte-identical summary shape", async () => {
    const calls: Call[] = [];
    const { proxy, upstream, proxyPort, upstreamPort } = await makePair(calls, 200, "");
    try {
        const sys = "You are a helpful assistant.";
        const r1 = await drive(proxyPort, upstreamPort, "s2189-legacy", {
            model: "claude-big", max_tokens: 1024, stream: true, system: sys, messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await drive(proxyPort, upstreamPort, "s2189-legacy", {
            model: "claude-small", max_tokens: 1024, stream: true, system: sys, messages: bigConversation(),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        const summaries = calls.filter((c) => !c.stream);
        assert.ok(summaries.length >= 1, "preflight must still fire");
        for (const s of summaries) {
            const parsed = JSON.parse(s.body) as { system?: unknown };
            assert.equal(typeof parsed.system, "string", "string systems keep the legacy string shape");
            assert.match(parsed.system as string, /compress/i);
        }
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#2189 bare-Error 429 fails fast after ONE attempt, retryable=false, retries re-run bounded", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    const calls: Call[] = [];
    const { proxy, upstream, proxyPort, upstreamPort } = await makePair(calls, 429, SHAPE_429_BODY, true);
    try {
        const r1 = await drive(proxyPort, upstreamPort, "s2189-shape", {
            model: "claude-big", max_tokens: 1024, stream: true, system: ccSystem(), messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const body2 = { model: "claude-small", max_tokens: 1024, stream: true, system: ccSystem(), messages: bigConversation() };
        const r2 = await drive(proxyPort, upstreamPort, "s2189-shape", body2);
        assert.equal(r2.status, 503);
        const j2 = (await r2.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(j2.error?.code, "preflight_compress_failed");
        assert.equal(j2.error?.retryable, false, "shape rejection is deterministic — do not advertise retryability");
        assert.ok(j2.error?.message?.includes("credential-shape"), `detail must name the suspected cause, got: ${j2.error?.message}`);
        const summaries = calls.filter((c) => !c.stream);
        assert.equal(summaries.length, 1, `must not burn the 3-attempt replay budget, got ${summaries.length} summary calls`);
        assert.ok(lines.some((l) => l.includes("suspected credential-shape rejection")), "named warn log present");
        const sess = listSessions().find((s) => s.id.includes("s2189-shape"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker is written anymore");

        // The identical retry re-runs the walk and fails the same deterministic
        // way (shape rejection) without re-burning the 3-attempt replay budget.
        const before = calls.length;
        const r3 = await drive(proxyPort, upstreamPort, "s2189-shape", body2);
        assert.equal(r3.status, 503);
        const j3 = (await r3.json()) as { error?: { message?: string; retryable?: boolean } };
        assert.equal(j3.error?.retryable, false);
        assert.ok(j3.error?.message?.includes("credential-shape"), `detail still names the cause, got: ${j3.error?.message}`);
        const retrySummaries = calls.slice(before).filter((c) => !c.stream);
        assert.equal(retrySummaries.length, 1, `the re-run walk spends exactly one summary probe (#4079 trade), got ${retrySummaries.length}`);
    } finally {
        setLogCapture(null);
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#2189 a genuine rate limit keeps the legacy 3-attempt replay and retryable=true", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    const calls: Call[] = [];
    const { proxy, upstream, proxyPort, upstreamPort } = await makePair(calls, 429, GENUINE_429_BODY, true);
    try {
        const r1 = await drive(proxyPort, upstreamPort, "s2189-genuine", {
            model: "claude-big", max_tokens: 1024, stream: true, system: ccSystem(), messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await drive(proxyPort, upstreamPort, "s2189-genuine", {
            model: "claude-small", max_tokens: 1024, stream: true, system: ccSystem(), messages: bigConversation(),
        });
        assert.equal(r2.status, 503);
        const j2 = (await r2.json()) as { error?: { message?: string; retryable?: boolean } };
        assert.equal(j2.error?.retryable, true, "genuine limits stay retryable");
        assert.ok(j2.error?.message?.includes("rate-limited by the upstream (HTTP 429)"), `legacy detail wording kept, got: ${j2.error?.message}`);
        assert.equal(calls.filter((c) => !c.stream).length, 3, "full replay budget burned (legacy behavior)");
        assert.ok(lines.some((l) => l.includes("[preflight] summary attempt 2 got HTTP 429")), "retry log present");
        const sess = listSessions().find((s) => s.id.includes("s2189-genuine"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "genuine limit writes no dead-end marker (#4079)");
    } finally {
        setLogCapture(null);
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
