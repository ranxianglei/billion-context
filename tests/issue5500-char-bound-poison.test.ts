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
import { _resetSessionsForTest, absorbAbortedTurnGrowth, listSessions, noteAbortedTurn } from "../src/session.ts";
import type { Session } from "../src/session.ts";
import { probeRequestMembership } from "../src/request-membership.ts";

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
//
// Round 2 (review finding on PR #5501): the class sweep found three MORE
// readers of stats.lastInputTokens without the lastInputTokensSource grade
// discipline — the same mechanism family, fixed at the reader (kill-at-reader,
// #1839) in the same PR rather than split out:
//   C4 src/request-membership.ts — the #4805 needle's main-scale bar now
//      refuses estimate-grade/unprovenanced scalars (falls back to the
//      needle's own per-request scale); T6a/b/c pin both directions.
//   C3 src/server/prepare-responses.ts — the codex compact-intercept minted
//      usage must not carry a char-bound arm (codex recomputes its ledger
//      from it); T7 pins the poisoned + graded-scalar-wins directions.
//   C5 src/session.ts noteAbortedTurn — an untrustworthy meter carries FALSE
//      information: it would delay the #5293 re-anchor ~4x and make #5415
//      bank phantom growth debt; T8 pins skip-on-poison + stamp-on-usage.

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
    assert.equal(lookupContextLimit("step-5-preview-free"), 1_048_576);
    assert.equal(lookupContextLimit("litellm/step-5-preview-free"), 1_048_576);
    assert.equal(lookupContextLimit("nvidia_nim/stepfun-ai/step-5-preview"), 1_048_576);
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

// ---------------------------------------------------------------------------
// Round 2: the remaining ungraded readers of stats.lastInputTokens (class
// sweep on PR #5501 review) — C4 membership needle, C3 codex forge total,
// C5 abort re-anchor.

function membershipSession(stats: Record<string, unknown>): Session {
    return {
        id: "issue5500-membership",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, contextTokens: 0, ...stats } as never,
        metadata: {},
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        transient: {},
    } as never as Session;
}

test("unit #5500 C4a: an ESTIMATE-grade arm does not scale the membership needle bar", () => {
    const s = membershipSession({ lastInputTokens: 204_046, lastInputTokensSource: "estimate" });
    // First turn plants the needle at its own per-request scale.
    probeRequestMembership(s, Array.from({ length: 12 }, (_, i) => `M${i}`), 100_000);
    assert.equal(s.transient?.latestKnownMsgId, "M11", "first turn abstains and plants");
    // A payload at 40% of the MEASURED main scale may move the needle...
    probeRequestMembership(s, ["X1", "X2", "X3", "X4", "X5"], 40_000);
    assert.equal(
        s.transient?.latestKnownMsgId, "X5",
        "reference = the needle's own 100K scale (bar 25K); pre-fix the char-bound 204K arm set the bar to 51K and kept the polluter out only by accident of caliber (#5500/#4805)",
    );
});

test("unit #5500 C4b: a usage-grade anchor STILL scales the membership needle bar", () => {
    const s = membershipSession({ lastInputTokens: 400_000, lastInputTokensSource: "usage" });
    probeRequestMembership(s, Array.from({ length: 12 }, (_, i) => `P${i}`), 100_000);
    assert.equal(s.transient?.latestKnownMsgId, "P11");
    // 90K < 25% of the measured 400K anchor → foreign, stays gated.
    probeRequestMembership(s, ["F1", "F2", "F3", "F4", "F5"], 90_000);
    assert.equal(s.transient?.latestKnownMsgId, "P11", "the trustworthy scalar keeps precedence over the needle's own scale (#3617 negative direction)");
});

test("unit #5500 C4c: legacy unprovenanced meters fall back to the needle's own scale", () => {
    const s = membershipSession({ lastInputTokens: 204_046 }); // no source field (pre-field sessions)
    probeRequestMembership(s, Array.from({ length: 12 }, (_, i) => `L${i}`), 100_000);
    probeRequestMembership(s, ["Y1", "Y2", "Y3"], 40_000);
    assert.equal(s.transient?.latestKnownMsgId, "Y3", "unprovenanced = untrustworthy: same discipline as estimate-grade (#1839)");
});

function abortSession(lastInputTokens: number, source?: "usage" | "overflow-arm" | "estimate"): Session {
    return {
        id: "issue5500-abort",
        stats: { lastInputTokens, ...(source ? { lastInputTokensSource: source } : {}) },
        state: {
            nudge: {
                lastPerMessageNudgeTokens: 55_000,
                lastNudgeShownTokens: 0,
                baselineTokens: 0,
                anchors: {},
                lastShownByTier: {},
            },
        },
        transient: {},
    } as unknown as Session;
}

