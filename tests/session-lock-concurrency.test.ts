import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const MODEL = "claude-sonnet-4-5";
const SESSION = "970-concurrent-same-session";
// Slow-upstream first-byte delay. Under the pre-fix coarse lock the second
// request could only reach the upstream AFTER the first request's whole
// response finished, so the gap between the two upstream arrivals was >= this
// value. Concurrent forwarding must close them within a fraction of it.
const FIRST_BYTE_DELAY_MS = 400;

interface UpstreamHit {
    start: number;
    firstByte: number;
    end: number;
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function textScript(msgId: string, text: string): string {
    return [
        sseBlock("message_start", { message: { id: msgId, role: "assistant", usage: { input_tokens: 40 } } }),
        sseBlock("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        sseBlock("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
        sseBlock("content_block_stop", { index: 0 }),
        sseBlock("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
        sseBlock("message_stop", {}),
    ].join("");
}

test("#970: concurrent requests on the same session id forward concurrently (no head-of-line blocking)", async () => {
    const hits: UpstreamHit[] = [];
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            const hit: UpstreamHit = { start: Date.now(), firstByte: 0, end: 0 };
            hits.push(hit);
            setTimeout(() => {
                res.writeHead(200, { "content-type": "text/event-stream" });
                hit.firstByte = Date.now();
                res.write(textScript(`msg_${hits.length}`, `reply ${hits.length}`));
                hit.end = Date.now();
                res.end();
            }, FIRST_BYTE_DELAY_MS);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    const proxyPort = proxy.address().port as number;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    const post = (text: string) =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: text }] }),
        });

    try {
        const [resA, resB] = await Promise.all([post("subagent task A"), post("subagent task B")]);
        const [bodyA, bodyB] = await Promise.all([resA.text(), resB.text()]);
        assert.equal(resA.status, 200, `request A: ${bodyA.slice(0, 300)}`);
        assert.equal(resB.status, 200, `request B: ${bodyB.slice(0, 300)}`);
        assert.ok(bodyA.includes("message_stop"), "request A stream incomplete");
        assert.ok(bodyB.includes("message_stop"), "request B stream incomplete");

        assert.equal(hits.length, 2, `expected 2 upstream hits, got ${hits.length}`);
        const [first, second] = [...hits].sort((a, b) => a.start - b.start);
        const gap = second.start - first.start;
        assert.ok(
            gap < FIRST_BYTE_DELAY_MS / 2,
            `second request reached the upstream ${gap}ms after the first — it queued behind the first request's stream instead of forwarding concurrently`,
        );
        assert.ok(first.firstByte - first.start >= FIRST_BYTE_DELAY_MS * 0.8, "mock upstream did not hold the first byte as configured");

        const session = peekSession(SESSION);
        assert.ok(session, "both requests must share one session keyed by x-claude-code-session-id");
        assert.equal(session!.stats.requests, 2, "both turns must accumulate on the same session");
        const byRef = session!.state.messageRefs.byRef as Record<string, unknown>;
        const rawIds = Object.values(byRef).map(String);
        assert.equal(new Set(rawIds).size, rawIds.length, "ref numbers must map to unique raw message ids (no re-issue under concurrent prepares)");

        const resC = await post("main session continues");
        const bodyC = await resC.text();
        assert.equal(resC.status, 200, `follow-up request after concurrent burst: ${bodyC.slice(0, 300)}`);
        assert.ok(bodyC.includes("message_stop"), "follow-up stream incomplete");
        assert.equal(peekSession(SESSION)!.stats.requests, 3, "follow-up must land on the same session");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
