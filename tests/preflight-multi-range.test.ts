import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { MAX_SUMMARY_CALLS_PER_PREFLIGHT } from "../src/preflight.ts";

// #569: preflight must try EVERY viable range before declaring exhaustion.
// The legacy loop tried only the oldest range per round and failed the whole
// attempt (502 retryable=false, payload withheld) when that single range
// yielded nothing — while later ranges in the same history were compressible
// (the incident session was shrunk 88% by an in-band compress minutes later).

const SUMMARY_TEXT = "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

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

// `segments` blocks of 4 alternating user/assistant messages, each message
// ~5000 chars of a unique per-segment marker (~5000 tokens per segment). The
// kernel splits compressible ranges at user messages once a span holds 3+
// messages, so each segment lands in its own recommended range.
function segmentedConversation(segments: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let s = 0; s < segments; s++) {
        for (let i = 0; i < 4; i++) {
            const idx = s * 4 + i;
            const unit = `SEG${s}_M${idx}_pad_`;
            const filler = unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
            msgs.push({ role: idx % 2 === 0 ? "user" : "assistant", content: filler });
        }
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

function makeUpstream(badWhen: (raw: string) => boolean, calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                // A sub-MIN_SUMMARY_CHARS answer makes preflight treat the
                // summarization response as unusable.
                const text = badWhen(raw) ? "too short" : SUMMARY_TEXT;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_summary", type: "message", role: "assistant", model: "claude-small", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }));
            }
        });
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 12_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function post(proxyPort: number, upstreamPort: number, sessionId: string, messages: Array<{ role: string; content: string }>): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages }),
    });
}

test("e2e #569: oldest range's summary unusable → next viable range is compressed instead of fail-fast 502", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream((raw) => raw.includes("SEG0_"), calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // ~15k-token history against a 12k window. Every range containing
        // segment 0 returns an unusable summary; a later range compresses
        // cleanly. Legacy code stopped at the first (unusable) range and
        // returned 502 without forwarding.
        const messages = segmentedConversation(3);
        const r = await post(proxyPort, upstreamPort, "preflight-multirange-sess-1", messages);
        assert.equal(r.status, 200, "payload fits after folding a LATER range — no fail-fast 502");
        const forwarded = calls.filter((c) => c.stream);
        assert.equal(forwarded.length, 1, "the rebuilt (compressed) payload was forwarded");
        const fwdBody = JSON.parse(forwarded[0].body) as { messages?: Array<{ content?: unknown }> };
        const contentChars = (msgs: Array<{ content?: unknown }>): number =>
            msgs.reduce((sum, m) => {
                const c = m.content;
                if (typeof c === "string") return sum + c.length;
                if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text.length : 0), 0);
                return sum;
            }, 0);
        // Compare the HISTORY itself, not the whole wire body: the proxy
        // legitimately adds system prompt / tool definitions / nudge that the
        // client's raw request did not carry.
        assert.ok(contentChars(fwdBody.messages ?? []) < contentChars(messages), "the forwarded history is shorter than the client's original");
        assert.ok(forwarded[0].body.includes(SUMMARY_TEXT), "forwarded payload carries the fold summary");
        // Some non-leading span was folded away (a usable range cannot contain
        // segment 0, whose summaries are bad): the payload shrank and the
        // leading segment's raw text survived verbatim.
        assert.ok(forwarded[0].body.includes("SEG0_M0_pad_"), "the leading (unusable-summary) segment survives the fold");
        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 2, `preflight moved past the unusable first range (got ${summaryCalls.length} summarization calls)`);
        const sess = listSessions().find((s) => s.id === "preflight-multirange-sess-1");
        const blocks = (sess?.state.blocks ?? []).filter((b) => b.active);
        assert.equal(blocks.length, 1, "exactly one compression block created");
        assert.equal(blocks[0].summary, SUMMARY_TEXT);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #569: every range's summary unusable → truthful 502 after ALL ranges were tried", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(() => true, calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await post(proxyPort, upstreamPort, "preflight-multirange-sess-2", segmentedConversation(3));
        assert.equal(r.status, 502, "still fails closed when nothing across ANY range can be compressed");
        const json = JSON.parse(await r.text()) as { error?: { type?: string; code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.type, "server_error");
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false);
        assert.ok(json.error?.message?.includes("NOT forwarded"), `message states the payload was withheld (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
        // The legacy loop spent exactly ONE summarization call (oldest range
        // only); the fix must try every viable range before declaring
        // exhaustion. This conversation yields several viable ranges, so the
        // call count must exceed the legacy single attempt.
        const summaryCalls = calls.filter((c) => !c.stream).length;
        assert.ok(summaryCalls >= 2, `preflight tried every viable range before giving up (got ${summaryCalls} summarization calls)`);
        assert.ok(json.error?.message?.includes("range(s) tried"), `failure reports how many ranges were attempted (got: ${json.error?.message})`);
        const sess = listSessions().find((s) => s.id === "preflight-multirange-sess-2");
        assert.equal((sess?.state.blocks ?? []).filter((b) => b.active).length, 0, "nothing was folded");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #569: many unusable ranges → summarization calls capped per invocation", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(() => true, calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // 12 segments (~60k tokens) — far more viable ranges than the cap.
        const r = await post(proxyPort, upstreamPort, "preflight-multirange-sess-3", segmentedConversation(12));
        assert.equal(r.status, 502);
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.ok(json.error?.message?.includes(String(MAX_SUMMARY_CALLS_PER_PREFLIGHT)), `failure names the exhausted call budget (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => !c.stream).length, MAX_SUMMARY_CALLS_PER_PREFLIGHT, "summarization spend is bounded per invocation");
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