test("unit #5500 C5: noteAbortedTurn refuses untrustworthy meters (no delayed re-anchor, no phantom debt)", () => {
    const poisoned = abortSession(204_046, "estimate");
    noteAbortedTurn(poisoned);
    assert.equal(poisoned.transient?.abortReanchor, undefined, "a char-bound arm carries false information — no stamp (#5500)");

    const legacy = abortSession(204_046);
    noteAbortedTurn(legacy);
    assert.equal(legacy.transient?.abortReanchor, undefined, "unprovenanced meters are untrustworthy too");

    const honest = abortSession(60_000, "usage");
    noteAbortedTurn(honest);
    assert.equal(honest.transient?.abortReanchor?.anchor, 60_000, "usage-grade meters still stamp");
    absorbAbortedTurnGrowth(honest, 70_000);
    assert.equal(honest.state.nudge.lastPerMessageNudgeTokens, 70_000, "the absorb arithmetic is intact for trustworthy anchors (#5293 shape)");
    assert.equal(honest.state.nudge.absorbedDebt, 5_000, "...and banks exactly the skipped measured growth (60k − 55k, #5415)");
});

const CODEX_UA = "codex_cli_rs/0.1.0 (linux x86_64)";

// 7 messages × ~4100 chars (~7.3K tokens by the chars/4 estimator): below the
// 15K window so the trigger never fires on the compact request itself, and
// the setup turn folds m00001/m00002 into an active block (mirrors
// tests/codex-compact-e2e.test.ts conversation()).
function codexConversation() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 7; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

async function withCodexHarness(fn: (h: { url: string; bodies: string[] }) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const completed = (inputTokens: number): string => sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
    const fcEvents = (callId: string, args: string): string => [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                // First turn: the model compresses the oldest pair → active block.
                res.write(fcEvents("call_p", JSON.stringify({
                    content: [{ startId: "m00001", endId: "m00002", topic: "setup", summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
                })));
            }
            res.write(completed(1000));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    process.env.BILI_CODEX_COMPACT = "intercept";
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 15_000 } } } },
        modelContextLimit: 15_000,
        kernelConfig: defaultConfig(15_000),
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
        await fn({ url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, bodies });
    } finally {
        delete process.env.BILI_CODEX_COMPACT;
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

async function codexSetup(sessionId: string, h: { url: string; bodies: string[] }): Promise<{ afterSetup: number }> {
    const r1 = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: sessionId, instructions: "You are the test coding agent.", input: codexConversation() }),
    });
    assert.equal(r1.status, 200);
    await r1.text();
    const s = listSessions().find((x) => x.meta.label === sessionId);
    assert.ok(s, "session exists after setup");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "setup created an active block");
    return { afterSetup: h.bodies.length };
}

test("e2e #5500 C3: a poisoned arm cannot inflate the minted codex compact usage", async () => {
    await withCodexHarness(async (h) => {
        const { afterSetup } = await codexSetup("issue5500-codex-a", h);
        const s = listSessions().find((x) => x.meta.label === "issue5500-codex-a")!;
        // Poison the meter the way the #604 failure arm does: char-bound
        // upper, estimate-grade — the exact shape from the field report.
        s.stats.lastInputTokens = 204_046;
        s.stats.lastInputTokensSource = "estimate";

        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "issue5500-codex-a", instructions: "You are the test coding agent.", input: [...codexConversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200, "the compact stays intercepted");
        const frames = (await r2.text()).split("\n\n").filter((f) => f.startsWith("data: "));
        assert.equal(frames.length, 2, "forged 2-frame SSE");
        const e2 = JSON.parse(frames[1]!.slice("data: ".length)) as { type: string; response: { usage: { input_tokens: number } } };
        assert.equal(e2.type, "response.completed");
        // Codex recomputes its ledger from this minted usage: pre-fix the
        // forged input_tokens was 204_046 (the char-bound arm); post-fix it is
        // the raw-body estimate (~7K).
        assert.ok(e2.response.usage.input_tokens > 5_000 && e2.response.usage.input_tokens < 20_000, `minted input_tokens must be the raw-body estimate, not the poisoned arm (got ${e2.response.usage.input_tokens})`);
        assert.equal(h.bodies.length, afterSetup, "upstream untouched by the intercept");
    });
});

test("e2e #5500 C3-control: a usage-grade anchor still wins the minted codex compact usage", async () => {
    await withCodexHarness(async (h) => {
        const { afterSetup } = await codexSetup("issue5500-codex-b", h);
        const s = listSessions().find((x) => x.meta.label === "issue5500-codex-b")!;
        // A trustworthy scalar below the gate line (90% × 15K = 13.5K) and
        // above the raw-body estimate (~7K): it must keep precedence.
        s.stats.lastInputTokens = 12_000;
        s.stats.lastInputTokensSource = "usage";

        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "issue5500-codex-b", instructions: "You are the test coding agent.", input: [...codexConversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200, "the compact stays intercepted");
        const frames = (await r2.text()).split("\n\n").filter((f) => f.startsWith("data: "));
        assert.equal(frames.length, 2, "forged 2-frame SSE");
        const e2 = JSON.parse(frames[1]!.slice("data: ".length)) as { type: string; response: { usage: { input_tokens: number } } };
        assert.equal(e2.response.usage.input_tokens, 12_000, "a trustworthy scalar keeps precedence over the raw-body estimate (#3617 negative direction)");
        assert.equal(h.bodies.length, afterSetup, "upstream untouched by the intercept");
    });
});
