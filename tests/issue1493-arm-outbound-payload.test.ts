import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// #1688: these scenarios assert the single-attempt network-failure shape (first
// socket drop → immediate 502 → arm); pin the legacy no-retry budget so the
// first drop still surfaces as 502 instead of being transparently replayed.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1493: a no-usage upstream failure (relay 5xx / network drop) armed the
// emergency shrink from estimateTokensFast(<raw JSON body>) — a chars/4 count
// that inflates base64 images and dense payloads to RAW-history scale. That
// poisoned value fed the preflight trigger floor (Math.max(lastInputTokens,
// payloadEstimate)) and the nudge baseline, firing a 42–203s preflight on a
// payload that actually fit the window. The fix arms from the SAME outbound
// payload estimate the fit gate uses (outboundPayloadBreakdown), so a fitting
// payload never crosses the kernel emergency band.
//
// Fixture shape (deterministic, no real model): the wire body carries ONE large
// base64 image. Its chars/4 alone crosses the 0.95×window emergency band (the
// old estimator), but billed by pixels (the resolved mode here) the image costs
// only the flat fallback — so the true outbound payload sits well under the band.
// A fresh session means nothing is folded yet, so the divergence is purely the
// estimator mismatch, isolating the exact bug.

const WINDOW = 32_000;
const IMG_BYTES = 120_000; // → 160_000 base64 chars; chars/4 ≈ 40K (crosses band), pixel-billed ≈ 16K (fits)

const RELAY_ERROR_BODY = JSON.stringify({
    error: { type: "new_api_error", message: "upstream error: do request failed" },
});

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

/** One user turn: short text + one large base64 image. The 'A'-fill decodes to
 *  0x41… — no PNG/JPEG/WebP/GIF/BMP signature — so pixels billing takes the flat
 *  fallback cost (deterministic, independent of real image dimensions). */
function imageConversation(): unknown[] {
    const b64 = Buffer.alloc(IMG_BYTES, 0x41).toString("base64");
    return [
        {
            role: "user",
            content: [
                { type: "text", text: "What is in this image?" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
            ],
        },
    ];
}

interface RelayOpts {
    failFirstStreamingWith?: number;
    destroyFirst?: boolean;
    /** 1-based streaming-call index that fails (default 1). F2 needs failure on
     *  the SECOND call: the first establishes the session with a healthy turn. */
    failStreamingCall?: number;
}

/** Mock relay: fails the FIRST streaming call (5xx or socket drop), then serves
 *  everything else with a healthy SSE response reporting input_tokens: 5000. */
function makeRelay(opts: RelayOpts) {
    const received: Buffer[] = [];
    let streamingCall = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* non-JSON */ }
            if (parsed.stream !== true) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_summary", type: "message", role: "assistant", model: "claude-relay", content: [{ type: "text", text: "SUMMARY" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }));
                return;
            }
            streamingCall += 1;
            const failAt = opts.failStreamingCall ?? 1;
            if (opts.destroyFirst && streamingCall === failAt) { req.socket.destroy(); return; }
            if (opts.failFirstStreamingWith && streamingCall === failAt) {
                res.writeHead(opts.failFirstStreamingWith, { "content-type": "application/json" });
                res.end(RELAY_ERROR_BODY);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    return { server, received };
}

async function startProxy(upstreamPort: number, imageBilling: "pixels"): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        imageBilling,
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
    return { proxy, port: proxy.address().port };
}

function assertArmedBelowBand(relay: ReturnType<typeof makeRelay>, sessionId: string | undefined, label: string): void {
    const s = listSessions().find((x) => x.id === sessionId);
    assert.ok(s, `${label}: a session exists for the failed request`);
    assert.equal(s!.stats.lastInputTokensSource, "estimate", `${label}: armed baseline is tagged as an estimate`);
    assert.ok(s!.stats.lastInputTokens > 0, `${label}: the emergency shrink was armed`);
    const sentLen = relay.received[0]?.length ?? 0;
    // Precondition: the fixture genuinely diverges — the OLD chars/4 estimator
    // of the raw wire body crosses the emergency band…
    assert.ok(
        Math.ceil(sentLen / 4) >= 0.95 * WINDOW,
        `${label}: fixture diverges (raw body chars/4=${Math.ceil(sentLen / 4)} >= band ${0.95 * WINDOW})`,
    );
    // …but the armed value must track the OUTBOUND (pixel-billed) payload and stay
    // BELOW the band, so the next request does not fire a pointless preflight.
    assert.ok(
        s!.stats.lastInputTokens < 0.95 * WINDOW,
        `${label}: armed value is the outbound payload, below the emergency band (${s!.stats.lastInputTokens} < ${0.95 * WINDOW})`,
    );
}

