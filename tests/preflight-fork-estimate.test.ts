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
import { listSessions, _resetSessionsForTest } from "../src/session.ts";

// #553 / #3146: an ANONYMOUS request (no stable identity header/body field)
// resolves its session by prefix affinity. After an ACP compression breaks the
// chain hash the client's replay mints a NEW session id (a fork) with
// lastInputTokens == 0 — yet it carries the full raw history.
//
// #553 fixed the UNDERSHOOT: such a session is TRIGGERED on the char-count
// upper bound (never undershoots dense replays). #3146 found the mirror
// failure: that same char bound was ALSO used as the REJECT-FORWARD gate, so a
// payload whose REAL token count fits the window but whose CHAR COUNT exceeds
// it was judged over-window and fail-fasted (502) after burning every preflight
// round — even though the fold succeeded and the upstream would have billed far
// under the window. Fix: the char bound stays the TRIGGER arm only; every fit
// decision (per-round exit, final fitsWindow, the early no-ranges gate) judges
// on the calibrated CJK-aware estimate.
//
// The mock upstream therefore ENFORCES the model window on a REALISTIC
// tokenizer — the same CJK-aware caliber bili itself estimates with (CJK
// ideographs/syllables ~1 token each, everything else ~1 token / 4 chars). The
// original #553 mock counted every character as a token (tokens ≈ chars), a
// pathological density no live route sustains that #3146 deliberately stops
// defending against with slow compress-to-fit.

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

// Realistic tokenizer model matching bili's own CJK-aware estimator (kernel
// defaultCountTokens): CJK ideographs/syllables bill ~1 token each, everything
// else ~1 token per 4 characters.
function realisticTokens(text: string): number {
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    return cjk + Math.ceil((text.length - cjk) / 4);
}

function textBlockTokens(b: unknown): number {
    if (b && typeof b === "object") {
        const t = (b as { text?: unknown }).text;
        if (typeof t === "string") return realisticTokens(t);
    }
    return 0;
}

function contentTokens(c: unknown): number {
    if (typeof c === "string") return realisticTokens(c);
    if (!Array.isArray(c)) return 0;
    return c.reduce((n, b) => n + textBlockTokens(b), 0);
}

// Realistic token count of the request body's text (system + messages).
function bodyTokens(raw: string): number {
    let parsed: { system?: unknown; messages?: Array<{ content?: unknown }> } = {};
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 0;
    }
    let total = contentTokens(parsed.system);
    for (const m of parsed.messages ?? []) total += contentTokens(m.content);
    return total;
}

// 12 alternating messages of dense code-like ASCII, ~4k chars each → ~48k
// CHARS total (exceeds the 40k window as a raw character count) but only
// ~12k REALISTIC TOKENS (well under the 40k window). This is the exact #3146
// shape: the old char-count reject-forward gate read it as over-window; the
// calibrated CJK-aware estimate correctly reads it as fitting.
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

test("e2e: fork/fresh session (lastInputTokens=0) whose realistic size fits the window but whose char count exceeds it → forwarded without a false context-full error (#3146)", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
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
            // Enforce the model window on EVERY call, like a real provider, on a
            // REALISTIC tokenizer. The raw dense history bills ~12k tokens, under
            // the 40k window — so a correct fit judgment forwards it successfully.
            if (bodyTokens(raw) > WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    type: "error",
                    error: { type: "invalid_request_error", message: `prompt is too long: exceeds ${WINDOW} maximum` },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(1000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

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
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // No identity header or body field: the request is ANONYMOUS, so the
        // proxy resolves its session by prefix affinity — exactly what a fork
        // looks like after an ACP compression broke the chain hash (new pfa-id,
        // lastInputTokens = 0, full raw history replayed). Its raw char count
        // (~48k) exceeds the 40k window, but its realistic token count (~12k)
        // fits. The old char-count reject-forward gate judged it over-window and
        // fail-fast 502'd (after burning preflight rounds); the fix judges it on
        // the calibrated estimate and forwards.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: denseConversation() }),
        });
        assert.equal(r.status, 200, "the fork/fresh session forwards successfully (no false context-full error, #3146)");
        await r.text();

        // #3146: the calibrated estimate already fits the window, so preflight
        // burns ZERO summarization rounds — the old char-count fit gate would
        // have folded (≥1 call) or fail-fast 502'd here.
        const summaryCalls = calls.filter((c) => !c.stream);
        assert.equal(summaryCalls.length, 0, "preflight makes no summarization call: the calibrated estimate already fits the window (#3146)");

        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(bodyTokens(lastForward.body) <= WINDOW, "the forwarded payload fits the enforced (realistic) window");
        assert.ok(lastForward.body.includes("CODE_11_"), "recent messages remain in the payload");

        // The successful turn's usage report corrects the estimate to the
        // measured size — the session is not stuck on an inflated figure.
        const s = listSessions()[0];
        assert.equal(s?.stats.lastInputTokens, 1000);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
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
    const upstreamPort = (upstream.address() as { port: number }).port;

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
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

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
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
