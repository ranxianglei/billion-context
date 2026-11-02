import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { lookupContextLimit } from "../src/config.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #5500: two independent defects compounded into a hard non-retryable
// preflight loop ("502 context ~N tokens exceeds the model window 150000 ...
// with 0 compressible range(s) still visible"):
//
// Defect A (window miss): CONTEXT_LIMIT_TABLE had no step-* entry, so a
// step-family model (field case: nvidia_nim/stepfun-ai/step-5-preview, real
// window 1048576) fell to the base.modelContextLimit env default 2e5 → ~150K
// effective window. Payloads between the true size and that false wall tripped
// the preflight trigger and died in the fail-fast loop even though upstream
// would have accepted them. #852 doctrine: too-large guesses self-heal on the
// first upstream overflow; too-small ones strand. Fix C1: table row for the
// step family.
//
// Defect B (char-bound poisoning): the #604/#1498-F1 failure arm persists an
// ESTIMATE-grade lastInputTokens at char-bound scale (estimateCoreMessagesUpper
// ≈ 4x the token count), and stats_json replays it into every later request.
// Every reader except the preflight ENTRY is grade-disciplined (#1839 kill-at-
// reader: effectiveTokenCount branch 1, statusInputBaseline #2029,
// baselineFloorRaw, noOverflowEvidence, the per-round floor at preflight.ts
// round boundary all refuse estimate-grade values). The preflight entry reads
// (currentTokens init + entryTokens floor) were the last ungraded consumers:
// a poisoned arm inflated entryTokens → overshootRatio → raised summarization
// budgets and the first meter on every request after restart. Fix C2: apply
// the same grade discipline to the two entry reads (usage/overflow-arm anchors
// still floor; unknown-baseline regime untouched; the #604 kernel truncate
// rescue consumer — prepare providerInputTokens — is deliberately left alone).
//
// Suite: T1 pins the table row (+ negative controls); T2a/T2b pin the entry
// budget discipline both directions (#3617); T3 reproduces the issue's shape
// end-to-end through the REAL window-resolution chain (pre-fix: lookup miss →
// 2e5 default → trigger fires on a fitting payload → deterministic exhaustion
// → fail-fast ≥400; post-fix: 1M native window → trigger never fires → clean
// forward, zero summarization calls); T4 pins that evidence-backed (usage-
// grade) over-window rejection is UNCHANGED — C2 must not soften real 4xx walls.

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

test("unit #5500 C1: step-family models resolve a 1M window from the table", () => {
    // Field id shapes from the report: bare, relay-prefixed, and the full
    // deployment path (basename-first matching, modelRoots).
    assert.equal(lookupContextLimit("step-5-preview-free"), 1_000_000);
    assert.equal(lookupContextLimit("litellm/step-5-preview-free"), 1_000_000);
    assert.equal(lookupContextLimit("nvidia_nim/stepfun-ai/step-5-preview"), 1_000_000);
    // Negative controls: neighboring rows unchanged, unknowns still miss.
    assert.equal(lookupContextLimit("gpt-4o-mini"), 128_000);
    assert.equal(lookupContextLimit("kimi-k2-0711-preview"), 200_000);
    assert.equal(lookupContextLimit("totally-unknown-model-x"), undefined);
});