test("#1493: network-level failure arms at the outbound payload (fits) → below the emergency band", async () => {
    const relay = makeRelay({ destroyFirst: true });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort, "pixels");

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: imageConversation() });
        const idsBefore = new Set(listSessions().map((x) => x.id));

        const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "net-sess" }, body });
        assert.equal(r1.status, 502, "network failure surfaces as bili's 502");
        await r1.text();

        const sid = listSessions().find((x) => !idsBefore.has(x.id))?.id;
        assertArmedBelowBand(relay, sid, "network-failure");

        // Recovery: the retry forwards cleanly — no preflight shrink is needed
        // because the payload already fits, and the real usage report lands.
        const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "net-sess" }, body });
        assert.equal(r2.status, 200, "retry recovers");
        await r2.text();
        const s2 = listSessions().find((x) => x.id === sid);
        assert.equal(s2?.stats.lastInputTokens, 5000, "real usage report overwrote the armed value");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("#1493: relay 5xx arms at the outbound payload (fits) → below the emergency band", async () => {
    const relay = makeRelay({ failFirstStreamingWith: 500 });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort, "pixels");

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: imageConversation() });
        const idsBefore = new Set(listSessions().map((x) => x.id));

        const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "five-sess" }, body });
        assert.equal(r1.status, 500, "relay 5xx passed through to the client");
        await r1.text();

        const sid = listSessions().find((x) => !idsBefore.has(x.id))?.id;
        assertArmedBelowBand(relay, sid, "relay-5xx");

        const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "five-sess" }, body });
        assert.equal(r2.status, 200, "retry recovers");
        await r2.text();
        const s2 = listSessions().find((x) => x.id === sid);
        assert.equal(s2?.stats.lastInputTokens, 5000, "real usage report overwrote the armed value");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("#1498-F2: transform-failure fallback arms at the RAW view, not wire overhead", async () => {
    // Scene: turn 1 healthy (usage 5000). Turn 2's kernel transform throws
    // (broken state) → processedMessages = [] → the outbound IS the raw client
    // body — the very scene #1493's fix claims to handle. Pre-rework the
    // estimator saw only wire overhead (~hundreds of tokens) and the rescue
    // never armed; it must measure the raw view instead.
    const relay = makeRelay({ failFirstStreamingWith: 500, failStreamingCall: 2 });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort, "pixels");

    const TEXT_CHARS = 60_000;
    const history = [{ role: "user", content: "x".repeat(TEXT_CHARS) }];
    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "x-acp-session": "f2-sess" };
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: history });

        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        const s1 = listSessions().find((x) => x.stats.lastInputTokens === 5000);
        assert.ok(s1, "turn 1 reported usage (lastInputTokens = 5000)");

        // Break the kernel state so turn 2's transform throws (the same seam
        // tests/count-tokens.test.ts uses) → fallback forwards the raw body.
        (s1 as unknown as { state: { messageRefs: null } }).state.messageRefs = null;

        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 500, "relay 5xx passes through on the fallback turn");
        await r2.text();

        const s2 = listSessions().find((x) => x.id === s1!.id);
        assert.equal(s2?.stats.lastInputTokensSource, "estimate", "armed baseline is tagged as an estimate");
        assert.ok(
            (s2?.stats.lastInputTokens ?? 0) >= TEXT_CHARS,
            `fallback arm must measure the RAW view (>= ${TEXT_CHARS} char bound), got ${s2?.stats.lastInputTokens} — overhead-only arming never rescues the #604 deadlock`,
        );
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});
