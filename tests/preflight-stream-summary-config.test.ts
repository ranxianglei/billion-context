import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// One attempt per failed summary call so the 524 repro fails fast instead of
// burning the default replay budget against the fake gateway.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { parseCompressSettings, type ProxyOptions } from "../src/config.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #2133 regression: an upstream behind a gateway that times out long
// NON-STREAMING completions (Cloudflare answers HTTP 524 "origin is timing
// out") never triggers the #626 self-learn — that path only sees 400 bodies
// matching "stream … true" — so every preflight summary round-trip fails and
// compression spins without folding. compress.streamSummary is the operator
// escape hatch: force SSE from the first attempt, scoped by the three-level
// cascade (global → provider → model).

const SUMMARY_TEXT =
    "CONFIG-FORCED STREAMED SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state, so the folded view loses nothing of value for continued work.";

type Call = { stream: boolean; summary: boolean };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Cloudflare-shaped Responses upstream: any non-stream call dies with 524
// (gateway timeout); stream calls succeed — summaries via delta SSE, the
// forwarded client request via response.completed.
function makeCloudflareUpstream(calls: Call[], forwardBodies: string[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; instructions?: unknown; input?: unknown } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = typeof parsed.instructions === "string" && Array.isArray(parsed.input) && parsed.input.length === 1;
            calls.push({ stream: parsed.stream === true, summary: isSummary });
            if (parsed.stream !== true) {
                res.writeHead(524, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { code: 524, message: "origin is timing out" } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (isSummary) {
                for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
                    res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
                }
                res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
            } else {
                forwardBodies.push(raw);
                res.write(sse("response.completed", {
                    type: "response.completed",
                    response: {
                        id: "resp_fwd",
                        status: "completed",
                        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                        usage: { input_tokens: 800, output_tokens: 4 },
                    },
                }));
            }
            res.end();
        });
    });
}

function longResponsesInput() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return input;
}

function startProxy(routes: Record<string, object>, compress: Record<string, unknown>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true, ...compress },
        promptCache: { routing: "auto" },
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function driveResponsesPreflight(proxyPort: number, upstreamPort: number, session: string): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: longResponsesInput() }),
    });
}

function closeAll(servers: http.Server[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        void Promise.allSettled(servers.map((s) => { s.close(); s.closeIdleConnections?.(); return once(s, "close"); })).then(() => resolve(), reject);
    });
}

test("parseCompressSettings validates streamSummary as a strict boolean (#2133)", () => {
    assert.equal(parseCompressSettings({ streamSummary: true })?.streamSummary, true);
    assert.equal(parseCompressSettings({ streamSummary: false })?.streamSummary, false);
    assert.equal(parseCompressSettings({ streamSummary: "yes" }), undefined);
    assert.equal(parseCompressSettings({ streamSummary: 1 }), undefined);
    assert.equal(parseCompressSettings({ nudgeGrowthTokens: 40000, streamSummary: true })?.nudgeGrowthTokens, 40000);
    assert.equal(parseCompressSettings({})?.streamSummary, undefined);
});

test("mergeCompress: streamSummary merges deepest-wins like every other field (#2133)", () => {
    assert.equal(mergeCompress({ streamSummary: true }, undefined, undefined).streamSummary, true);
    assert.equal(mergeCompress(undefined, { streamSummary: true }, undefined).streamSummary, true);
    assert.equal(mergeCompress(undefined, undefined, { streamSummary: true }).streamSummary, true);
    assert.equal(mergeCompress({ streamSummary: true }, undefined, { streamSummary: false }).streamSummary, false);
    assert.equal(mergeCompress({ streamSummary: true }, { streamSummary: false }, undefined).streamSummary, false);
    assert.equal(mergeCompress(undefined, undefined, undefined).streamSummary, undefined);
});

