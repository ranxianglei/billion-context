import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";

// #553: an ANONYMOUS request (no stable identity header/body field) resolves
// its session by prefix affinity. After an ACP compression breaks the chain
// hash, the client's replay mints a NEW session id (a fork) with
// lastInputTokens == 0 — yet it carries the full raw history. That payload was
// judged by the optimistic chars/4 estimator alone; code/JSON replays run far
// denser than 4 chars/token, so an over-window payload estimated UNDER the
// window triggered nothing and was forwarded raw (upstream 400 / long-prefill
// timeout). These tests assert the fixed behavior: unknown-baseline anonymous
// sessions are judged by the char-count upper bound (never undershoots),
// preflight compresses, and the rebuilt payload fits.
//
// The mock upstream ENFORCES the model window like a real provider, counting
// every character of the request body's text (the worst-case dense-code
// regime where tokens ≈ chars — the exact case the chars/4 estimator misses).

const SUMMARY_TEXT =
    "PREFLIGHT FORK SUMMARY: the segment covered a multi-step implementation session. " +
    "Key decisions: chose the streaming approach over batch because latency dominated. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: implemented and verified.";

const WINDOW = 40_000;

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

function textLen(b: unknown): number {
    if (b && typeof b === "object") {
        const t = (b as { text?: unknown }).text;
        if (typeof t === "string") return t.length;
    }
    return 0;
}

function contentChars(c: unknown): number {
    if (typeof c === "string") return c.length;
    if (!Array.isArray(c)) return 0;
    return c.reduce((n, b) => n + textLen(b), 0);
}

// Worst-case tokenizer model: 1 token per character (dense code/JSON).
function bodyChars(raw: string): number {
    let parsed: { system?: unknown; messages?: Array<{ content?: unknown }> } = {};
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 0;
    }
    let total = contentChars(parsed.system);
    for (const m of parsed.messages ?? []) total += contentChars(m.content);
    return total;
}

// 12 alternating messages of dense code-like ASCII, ~4k chars each → ~48k
// chars total. By the optimistic chars/4 estimator that is only ~12k tokens
// (< the 40k window — no trigger today); by the char-count upper bound it is
// ~48k (>= the window — preflight must fire).
function denseConversation(): Array<{ role: string; content: string }> {
    const line = (i: number) =>
        `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `CODE_${i}_` + line(i).repeat(37) });
    }
    return msgs;
}

test("e2e: fork/fresh session (lastInputTokens=0) with dense history that estimates under the window → preflight compresses before forward", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
    let streamCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                /* keep {} */
            }
            calls.push({ stream: !!parsed.stream, body: raw });
            // Enforce the model window on EVERY call, like a real provider:
            // the raw (uncompressed) dense history overflows it, so without
            // preflight the forward itself gets a 400.
            if (bodyChars(raw) > WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    type: "error",
                    error: { type: "invalid_request_error", message: `prompt is too long: exceeds ${WINDOW} maximum` },
                }));
                return;
            }
            if (parsed.stream) {
                streamCalls += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
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
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: WINDOW } } } },
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
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // No identity header or body field: the request is ANONYMOUS, so the
        // proxy resolves its session by prefix affinity — exactly what a fork
        // looks like after an ACP compression broke the chain hash (new pfa-
        // id, lastInputTokens = 0, full raw history replayed). The optimistic
        // estimate (~12k) is under the 40k window, so the old code forwarded
        // raw and the mock answered 400.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: denseConversation() }),
        });
        assert.equal(r.status, 200, "the fork-session request succeeds (no context-full error)");
        await r.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 1, `preflight made summarization call(s) before forwarding (got ${summaryCalls.length})`);
        for (const c of summaryCalls) {
            assert.ok(c.body.includes("Compression") || c.body.includes("compress"), "summarization call carries the compression rules");
        }

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `preflight created compression block(s) (got ${activeBlocks.length})`);
        assert.ok(activeBlocks.every((b) => b.summary === SUMMARY_TEXT), "blocks hold the upstream-written summaries");

        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(bodyChars(lastForward.body) <= WINDOW, "the forwarded payload fits the enforced window");
        assert.ok(!lastForward.body.includes("CODE_1_"), "compressed messages are out of the payload");
        assert.ok(lastForward.body.includes("CODE_11_"), "recent messages remain in the payload");
        assert.ok(lastForward.body.includes(SUMMARY_TEXT), "the preflight summary is in the rebuilt payload");

        // The successful turn's usage report corrects the char-based figure
        // to the measured size — the session is not stuck on an inflated one.
        assert.equal(s?.stats.lastInputTokens, 1000);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e: fresh session whose history genuinely fits the window → no preflight (conservative trigger does not over-fire)", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                /* keep {} */
            }
            calls.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(500));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }], stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: WINDOW } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // Small ANONYMOUS fresh session: both the optimistic estimate AND the
        // conservative char-count upper bound are far under the window, so the
        // trigger must stay quiet even in the conservative regime.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: [
                    { role: "user", content: "hello there" },
                    { role: "assistant", content: "hi, how can I help?" },
                    { role: "user", content: "what is the weather?" },
                    { role: "assistant", content: "I do not have live weather data." },
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();

        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization calls when the history fits");
        const s = listSessions()[0];
        assert.equal((s?.state.blocks ?? []).filter((b) => b.active).length, 0, "no blocks created");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
