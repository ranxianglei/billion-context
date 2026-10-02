import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1812: a vLLM server behind a relay rejects oversized requests with
// "prompt (N tokens) + max tokens (M) exceeds the context (W); requests are
// never truncated" — a phrasing the pre-#1812 detector did not recognize (no
// word "window"), so the 400 passed through verbatim and the client retried
// into a hard loop. The review on #1812 settled the semantics:
//   - recognition MUST match this dialect (arms the one-shot rescue), but the
//     numbers stated in the vLLM error text are NOT extracted as a window
//     source — error-text learning proved unstable (relay rewrites, dialect
//     drift); the durable fix is the operator declaring the real window, and
//     the proxy says so once (source=default guidance warn);
//   - dialects whose window bili has always trusted (#570-era sglang
//     "context length (W tokens)") keep the full refold rescue: fold + clamp
//     against the stated window for exactly one retry;
//   - with the window configured CORRECTLY, the first forward's output clamp
//     already prevents the overflow — no 400 at all.
const REAL_WINDOW = 131_072;
const DECLARED_WINDOW = 200_000;

function vllmOverflowBody(promptTokens: number, maxTokens: number): string {
    return JSON.stringify({
        error: {
            type: "invalid_request_error",
            message: `prompt (${promptTokens} tokens) + max tokens (${maxTokens}) exceeds the context (${REAL_WINDOW}); requests are never truncated`,
        },
    });
}

function sglangOverflowBody(promptTokens: number): string {
    return JSON.stringify({
        object: "error",
        message: `The input (${promptTokens} tokens) is longer than the model's context length (${REAL_WINDOW} tokens). (input tokens ${promptTokens} > context length ${REAL_WINDOW - 4096} - remaining tokens 4096)`,
        type: "invalid_request_error",
    });
}

interface RecordedUpstream {
    server: http.Server;
    port: number;
    bodies: string[];
}

async function recordedUpstream(errorBody: (promptTokens: number, maxTokens: number) => string): Promise<RecordedUpstream> {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const parsed = JSON.parse(raw) as { max_tokens?: number; max_completion_tokens?: number };
            const requested = typeof parsed.max_tokens === "number" ? parsed.max_tokens : typeof parsed.max_completion_tokens === "number" ? parsed.max_completion_tokens : 0;
            const promptTokens = defaultCountTokens(raw);
            if (promptTokens + requested > REAL_WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(errorBody(promptTokens, requested));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const chunk = (choices: unknown): void =>
                res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "local-model", choices })}\n\n`);
            chunk([{ index: 0, delta: { role: "assistant", content: "" } }]);
            chunk([{ index: 0, delta: { content: "ok" } }]);
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port, bodies };
}

function proxyBaseOptions(upstreamPort: number, declaredWindow: number): ProxyOptions {
    // declaredWindow is what the operator told bili (routes.models.context) —
    // REAL_WINDOW (correct) or DECLARED_WINDOW (the #1812 mis-sizing).
    const routes = declaredWindow === REAL_WINDOW ? { [`http://127.0.0.1:${upstreamPort}`]: { models: { "local-model": { context: REAL_WINDOW } } } } : {};
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: declaredWindow,
        kernelConfig: defaultConfig(declaredWindow),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function withScenario(declaredWindow: number, errorBody: (p: number, m: number) => string, run: (proxyPort: number, upstream: RecordedUpstream) => Promise<void>): Promise<void> {
    const upstream = await recordedUpstream(errorBody);
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstream.port, declaredWindow));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await run(proxyPort, upstream);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.server.close();
        await once(upstream.server, "close");
    }
}

// Three ~100k-char messages ≈ 75k tokens: the INPUT alone fits under the real
// 131072 window, but input + the client's 65536 max_tokens does not. Nothing is
// foldable (all three sit inside preserveRecentMessages), so the only possible
// rescue is the output clamp.
function oversizedTurn(): { messages: { role: string; content: string }[]; body: string } {
    const messages = [0, 1, 2].map((i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `MARKER_${i}_content_`.repeat(5882) }));
    return { messages, body: JSON.stringify({ model: "local-model", max_tokens: 65_536, stream: true, messages }) };
}