test("e2e #2133 (global config ON): 524 gateway → SSE forced first-shot, fold applies, nothing learned", async () => {
    const calls: Call[] = [];
    const forwardBodies: string[] = [];
    const upstream = makeCloudflareUpstream(calls, forwardBodies);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(
        { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-6-astra": { context: 10_000 } } } },
        { streamSummary: true },
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s2133-on-1");
        assert.equal(r.status, 200, `forced-stream preflight must succeed behind the 524 gateway, got ${r.status}`);

        // Every summary call went straight to SSE — zero non-stream attempts
        // (the legacy behavior is exactly one doomed non-stream round-trip per
        // summary before it gives up).
        const summaries = calls.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "a summary call must have been made");
        assert.ok(
            summaries.every((c) => c.stream),
            `every summary call must be stream when compress.streamSummary=true, got ${JSON.stringify(calls)}`,
        );

        // The fold applied: the forwarded payload carries the summary text.
        assert.ok(forwardBodies.length >= 1, "the folded payload was forwarded");
        assert.ok(forwardBodies.some((b) => b.includes(SUMMARY_TEXT)), "the applied fold's summary entered the rebuilt payload");

        // Nothing had to be learned — the session flag stays unset (it is the
        // error-driven marker, distinct from the config-forced mode).
        const sess = listSessions().find((s) => s.id.includes("s2133-on-1"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightStreamSummary, undefined, "no error-driven learning needed under the config-forced mode");
    } finally {
        await closeAll([proxy, upstream]);
    }
});

test("e2e #2133/#2155 (explicit OFF): 524 gateway → legacy non-stream retries, no learn, fail-fast 502", async () => {
    const calls: Call[] = [];
    const forwardBodies: string[] = [];
    const upstream = makeCloudflareUpstream(calls, forwardBodies);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // #2155 flipped the UNSET default to first-hit SSE learn on 524/504; an
    // explicit cascade FALSE is now the operator's "never stream summaries"
    // opt-out and must keep the legacy behavior: no learn path arms, every
    // attempt stays non-stream, preflight fails fast.
    const proxy = await startProxy(
        { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-6-astra": { context: 10_000 } } } },
        { streamSummary: false },
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s2133-off-1");
        // Pins the explicit-OFF behavior (#2155): the operator opted this
        // route out of streaming summaries, so the gateway timeout must not
        // arm the 524 learn path — preflight fails fast instead of folding.
        assert.equal(r.status, 502, `explicit OFF must still fail fast behind the 524 gateway, got ${r.status}`);
        const body = await r.json() as { error?: { code?: string; retryable?: boolean } };
        assert.equal(body.error?.code, "preflight_compress_failed");
        assert.equal(body.error?.retryable, true);

        const summaries = calls.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "a summary call must have been made");
        assert.ok(
            summaries.every((c) => !c.stream),
            `explicit OFF keeps every summary attempt non-stream (no learn path arms), got ${JSON.stringify(calls)}`,
        );
        assert.equal(forwardBodies.length, 0, "nothing was forwarded — the payload could not be brought under the window");
    } finally {
        await closeAll([proxy, upstream]);
    }
});

test("e2e #2133 (per-provider scope): only the route carrying compress.streamSummary streams", async () => {
    const callsA: Call[] = [];
    const bodiesA: string[] = [];
    const callsB: Call[] = [];
    const bodiesB: string[] = [];
    const upstreamA = makeCloudflareUpstream(callsA, bodiesA);
    const upstreamB = makeCloudflareUpstream(callsB, bodiesB);
    // Attach the listeners BEFORE listen(): with two concurrent listens the
    // second "listening" event can fire while awaiting the first, and an
    // EventEmitter drops unlistened events — the await would hang forever.
    const upAReady = once(upstreamA, "listening");
    const upBReady = once(upstreamB, "listening");
    upstreamA.listen(0, "127.0.0.1");
    upstreamB.listen(0, "127.0.0.1");
    await Promise.all([upAReady, upBReady]);
    const portA = (upstreamA.address() as { port: number }).port;
    const portB = (upstreamB.address() as { port: number }).port;

    const proxy = await startProxy(
        {
            [`http://127.0.0.1:${portA}`]: { models: { "gpt-6-astra": { context: 10_000 } }, compress: { streamSummary: true } },
            [`http://127.0.0.1:${portB}`]: { models: { "gpt-6-astra": { context: 10_000 } }, compress: { streamSummary: false } },
        },
        {},
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const rA = await driveResponsesPreflight(proxyPort, portA, "s2133-scope-a");
        assert.equal(rA.status, 200, "route A carries the provider-level knob and must fold cleanly");
        const sumsA = callsA.filter((c) => c.summary);
        assert.ok(sumsA.length >= 1 && sumsA.every((c) => c.stream), `route A summaries must all be stream, got ${JSON.stringify(callsA)}`);

        const rB = await driveResponsesPreflight(proxyPort, portB, "s2133-scope-b");
        assert.equal(rB.status, 502, "route B carries the explicit OFF knob and keeps the legacy non-stream-first behavior");
        const sumsB = callsB.filter((c) => c.summary);
        assert.ok(sumsB.length >= 1 && sumsB.every((c) => !c.stream), `route B summaries must stay non-stream, got ${JSON.stringify(callsB)}`);
        assert.equal(bodiesB.length, 0, "route B forwarded nothing (its preflight failed)");
    } finally {
        await closeAll([proxy, upstreamA, upstreamB]);
    }
});

test("e2e #2155/#2133 (stale learned flag): explicit OFF ignores a flag learned under the unset default", async () => {
    // The disclosed opt-out contract has a third clause beyond the two learn
    // paths: an ALREADY-learned metadata.preflightStreamSummary (acquired under
    // the #2155 first-hit default while the cascade was unset) must be inert
    // once the operator sets an explicit streamSummary:false on the route. The
    // flag is seeded directly on the live session to simulate that prior
    // learning; a failed preflight would arm the #726 dead-end cooldown for
    // identical bodies, so the session is warmed with an in-window request
    // instead of a failed long one.
    const calls: Call[] = [];
    const forwardBodies: string[] = [];
    const upstream = makeCloudflareUpstream(calls, forwardBodies);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(
        { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-6-astra": { context: 10_000 } }, compress: { streamSummary: false } } },
        {},
    );
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const warm = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s2155-stale-flag" },
            body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [{ type: "message", role: "user", content: "warmup" }] }),
        });
        assert.equal(warm.status, 200, `warmup must pass through, got ${warm.status}`);
        const forwardedAfterWarmup = forwardBodies.length;

        const sess = listSessions().find((s) => s.id.includes("s2155-stale-flag"));
        assert.ok(sess, "session recorded by the warmup");
        assert.equal(sess?.metadata?.preflightStreamSummary, undefined, "no flag before seeding");
        sess!.metadata.preflightStreamSummary = true;

        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s2155-stale-flag");
        assert.equal(r.status, 502, `explicit OFF must ignore the stale flag and fail fast, got ${r.status}; calls=${JSON.stringify(calls)}`);
        const summaries = calls.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "a summary call must have been made");
        assert.ok(
            summaries.every((c) => !c.stream),
            `explicit OFF keeps every attempt non-stream even with a learned flag, got ${JSON.stringify(calls)}`,
        );
        assert.equal(forwardBodies.length, forwardedAfterWarmup, "the over-window payload was never forwarded (its preflight failed)");
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "the opt-out leaves the stale flag set but inert");
    } finally {
        await closeAll([proxy, upstream]);
    }
});
