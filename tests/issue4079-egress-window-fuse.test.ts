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
// sizes below the largest common window).
//
// #7537 (owner ruling 2026-11-22): the size bars are ESTIMATES, and the whole
// #7167/#7382/#2490/#2847 issue family is their false-refusal offshoot — so
// the fuse no longer refuses locally. It now LOGS the measured evidence and
// forwards; the upstream's own verdict is authoritative, and a size error
// comes back annotated (x-bili-cause: upstream-size, x-bili-retryable: false,
// error.bili_evidence) so the host doesn't retry the same doomed body. This
// test pins the new both-ways semantics: an over-bar body is FORWARDED and the
// upstream's 413 passes through annotated; under-bar bodies forward silently.
// The count gate (BILI_MAX_MESSAGES) remains the only local 413 (exact wire
// constraint, not an estimate).
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
            // #7537: the upstream is the size authority — bodies it cannot fit
            // answer 413 with its own message; the proxy must pass it through
            // annotated instead of judging locally.
            if (bytes > 2_000_000) {
                res.writeHead(413, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "upstream says: request entity too large", type: "invalid_request_error", code: "entity_too_large" } }));
                return;
            }
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

test("e2e #4079 (#7537): a body that no window can fit is FORWARDED — the fuse logs, the upstream's 413 passes through annotated", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079a-"));
    const { ctx, calls, close } = await setup();
    try {
        // No `model` in the body → preflight's `!model` early return skips its
        // doom math and folding entirely; forward() is the last line (#4079).
        // The measured tier still measures and LOGS the evidence, but per
        // #7537 it no longer refuses: the payload reaches the upstream, which
        // answers its own 413 — passed through with the bili annotation so the
        // host learns "don't retry this unchanged body" from ONE round trip.
        // 2000 msgs × 4.4K chars ≈ 8.68MB core text — over every old bar; the
        // fake upstream 413s above 2MB.
        const r = await post(ctx, bigMessages(2000, 4_400), false);
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: unknown; message?: string } };

        assert.equal(r.status, 413, `the upstream's size verdict must pass through (got ${r.status}): ${body.slice(0, 300)}`);
        assert.match(parsed.error?.message ?? "", /upstream says: request entity too large/, "the 413 is the UPSTREAM's message, not a local refusal");
        assert.equal(r.headers.get("x-bili-cause"), "upstream-size", "the annotation names the size verdict");
        assert.equal(r.headers.get("x-bili-retryable"), "false", "non-retryable — retrying re-sends the same oversized history (#2847 semantics)");
        assert.equal(parsed.error?.retryable, undefined, "the upstream body stays verbatim — no bili merge (header-only annotation)");
        // THE behavior under test: the payload WAS forwarded — the fuse logs,
        // it does not judge (#7537).
        assert.equal(calls.length, 1, `upstream must see exactly one call (got ${JSON.stringify(calls)})`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #5000 (#7537): a body whose mass rides tools[] is FORWARDED — the measured tier logs evidence, the upstream decides", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079t-"));
    const { ctx, calls, close } = await setup();
    try {
        // Incident #5000's shape: the wire body's mass sits in tool definitions.
        // 120 tools × 40KB descriptions ≈ 4.8MB of tool text ≈ ~1.2M measured
        // tokens — over every old bar. Pre-#7537 the measured tier answered a
        // local 413 first; now it measures, logs the breakdown (tools are the
        // mass), forwards, and the upstream's 413 passes through annotated.
        const tools = Array.from({ length: 120 }, (_, i) => ({
            type: "function",
            function: { name: `tool_${i}`, description: "d".repeat(40_000) },
        }));
        const messages = bigMessages(3, 500);
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({ model: "gpt-test", stream: true, tools, messages }),
        });
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { message?: string } };

        assert.equal(r.status, 413, `the upstream's size verdict must pass through (got ${r.status}): ${body.slice(0, 300)}`);
        assert.match(parsed.error?.message ?? "", /upstream says: request entity too large/, "the 413 is the UPSTREAM's message");
        assert.equal(r.headers.get("x-bili-cause"), "upstream-size", "the annotation names the size verdict");
        assert.equal(r.headers.get("x-bili-retryable"), "false", "non-retryable — the tools[] mass won't change on retry");
        // THE behavior under test: the payload WAS forwarded — the measured
        // tier is now an evidence logger, not a judge (#7537). With the #2383
        // emergency digest default-OFF (#7549), a fresh-session first resend this
        // size may spend a few small (sub-1MB) summarization calls on the core
        // text during preflight before the forward — so pin the shape: exactly
        // one call carries the full tools-mass body, and everything before it is
        // small.
        const forwardedFull = calls.filter((c) => c.bytes >= 1_000_000);
        assert.equal(forwardedFull.length, 1, `upstream must see the full tools-mass body exactly once (got calls: ${JSON.stringify(calls.map((c) => c.bytes))})`);
        assert.ok(calls.slice(0, calls.length - 1).every((c) => c.bytes < 1_000_000), `only small summarization calls may precede the forward (got calls: ${JSON.stringify(calls.map((c) => c.bytes))})`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #4543 (#7537): a dense CJK body over every old bar is FORWARDED — the fuse logs, the upstream decides", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079c-"));
    const { ctx, calls, close } = await setup();
    try {
        // Incident #4543's shape: dense CJK history. 1.12M CJK chars ≈ 3.36MB —
        // ~1.1M measured tokens: over the 1M floored bar. No `model` in the
        // body → preflight skipped → the relay fuse is the last line.
        // Pre-#7537 this body answered a local 413; on master (pre-fuse) it
        // sailed to a guaranteed upstream 400. Now: forwarded, and the
        // upstream's own verdict passes through annotated (#7537).
        const cjk = "数".repeat(1_120_000);
        const messages = [{ role: "user", content: cjk + "\n" + "x".repeat(3_072) }] as Array<{ role: string; content: string }>;
        const r = await post(ctx, messages, false);
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { message?: string } };

        assert.equal(r.status, 413, `the upstream's size verdict must pass through (got ${r.status}): ${body.slice(0, 300)}`);
        assert.match(parsed.error?.message ?? "", /upstream says: request entity too large/, "the 413 is the UPSTREAM's message");
        assert.equal(r.headers.get("x-bili-cause"), "upstream-size", "the annotation names the size verdict");
        assert.equal(r.headers.get("x-bili-retryable"), "false", "non-retryable — the CJK mass won't change on retry");
        // THE behavior under test: the payload WAS forwarded — the fuse logs,
        // it does not judge (#7537).
        assert.equal(calls.length, 1, `upstream must see exactly one call (got ${JSON.stringify(calls)})`);
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

test("e2e #6844 both-ways: a model-hidden DSH top-level field no longer meters the fuse, while a genuinely oversized unknown field still does", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6844-"));
    const { ctx, calls, close } = await setup();
    try {
        // Incident #6844's shape: DSH 0.2.2-rc.3 attaches `dsh_session_log`
        // (up to 8 MiB, documented as staying outside model input) as a
        // top-level body field. No `model` in the body → preflight skipped →
        // the relay fuse is the last line. The hidden field alone measures
        // ~1.25M tokens — over the 1M floored bar — while the visible content
        // is a few KB. Pre-#6844 this body 413'd with `other` at 88% of the
        // measured body; the fuse is a meter, not a filter: the field still
        // rides to the upstream byte-exact.
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                stream: true,
                messages: [{ role: "user", content: "hello" }],
                dsh_session_log: "L".repeat(5_000_000),
            }),
        });
        assert.equal(r.status, 200, `a model-hidden DSH field must not trip the fuse (got ${r.status})`);
        await r.text();
        assert.equal(calls.length, 1, "the body forwarded to the upstream");

        // Gate discipline (#3617): an UNKNOWN top-level field is still metered
        // — the exemption is a documented-field allowlist, not a hole in the
        // fuse — and the 413 names the field dominating the `other` bucket
        // (#6844 item 3), so the next unknown field needs no manual arithmetic.
        const doomed = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                stream: true,
                messages: [{ role: "user", content: "hello" }],
                custom_extension: "E".repeat(5_000_000),
            }),
        });
        assert.equal(doomed.status, 413, `an oversized unknown field must still stop at the fuse (got ${doomed.status})`);
        const parsed = JSON.parse(await doomed.text()) as { error?: { code?: string; message?: string } };
        assert.equal(parsed.error?.code, "egress_window_fuse", "the fuse names itself");
        assert.match(parsed.error?.message ?? "", /top field: custom_extension ~[\d,]+/, "the 413 names the field dominating the other bucket");
        assert.equal(calls.length, 1, "the unknown-field body never reached the upstream");
    } finally {
        await close();
        rmrf(root);
    }
});