test("e2e #1812 A: configured real window — the FIRST forward's clamp already prevents the overflow, client sees 200, no rejection at all", async () => {
    await withScenario(REAL_WINDOW, vllmOverflowBody, async (proxyPort, upstream) => {
        const { body } = oversizedTurn();
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "issue1812-a" };

        const r = await fetch(url, { method: "POST", headers, body });
        assert.equal(r.status, 200, "correct configuration means the overflow never happens");
        assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
        const text = await r.text();
        assert.ok(text.includes('"ok"'), "the SSE stream is delivered");
        assert.ok(text.includes("[DONE]"), "the stream terminates cleanly");

        assert.equal(upstream.bodies.length, 1, `exactly one forward, the clamp did its job before the wire: ${upstream.bodies.length}`);
        const sent = JSON.parse(upstream.bodies[0]) as { max_tokens?: number };
        assert.ok(typeof sent.max_tokens === "number" && sent.max_tokens < 65_536, `max_tokens was clamped against the configured window: ${sent.max_tokens}`);
        assert.ok(
            defaultCountTokens(upstream.bodies[0]) + (sent.max_tokens ?? 0) <= REAL_WINDOW,
            `the sent body provably fits the real window (${defaultCountTokens(upstream.bodies[0])} + ${sent.max_tokens})`,
        );

        const s = listSessions().find((x) => x.id === "issue1812-a");
        assert.ok(s, "session exists");
        assert.equal(s!.stats.overflowArmTokens, undefined, "no overflow — nothing armed");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "nothing learned");
    });
});

test("e2e #1812 A2: sglang-stated window — refold rescue kept for trusted dialects: reject → fold/clamp against the stated window → one retry → 200", async () => {
    await withScenario(DECLARED_WINDOW, sglangOverflowBody, async (proxyPort, upstream) => {
        const { body } = oversizedTurn();
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "issue1812-a2" };

        const r = await fetch(url, { method: "POST", headers, body });
        assert.equal(r.status, 200, "the client never sees the 400 — the stated-window refold rescues the turn");
        assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
        const text = await r.text();
        assert.ok(text.includes('"ok"'), "the retry's SSE stream is delivered");

        assert.equal(upstream.bodies.length, 2, `one rejected forward + one clamped retry: ${upstream.bodies.length}`);
        const first = JSON.parse(upstream.bodies[0]) as { max_tokens?: number };
        const second = JSON.parse(upstream.bodies[1]) as { max_tokens?: number };
        assert.equal(first.max_tokens, 65_536, "the first forward (declared 200k) left the requested budget untouched");
        assert.ok(typeof second.max_tokens === "number" && second.max_tokens < 65_536, `the retry's max_tokens was clamped to the stated window: ${second.max_tokens}`);
        assert.ok(
            defaultCountTokens(upstream.bodies[1]) + (second.max_tokens ?? 0) <= REAL_WINDOW,
            `the retried body provably fits the real window (${defaultCountTokens(upstream.bodies[1])} + ${second.max_tokens})`,
        );

        const s = listSessions().find((x) => x.id === "issue1812-a2");
        assert.ok(s, "session exists");
        assert.equal(s!.stats.lastInputTokens, REAL_WINDOW, "armed at the stated window (sglang dialect is a trusted #570-era source)");
        assert.equal(s!.stats.lastInputTokensSource, "usage");
        assert.equal(s!.stats.overflowArmTokens, REAL_WINDOW, "#1110 arm record at the stated window");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned — the declared window keeps governing");
    });
});

test("e2e #1812 B: vLLM dialect, unconfigured window — no number trusted from the error text, the original 400 passes through honestly, no loop", async () => {
    await withScenario(DECLARED_WINDOW, vllmOverflowBody, async (proxyPort, upstream) => {
        const { body } = oversizedTurn();
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "issue1812-b" };

        const r = await fetch(url, { method: "POST", headers, body });
        assert.equal(r.status, 400, "honest failure: the vLLM dialect's numbers are not trusted as a window source");
        const errText = await r.text();
        assert.match(errText, /exceeds the context/, "the upstream's verbatim error is surfaced to the client");
        assert.equal(upstream.bodies.length, 1, "exactly one forward — the unchanged refold body is never re-sent, no 400 loop");

        const s = listSessions().find((x) => x.id === "issue1812-b");
        assert.ok(s, "session exists");
        assert.ok(typeof s!.stats.overflowArmTokens === "number" && s!.stats.overflowArmTokens > 0, "the shrink is armed at the payload estimate for the next turn");
        assert.equal(s!.stats.lastInputTokensSource, "usage");
        assert.notEqual(s!.stats.lastInputTokens, REAL_WINDOW, "no window learned from the error text");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "nothing learned");
        // The durable fix is configuration: the guidance warn (source=default)
        // points the operator at providers.<url>.models.<model>.context.
    });
});
