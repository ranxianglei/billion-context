// #2847: the doomed probe (#2490) answers a mathematically-determined
// overflow with HTTP 502 while the body says `"retryable": false`. Hosts that
// decide on the STATUS CODE (pi: retry.maxRetries=20 / baseDelayMs=3000) treat
// 502 as a transient gateway failure and retry anyway — field evidence: 3
// crashes in 10 seconds, the 3rd carrying a 6.4MB payload (representation
// flip after the provider switch, not content growth). Fix (suggestion 3,
// status-semantics layer only): answer 413 Content Too Large — the repo's own
// convention for a mathematically-determined "cannot fit, NOT forwarded"
// rejection (side-request guard, `side_request_payload_too_large`) and
// non-retryable semantics for every mainstream host. The doom math, the
// message, the no-forward behavior and `retryable:false` are untouched.
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
import { getSession } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 20_000;

type Call = { summary: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function bigMessages(count = 500, charsPerMsg = 4_400): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "PREFLIGHT SUMMARY: filler." }, finish_reason: "stop" }] }));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
            }
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string>; upstreamPort: number };

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
            upstreamPort,
        },
        calls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });

// Mirrors the #2313 stuck-meter seed, demoted to estimate by the #1933 F2
// route gate so baselineFloor drops to 0 and the probe-forward gate decides.
async function seedStuckMeter(ctx: Ctx, sessionId: string, lastInputTokens = 7_300_000): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = lastInputTokens;
    s.stats.lastInputTokensSource = "estimate";
    s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
}

test("e2e #2847: a mathematically-doomed payload answers NON-retryable 4xx semantics, not a 502 the host must retry", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-2847-"));
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "s-2847-a");

        // 500 msgs × 4.4K chars ≈ 2.2MB ASCII core text — past BOTH doom bars
        // (absolute 2MB floor; 20K window × 7.5 B/token = 150KB ratio bar).
        // This is the issue's shape: ~2,234,634 bytes rejected 3× in 10s.
        const r = await post(ctx, bigMessages());
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { code?: string; retryable?: boolean; message?: string } };

        // THE fix under test: the status itself must carry the non-retryable
        // semantics. 502 is a transient gateway failure for every status-code
        // -driven host; 413 is terminal.
        assert.equal(r.status, 413, `doomed overflow must answer 413 (got ${r.status}) — a 502 re-invites the host retry storm (#2847)`);
        assert.ok(r.status >= 400 && r.status < 500, "doomed overflow is a 4xx (non-retryable class), never a 5xx");
        // Everything else pinned by #2490 stays byte-identical in meaning:
        assert.equal(parsed.error?.code, "preflight_compress_failed", "same structured error code");
        assert.equal(parsed.error?.retryable, false, "body still says retryable:false");
        assert.match(parsed.error?.message ?? "", /~2[23]\d{5} bytes/, "the byte math is in the operator-facing message");
        assert.match(parsed.error?.message ?? "", /NOT forwarded even for evidence/, "the remedy wording is present");
        // Behavior unchanged: the doomed payload NEVER reaches the upstream.
        assert.ok(calls.length === 1 && calls[0]!.contentChars < 50_000, `only the seed turn reached the upstream (calls=${JSON.stringify(calls.map((c) => c.contentChars))})`);
    } finally {
        await close();
        rmrf(root);
    }
});
