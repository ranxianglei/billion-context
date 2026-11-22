import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, type Config } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #7382: a large session whose core text is byte-doomed for a BLIND probe
// (> max(2MiB, window×7.5)) used to fail fast 413 with ZERO folding attempts
// even when 269 compressible ranges existed — the #2490 doom gate judged
// before any fold could run, and the emergency-shrink arm could never engage
// because a local fail-fast produces no upstream evidence to arm on. The gate
// now falls through to the fold path when foldable mass exists (the post-fold
// gates still fail fast if folding cannot save it); with nothing foldable it
// keeps the classic fail-fast — now with structured size evidence in the
// error JSON (coreTextBytes / windowTokens / foldableRanges / inboundBytes).

type Call = { stream: boolean; body: string };

function makeUpstreamOk(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(
                    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
                    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
                    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
                );
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: the oversized history rounds were deterministic filler; their raw content is no longer needed." }] }));
            }
        });
    });
}

const WINDOW = 400_000;

function startProxy(upstreamPort: number, kernelOverrides?: Partial<Config>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-big": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, kernelOverrides),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

// Estimate-grade baseline (500K, source "estimate") on the current route: the
// #2313 forward-once-for-evidence path arms (baselineFloor stays 0), and the
// trigger fires (500K ≥ 75% of 400K). This is exactly the #7382 regime — a
// large session whose only "baseline" is a stale local estimate.
async function seedEstimateBaseline(sessionId: string, upstreamPort: number, proxyPort: number): Promise<void> {
    const warm = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "gpt-big", stream: true, input: [{ type: "message", role: "user", content: "warm-up" }] }),
    });
    assert.equal(warm.status, 200, await warm.text().then((t) => t.slice(0, 300)));
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 500_000;
    s.stats.lastInputTokensSource = "estimate";
}

// 32 × 150KB text turns ≈ 4.8MB of core text — past the 3MB probe bar for a
// 400K window (max(2MiB, 400_000 × 7.5)). Sizing constraints: each turn is
// well under the per-round fold chunk (0.6 × window ≈ 594KB, CHUNK_FRACTION),
// and so is the protected tail (last user turn + trailing assistant turn,
// ~300KB / ~175K tokens) — a tail bigger than the chunk is UNFOLDABLE and
// makes every round futile — while the foldable mass (30 turns ≈ 4.5MB)
// covers the deficit (payload ~3.9× the window). The tools array keeps it a
// MAIN turn (#546 no-tools veto): a toolless budgeted body would ride the
// #388 side-request passthrough and bypass the whole probe path.
const MAIN_TOOLS = [
    { type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];

function bigInput(): unknown[] {
    return Array.from({ length: 32 }, (_, i) => ({
        type: "message",
        role: i % 2 ? "assistant" : "user",
        content: `turn ${i} ` + "FILLER ".repeat(25_000),
    }));
}

test("#7382: a byte-doomed BLIND probe with foldable mass folds instead of failing fast (and the fold actually runs)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    // Nothing soft-protected: every filler turn is foldable so the walk can
    // bring the body under the window.
    const proxy = await startProxy(upstreamPort, { preserveRecentMessages: 0 });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await seedEstimateBaseline("probe-foldable", upstreamPort, proxyPort);
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "probe-foldable" },
            body: JSON.stringify({ model: "gpt-big", stream: true, input: bigInput(), tools: MAIN_TOOLS }),
        });
        const text = await response.text();
        // The gate's job is NOT to make this payload fit — 1.4M tokens against
        // a 400K window is past the fold budget (MAX_PREFLIGHT_ROUNDS 16).
        // The job is the BEHAVIOR CHANGE: before #7382 the probe gate 413'd
        // with "NOT forwarded even for evidence" and ZERO upstream calls —
        // no folds, no evidence, the forward-once arm could never engage.
        // Now the fold path runs, the summarization calls hit the upstream
        // (evidence for the next round), and only THEN the post-fold gates
        // fail (502 futile-round), instead of the blind 413.
        assert.ok(!text.includes("NOT forwarded even for evidence"), "the blind doomed-probe fail-fast must not fire while foldable mass exists");
        assert.ok([413, 502].includes(response.status), `expected the post-fold verdict (413 futile / 502 budget), got ${response.status}: ${text.slice(0, 300)}`);
        assert.match(text, /could not bring it under|futile round/, "the 502 is the POST-FOLD judgment, not the blind pre-fold 413");
        assert.ok(calls.some((c) => !c.stream), "preflight folding ran (summarization call(s) reached the upstream) — #7382's 269 viable ranges finally got their turn");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("#7382 control: nothing foldable keeps the classic doomed-probe fail-fast — now with structured size evidence in the 413 body", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    // Every turn soft-protected → the normal-config nudge reports zero
    // compressible ranges → the old fail-fast behavior must hold.
    const proxy = await startProxy(upstreamPort, { preserveRecentMessages: 1000 });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await seedEstimateBaseline("probe-doomed", upstreamPort, proxyPort);
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "probe-doomed" },
            body: JSON.stringify({ model: "gpt-big", stream: true, input: bigInput(), tools: MAIN_TOOLS }),
        });
        const text = await response.text();
        assert.equal(response.status, 413, `expected the classic doomed-probe 413, got ${response.status}: ${text.slice(0, 300)}`);
        const err = JSON.parse(text);
        assert.match(err.error.message, /NOT forwarded even for evidence/, err.error.message);
        // #7382 item ②: the numbers that used to live only in bili's logs now
        // ride in the response.
        assert.ok(typeof err.error.coreTextBytes === "number" && err.error.coreTextBytes > 2_000_000, `coreTextBytes reported (got ${err.error.coreTextBytes})`);
        assert.equal(err.error.windowTokens, WINDOW);
        assert.equal(err.error.foldableRanges, 0);
        assert.ok(typeof err.error.inboundBytes === "number" && err.error.inboundBytes > 2_000_000, `inboundBytes reported (got ${err.error.inboundBytes})`);
        assert.equal(calls.length, 1, "no fold, no forward of the doomed payload — the single call is the warm-up that seeded the baseline");
    } finally {
        proxy.close();
        upstream.close();
    }
});
