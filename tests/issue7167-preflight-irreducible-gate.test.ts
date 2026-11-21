// #7167: preflight folded message ranges (irreversible history rewrite + real
// summary billing) BEFORE discovering that tools[] alone already exceeds the
// window — a fold that was guaranteed-doomed before it started. The
// irreducible-dimension gate measures the UNMODIFIED prepared body with the
// #554 guard meter right after the trigger guard: when tools[] + system +
// other alone clear the doom bar (the native window when known, the headroom
// limit as fallback — the same bar the post-fold measured dooms use), no
// amount of message compaction can fit the body, so preflight answers the
// actionable 413 (trim the tool surface / shorten the system prompt) with
// ZERO upstream calls and the session history untouched. Foldable bodies
// (irreducible part under the bar) keep the existing fold-first behavior.
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

type Call = { bytes: number; body: string };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

/** ~800 chars ≈ 200 tokens of message content, with a stable per-message
 *  marker so a later request can prove the ORIGINAL history reached the
 *  upstream unfolded (no fold block was created by an earlier request). */
function markedMessages(count: number): Array<{ role: string; content: string }> {
    const filler = "0123456789abcdef".repeat(50);
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `MARKER-${i} ${filler}` });
    }
    return messages;
}

/** `count` tools whose descriptions carry ~`descChars` chars each — the
 *  tools[] dimension folding cannot touch. 250 × 400 chars ≈ 31K measured
 *  tokens (the #7167 shape: tools[] alone clears the 20K window); 20 × 1600
 *  ≈ 8.5K leaves the messages dimension foldable (the control shape). */
function sizedTools(count: number, descChars: number): object[] {
    const pad = "0123456789abcdef".repeat(Math.ceil(descChars / 16));
    const tools: object[] = [];
    for (let i = 0; i < count; i++) {
        tools.push({
            type: "function",
            function: {
                name: `tool_${i}`,
                description: `tool number ${i} ${pad.slice(0, descChars)}`,
                parameters: { type: "object", properties: { arg: { type: "string" } } },
            },
        });
    }
    return tools;
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            calls.push({ bytes: raw.length, body: raw });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
        });
    });
    return { server, calls };
}

/** External-summary upstream: records every call (the "billed summary
 *  tokens" the issue complains about) and answers a valid openai summary. */
function makeSummaryUpstream(): { server: http.Server; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { bodies.push(null); }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY: preflight folded the early conversation into this summary." }, finish_reason: "stop" }] }));
        });
    });
    return { server, bodies };
}

function proxyOptions(routes: Record<string, object>, namedProviders: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        namedProviders: namedProviders as ProxyOptions["namedProviders"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: {
            injectTool: true,
            injectNudge: true,
            // The control test needs a working fold: the external chain does
            // the summarization (zero model involvement), pointed at the
            // recording summary upstream.
            externalSummary: { enabled: true, targets: ["sum/sm"] },
        },
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

async function setup(sessionId: string): Promise<{ ctx: Ctx; calls: Call[]; summaryBodies: unknown[]; close: () => void }> {
    // Isolate ALL on-disk state (unified storage, prefix-affinity, session-order):
    // a second server instance hydrating the first's session would inherit its
    // calibration factor and local-refusal records — the trigger math is
    // session-state-sensitive and the tests must not see each other.
    const root = mkdtempSync(path.join(tmpdir(), "bili-7167-"));
    const prevXdg = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME, cache: process.env.XDG_CACHE_HOME };
    process.env.XDG_STATE_HOME = path.join(root, "state");
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const summary = makeSummaryUpstream();
    summary.server.listen(0, "127.0.0.1");
    await once(summary.server, "listening");
    const summaryPort = (summary.server.address() as { port: number }).port;
    process.env.E2E_7167_SUM_KEY = "k";
    const proxy = await startServer(proxyOptions(
        { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        { sum: { baseUrl: `http://127.0.0.1:${summaryPort}`, api: "openai", apiKeyEnv: "E2E_7167_SUM_KEY", models: { sm: {} } } },
    ));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
        },
        calls,
        summaryBodies: summary.bodies,
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
            summary.server.close();
            summary.server.closeAllConnections?.();
            for (const [key, value] of Object.entries(prevXdg)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmrf(root);
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>, tools: object[]) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages, tools }),
    });

