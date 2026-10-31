// #4079 egress window fuse: every send-side check in forward() was either
// pure BYTES (checkOutboundBody's 5GiB) or lived only inside preflight's two
// escape hatches (#2313 estimate-only probe / #3146 fresh-session
// forward-once) — a request that reaches forward() without preflight judging
// it (here: no model in the body → `!model` early return in
// preflightCompressIfNeeded) hit the socket with ZERO window comparison.
// #4068: a 6,165,048-token body was sent against a 1,048,580 window.
//
// The fuse reuses preflight's doom-probe bars (#2490): core text bytes (media
// excluded) vs max(2MB absolute, window×7.5 B/token from the densest observed
// tokenizer, #2122) — and the window itself is floored at 1,000,000 tokens
// (#4079: a declared window can be wrong SMALL; the catastrophic bar never
// sizes below the largest common window). Only bodies NO 1M-token window can
// fit are blocked, so this test pins BOTH directions (#3617): the doomed
// giant answers a NON-retryable 413 and never reaches the upstream, while
// bodies under the bars — including multi-MB ones an estimator (or a
// mis-sized small window) would call over-window — still forward.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;

type Call = { bytes: number };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

function bigMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
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
            const bytes = Buffer.concat(chunks).length;
            calls.push({ bytes });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
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

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
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
        },
        calls,
        // #4245 deterministic teardown. The fuse answers 413 WITHOUT consuming
        // the doomed upload (relay egress fuse: writeHead+end+return, req is
        // never aborted), so after a doomed request the proxy still owns a
        // BUSY socket that closeIdleConnections never touches — the servers'
        // 'close' events only land once the client-side destroy propagates
        // back over the wire. Awaiting them made test completion depend on
        // cross-socket timing: on loaded GitHub windows runners the final
        // event delivery loses the race against node:test's empty-loop exit
        // check ("Promise resolution is still pending but the event loop has
        // already resolved" → cancelledByParent, 4/4 attempts in #4245).
        // Assertions are long done here and ports are ephemeral, so force-
        // destroy every connection and stop gating the test on 'close'.
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>, withModel: boolean) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ ...(withModel ? { model: "gpt-test" } : {}), stream: true, messages }),
    });

test("e2e #4079: a body that provably cannot fit any window is stopped at the egress fuse, not forwarded", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079a-"));
    const { ctx, calls, close } = await setup();
    try {
        // No `model` in the body → preflight's `!model` early return skips its
        // doom math and folding entirely; forward() is the last line (#4079).
        // 2000 msgs × 4.4K chars ≈ 8.68MB core text — past the floored ratio bar
        // (max(20K declared, 1M assumed) × 7.5 B/token = 7.5MB; the 2MB absolute
        // bar is dominated).
        const r = await post(ctx, bigMessages(2000, 4_400), false);
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `doomed egress must answer 413 (got ${r.status}) — the send must not reach an upstream that can only reject it (#4068)`);
        assert.equal(parsed.error?.type, "request_too_large", "same structured too-large family as the byte budget");
        assert.equal(parsed.error?.code, "egress_window_fuse", "the fuse names itself for log greppability");
        assert.equal(parsed.error?.retryable, false, "4xx non-retryable class — retrying re-sends the same oversized history (#2847 semantics)");
        assert.match(parsed.error?.message ?? "", /outbound billable content is ~\d{7} bytes/, "the byte math is in the operator-facing message (#5000: billable = core text + system/tools overhead)");
        assert.match(parsed.error?.message ?? "", /bars never assume below 1000000 tokens/, "the assumed-window floor is stated for the operator (#4079)");
        assert.match(parsed.error?.message ?? "", /stopped at the egress fuse instead of being forwarded/, "the remedy wording is present");
        // THE behavior under test: the doomed payload NEVER reaches the upstream.
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #4079 both-ways: bodies under the doom bars still forward — including a multi-MB one an estimator would call over-window", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079b-"));
    const { ctx, calls, close } = await setup();
    try {
        // Small, preflight-free (no model) request: forwards normally.
        const small = await post(ctx, [{ role: "user", content: "hello" }], false);
        assert.equal(small.status, 200);
        await small.text();

        // ~1.63MB core text: UNDER the 7.5MB floored bar even though it dwarfs
        // the 20K declared window's own ratio bar (150KB) — a mis-sized small
        // window must never false-block a body the real upstream accepts
        // (#4079 floor), and the fuse only blocks what NO 1M-token window can
        // fit (#2490 caliber, #3617 both-ways).
        const under = await post(ctx, bigMessages(400, 4_067), false);
        assert.equal(under.status, 200, "under-bar bodies forward regardless of estimator opinion");
        await under.text();

        assert.equal(calls.length, 2, "both requests reached the upstream");
        assert.ok(calls[1]!.bytes > 1_500_000, `the multi-MB body really was forwarded (got ${calls[1]!.bytes}B)`);
    } finally {
        await close();
        rmrf(root);
    }
});