async function entryBudgetScenario(anchorSource: "usage" | "estimate"): Promise<{ logs: string[]; failure?: unknown; fitsWindow: boolean; calls: number }> {
    const { preflightCompress } = await import("../src/preflight.ts");
    const { createCore, defaultPrompts } = await import("acp-kernel");
    type CoreMessage = import("acp-kernel").CoreMessage;
    const { getSession } = await import("../src/session.ts");
    const registry = await import("../src/registry.ts");
    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._resetForTest();

    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            summaryCalls++;
            res.writeHead(429, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as { port: number };

    const session = getSession(`issue5500-entry-${anchorSource}-${Math.random().toString(36).slice(2)}`);
    const config = defaultConfig(20_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    // The poisoned value from the field report: char-bound upper persisted by
    // the #604 failure arm (Σ m.text.length scale), replayed from stats_json.
    session.stats.lastInputTokens = 204_046;
    session.stats.lastInputTokensSource = anchorSource;
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(7000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    const logs: string[] = [];
    try {
        const result = await preflightCompress(
            {
                core: createCore(), session, config, prompts: defaultPrompts, protocol: "openai",
                url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "test-model",
                imageReserve: 5000, compressionTarget: 12_000,
                log: (_level: string, msg: string) => { logs.push(msg); },
            },
            messages,
        );
        assert.ok(summaryCalls >= 1, `the walk still attempts the fold (calls: ${summaryCalls})`);
        return { logs, failure: result.failure, fitsWindow: result.fitsWindow, calls: summaryCalls };
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("unit #5500 C2a: an ESTIMATE-grade arm does not inflate the entry budgets", async () => {
    // The payload's own estimate fits the window here (17.3K < 20K), so the
    // walk ends in a fit-forward regardless of the summary lane's 429 — the pin
    // under test is that the poisoned arm does NOT reach the entry floors to
    // raise the budgets (#5500/#1839 kill-at-reader discipline).
    const { logs, fitsWindow } = await entryBudgetScenario("estimate");
    assert.equal(fitsWindow, true, "the fitting payload stays forwardable under a poisoned arm (#301/#4288)");
    assert.ok(
        !logs.some((l) => l.includes("raising summarization budget")),
        `estimate-grade arm must be refused by the entry floors like every other reader (#5500/#1839); got: ${logs.filter((l) => l.includes("preflight")).join(" | ")}`,
    );
});

test("unit #5500 C2b: a usage-grade anchor STILL raises the entry budgets", async () => {
    const { logs, failure } = await entryBudgetScenario("usage");
    assert.ok(failure !== undefined, "the 429 surfaces as a preflight failure for a measured over-window baseline");
    assert.ok(
        logs.some((l) => l.includes("raising summarization budget")),
        `a measured usage anchor above the window must keep raising the budgets (#1933 F3); got: ${logs.join(" | ")}`,
    );
});

test("e2e #5500 C1: step-family payload that FITS the real 1M window forwards cleanly (no preflight, no fail-fast)", async () => {
    // The issue's shape through the real resolution chain: no per-route context
    // declared for "step-fake", warm registry empty → the lookup table decides.
    // Pre-fix the table missed → base.modelContextLimit 2e5 → ~150K effective
    // wall → trigger fires on this ~210K-token payload → zero compressible
    // ranges (lone open turn, KDD #12) → deterministic exhaustion → fail-fast
    // ≥400. Post-fix the table resolves 1M → the trigger never fires → one
    // clean forward, zero summarization calls.
    const calls: Array<{ stream: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(210_000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "step-fake",
                    content: [{ type: "text", text: "PREFLIGHT SUMMARY: the segment covered a long task." }],
                    stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: {} } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // Pure-CJK payload: optimistic estimator == char count == 210K tokens,
        // far above the pre-fix ~150K wall, comfortably inside the real 1M
        // window. 630KB UTF-8 < the 2MB doomed-probe absolute floor.
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue5500-step-sess" },
            body: JSON.stringify({
                model: "step-fake", max_tokens: 1024, stream: true,
                messages: [{ role: "user", content: "测".repeat(210_000) }],
            }),
        });
        assert.equal(r1.status, 200, `payload fits the resolved 1M window — must forward, not fail-fast (#5500 defect A)`);
        await r1.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.equal(calls.filter((c) => c.stream).length, 1, "exactly one forwarded stream call");
        assert.equal(summaryCalls.length, 0, `under-window payload must not burn the summarization ladder (got ${summaryCalls.length}; #5500)`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #5500 control: a usage-grade over-window payload is STILL rejected (C2 did not soften real walls)", async () => {
    // Mirror of the e2e above with a genuinely small declared window (40K) and
    // a MEASURED 60K usage baseline: the trigger fires on evidence, the lone
    // open turn yields zero compressible ranges, and the fail-fast must hold —
    // grade discipline refuses estimate-grade arms, it must not excuse
    // provider-measured overflows.
    const calls: Array<{ stream: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text: "PREFLIGHT SUMMARY: the segment covered a long task." }],
                    stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 40_000 } } } },
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "issue5500-wall-sess" };
        // Request 0 creates the session.
        const r0 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r0.status, 200);
        await r0.text();
        // The in-memory session map is process-global across tests in this file —
        // look this scenario's session up by id instead of counting.
        const s1 = listSessions().find((s) => s.id === "issue5500-wall-sess");
        assert.ok(s1, "the wall-session exists after request 0");
        // Provider-measured 60K baseline against the 40K window — evidence,
        // not an arm.
        s1.stats.lastInputTokens = 60_000;
        s1.stats.lastInputTokensSource = "usage";

        // Request 1: 60K-token lone open turn > 40K window → trigger → zero
        // compressible ranges → deterministic exhaustion → fail-fast.
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: "claude-small", max_tokens: 1024, stream: true,
                messages: [{ role: "user", content: "测".repeat(60_000) }],
            }),
        });
        assert.ok(r1.status >= 400, `measured over-window payload must stay rejected (got ${r1.status})`);
        await r1.text();
        assert.equal(calls.filter((c) => c.stream).length, 1, "request 1 was NOT forwarded (fail-fast held)");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