test("e2e #7167: tools[] alone over the window → fail-fast 413 BEFORE any fold — zero upstream calls, zero summary billing, history untouched", async () => {
    const { ctx, calls, summaryBodies, close } = await setup("s-7167-doomed");
    try {
        // The #7167 shape: tools[] ~31K measured tokens alone clear the 20K
        // window; messages ~10K would have been foldable. Before the gate this
        // exact body ran preflightCompress (irreversible fold + a billed
        // summary call) and only THEN 413'd on the post-fold measured doom.
        const r = await post(ctx, markedMessages(50), sizedTools(250, 400));
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `doomed body must fail fast (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.code, "preflight_compress_failed", "the preflight fail-fast house shape");
        assert.equal(parsed.error?.retryable, false, "retrying re-sends the same tool surface (#2847 semantics)");
        assert.match(parsed.error?.message ?? "", /tools\[\] \+ system \+ other alone measure/, "the irreducible dimensions name themselves");
        assert.match(parsed.error?.message ?? "", /Compaction was NOT attempted/, "the operator is told no doomed fold was run");
        assert.match(parsed.error?.message ?? "", /NOT forwarded/, "the body did not reach the upstream");
        assert.match(parsed.error?.message ?? "", /Trim the tool surface/, "the actionable remedy is present");
        // THE behavior under test: nothing was folded and nothing was billed —
        // zero calls to the main upstream AND zero summary-chain calls.
        assert.equal(calls.length, 0, `main upstream must see zero calls (got ${JSON.stringify(calls)})`);
        assert.equal(summaryBodies.length, 0, `the summary chain must not be billed for a doomed fold (got ${summaryBodies.length} calls)`);

        // History intact: the SAME session resends the same 50 messages with a
        // small tool surface (textChannel ~11K < 20K → no trigger). If the
        // first request had folded, the forwarded body would carry the fold
        // summary instead of the original messages.
        const r2 = await post(ctx, markedMessages(50), sizedTools(2, 200));
        const body2 = await r2.text();
        assert.equal(r2.status, 200, `the same history with a fitting tool surface must forward (got ${r2.status}): ${body2.slice(0, 300)}`);
        assert.equal(calls.length, 1, "exactly one forward reached the upstream");
        assert.equal(summaryBodies.length, 0, "no summary call on the fitting resend either");
        // Assert on the RECORDED REQUEST body (the response is the SSE stream):
        // the original messages must have reached the upstream unfolded.
        const sent = calls[0].body;
        assert.ok(sent.includes("MARKER-0"), "the ORIGINAL first message reached the upstream unfolded");
        assert.ok(sent.includes("MARKER-49"), "the ORIGINAL last message reached the upstream unfolded");
        assert.ok(!sent.includes("SUMMARY: preflight folded"), "no fold block exists in the session history");
    } finally {
        await close();
    }
});

test("e2e #7167 control: foldable bodies (irreducible part under the bar) keep the fold-first behavior — the gate must not false-block", async () => {
    const { ctx, calls, summaryBodies, close } = await setup("s-7167-foldable");
    try {
        // tools ~8.5K (< 20K bar) + messages ~16K: the trigger fires
        // (textChannel ~26K ≥ 20K) but the irreducible part fits — folding the
        // messages CAN make the body fit, so preflight must fold and forward,
        // exactly as before the gate.
        const r = await post(ctx, markedMessages(100), sizedTools(20, 1600));
        const body = await r.text();
        assert.equal(r.status, 200, `foldable body must fold and forward (got ${r.status}): ${body.slice(0, 300)}`);
        assert.ok(summaryBodies.length >= 1, `the summary chain did the folding (got ${summaryBodies.length} calls)`);
        assert.ok(calls.length >= 1, "the folded body reached the upstream");
        // The outbound must carry the fold summary — folding really happened,
        // the gate did not false-block a foldable body.
        assert.ok(calls[calls.length - 1].body.includes("SUMMARY: preflight folded"), "the forwarded body carries the fold block");
        assert.ok(!body.includes("Compaction was NOT attempted"), "the gate did not fire on a foldable body");
    } finally {
        await close();
    }
});
