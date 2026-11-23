// #7537 (owner ruling 2026-11-22): bili must NOT refuse oversized requests on
// its own estimate. Every estimate-based 413 site (probe byte-doom, the
// #1839 measured gate, the no-baseline measured + byte-doom gates, the
// deterministic-exhaustion 413 mapping, and the egress fuse's two size gates)
// was forwarding-decided: fold what can fold, then ALWAYS forward; the
// upstream's own verdict (with its real numbers) is authoritative. When the
// upstream answers with a size error (413 / size-keyword 400), bili marks the
// response non-retryable (headers + JSON body merge) so status-code-driven
// hosts don't retry-loop the already-refused body, and logs its local
// measurement as evidence. The ONLY local refusals that remain are the
// non-estimate ones: the message-COUNT gate (BILI_MAX_MESSAGES, an exact wire
// constraint) and the 5GiB pure-byte sanity cap.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _resetStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 20_000;
// Above this many message chars the fake upstream declares ITS OWN 413 —
// the authoritative size verdict bili must pass through (annotated).
const UPSTREAM_SIZE_LIMIT_CHARS = 1_000_000;

type Call = { summary: boolean; contentChars: number };
type UpstreamMode = "size-limited" | "always-413";

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function bigMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function makeUpstream(mode: UpstreamMode): { server: http.Server; calls: Call[] } {
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
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "PREFLIGHT SUMMARY: " + "f".repeat(120) }, finish_reason: "stop" }] }));
                    return;
                }
                if (mode === "always-413" || chars > UPSTREAM_SIZE_LIMIT_CHARS) {
                    // The upstream's OWN authoritative size verdict.
                    res.writeHead(413, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "maximum context length exceeded for this model", type: "invalid_request_error" } }));
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

type Ctx = { url: string; headers: Record<string, string> };

async function setup(mode: UpstreamMode = "size-limited"): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _resetStoreForTest();
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream(mode);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": `s-7537-${Math.random().toString(36).slice(2)}` },
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

test("#7537 A: the mathematically-doomed payload is FORWARDED, and the upstream's own 413 passes through annotated (non-retryable)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7537-"));
    const { ctx, calls, close } = await setup("always-413");
    try {
        // 500 msgs × 4.4K chars ≈ 2.2MB ASCII core text — past BOTH of the old
        // local doom bars (2MB absolute floor; 20K × 7.5 B/token ratio bar).
        // Pre-#7537 this answered a LOCAL 413 and never reached the upstream.
        // The fake upstream here always answers 413: it models an upstream
        // whose REAL window is smaller than anything bili would send — the
        // upstream's verdict is the authoritative one bili must relay.
        const r = await post(ctx, bigMessages(500, 4_400));
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { message?: string } };

        // THE fix: no local estimate-refusal — the payload reached the
        // upstream, which made the authoritative call (413).
        assert.ok(calls.some((c) => !c.summary),
            `the forward must reach the upstream (calls=${JSON.stringify(calls.map((c) => ({ s: c.summary, n: c.contentChars })))})`);
        assert.equal(r.status, 413, "the status is the UPSTREAM's 413");
        assert.match(parsed.error?.message ?? "", /maximum context length exceeded/, "the UPSTREAM's own error text (not bili's local estimate) is what the host sees");
        // Annotation: non-retryable marking via HEADERS so status-code-driven
        // hosts stop retry-looping the already-refused body. The upstream BODY
        // stays verbatim (no merge — #1195 B / request-input-lifetime pin).
        assert.equal(r.headers.get("x-bili-retryable"), "false", "x-bili-retryable header present");
        assert.equal(r.headers.get("x-bili-cause"), "upstream-size", "x-bili-cause header present");
    } finally {
        await close();
        rmrf(root);
    }
});

test("#7537 B: a measured-over-window payload the UPSTREAM accepts now arrives (old: killed by the local measured 413)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7537-"));
    const { ctx, close } = await setup();
    try {
        // 60 msgs × 1.7K chars ≈ 102KB core text ≈ ~26K measured tokens
        // (dense repetitive metering): over the old measured bar (20K
        // window) — pre-#7537 the rebuilt body's measured size killed it
        // with a local 413 before any forward — yet a handful of folds
        // converges it and the fake upstream (1M-char acceptance limit)
        // accepts the folded forward. Now: folded where it folds,
        // forwarded, upstream 200 reaches the host.
        const r = await post(ctx, bigMessages(60, 1_700));
        const text = await r.text();
        assert.equal(r.status, 200, `the upstream accepted it — bili must have forwarded, not refused locally (got ${r.status}: ${text.slice(0, 200)})`);
        assert.match(text, /forwarded answer/, "the upstream's answer reaches the host");
    } finally {
        await close();
        rmrf(root);
    }
});

test("#7537 C: the message-COUNT gate remains a local refusal (it is an exact wire constraint, not an estimate)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7537-"));
    const { ctx, calls, close } = await setup();
    const prev = process.env.BILI_MAX_MESSAGES;
    process.env.BILI_MAX_MESSAGES = "10";
    try {
        // 30 small messages — no size bar is near, only the count gate trips.
        const r = await post(ctx, bigMessages(30, 200));
        const body = await r.text();
        assert.equal(r.status, 413, "the count gate still refuses locally");
        assert.match(body, /message count 30 exceeds the upstream wire limit 10/, "the count-gate message names the exact constraint");
        assert.ok(calls.length === 0, "the count-gate refusal is NOT forwarded");
    } finally {
        if (prev === undefined) delete process.env.BILI_MAX_MESSAGES;
        else process.env.BILI_MAX_MESSAGES = prev;
        await close();
        rmrf(root);
    }
});
