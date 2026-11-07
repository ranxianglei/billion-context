import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, effectiveTokenCount } from "../src/server.ts";
import { lookupContextLimit } from "../src/config.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, absorbAbortedTurnGrowth, getSession, listSessions, noteAbortedTurn } from "../src/session.ts";
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
//
// Round 3 (field report follow-up on v0.1.212, Pi/Responses lane): the
// CYCLE-STALE demotion (#4383 — last send's report never settled) handed the
// kernel meter the CHAR-BOUND estimate (localInputEstimate / raw upper),
// inflating it ~2–4× over the measured size and crossing the kernel's
// DESTRUCTIVE emergency-truncate band (0.95×window) — false clips then LATCH
// until the next successful fold (#3939 ③), destroying delivered tool output
// on a session whose measured usage sat safely under the band. Fix C6:
// cycle-stale rides contextEstimateTokens (billing caliber, k̂-scaled where
// provenance matches — the same replacement reading staleSmallAnchorFallback
// returns for its own demotion class), capped by the current payload's own
// upper bound. C6a/b pin the ride-on + the four unchanged calibers; C7
// reproduces the field chain end-to-end (usage settle → no-report resend →
// repeat prepare → pre-fix the clips latch); C7-control pins the kernel band
// itself is untouched (genuine over-limit readings still clip). The two
// remaining sub-defects that need the KERNEL side (destructive action on
// unprovenanced evidence; truncate ignoring protectedTools) are tracked in a
// separate kernel authorization request — host-side scope ends at C6.

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

// The field trigger condition: a completed stream that reports NO usage at
// all (aborted/cancelled/flaky upstream). The relay send stamp stays pending
// ("estimate") because settleUsageReport never fires without a numeric report.
function okSseNoUsage(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant" } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } })}\n\n` +
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

// ---------------------------------------------------------------------------
// Round 3: cycle-stale demotion must not ride the char bound into the kernel
// meter (C6 fix in effectiveTokenCount) — C6a/b unit pins, C7 field-chain e2e,
// C7-control kernel-band pin.

type CoreMsg = import("acp-kernel").CoreMessage;

function meterSession(stats: Record<string, unknown>): Session {
    // Real session object so every stats default matches production; only the
    // fields under test are pinned (same discipline as entryBudgetScenario).
    const s = getSession(`issue5500-meter-${Math.random().toString(36).slice(2)}`);
    Object.assign(s.stats, stats as Partial<typeof s.stats>);
    return s;
}

const METER_MSGS: CoreMsg[] = [
    // The report's fixture scale: 639_673 chars ≈ 262_850 real tokens
    // (~2.4 chars/token mixed content). raw upper == 639_673.
    { id: "big", role: "user", contentType: "text", text: "x".repeat(639_673) },
];

test("unit #5500 C6a: a cycle-stale meter rides the billing-caliber estimate, not the char bound", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = meterSession({
        lastInputTokens: 262_850,
        lastInputTokensSource: "usage",
        lastUsagePayloadUpper: 639_673,
        compressCreditTokens: 0,
        contextTokensSource: "estimate",
        localInputEstimate: 639_673,
        contextEstimateTokens: 262_850,
    });
    const r = effectiveTokenCount(s, METER_MSGS);
    assert.equal(r.tokens, 262_850, "cycle-stale rides contextEstimateTokens (billing caliber); pre-fix it returned the char bound 639_673 and crossed the destructive truncate band (#5500 round 3 / #4383)");
    assert.equal(r.source, "estimate", "the ride-on is labeled estimate-grade — it must not masquerade as the settled anchor");
});

test("unit #5500 C6b: fresh-settle, anchor-less, legacy and k̂-overshoot calibers are UNCHANGED", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    // B1: the previous cycle SETTLED (contextTokensSource flipped back) — the
    // measured anchor branch is untouched by C6.
    const fresh = meterSession({
        lastInputTokens: 262_850, lastInputTokensSource: "usage", lastUsagePayloadUpper: 639_673,
        compressCreditTokens: 0, contextTokensSource: "usage", localInputEstimate: 639_673, contextEstimateTokens: 262_850,
    });
    const r1 = effectiveTokenCount(fresh, METER_MSGS);
    assert.deepEqual(r1, { tokens: 262_850, source: "usage" }, "fresh settle keeps the measured anchor (#4383 regression guard)");

    // B2: ANCHOR-LESS session (never reported) — #728's fail-closed bound must
    // survive: with no usage-grade source there is nothing fresher to prefer.
    const anchorless = meterSession({
        lastInputTokens: 0, compressCreditTokens: 0,
        contextTokensSource: "estimate", localInputEstimate: 639_673, contextEstimateTokens: 262_850,
    });
    const r2 = effectiveTokenCount(anchorless, METER_MSGS);
    assert.deepEqual(r2, { tokens: 639_673, source: "estimate" }, "#728 never-reporting posture unchanged (char-bound fail-closed)");

    // B3: cycle-stale but no contextEstimateTokens (legacy restored session) —
    // graceful degradation to the legacy reading.
    const legacy = meterSession({
        lastInputTokens: 262_850, lastInputTokensSource: "usage", lastUsagePayloadUpper: 639_673,
        compressCreditTokens: 0, contextTokensSource: "estimate", localInputEstimate: 639_673,
    });
    const r3 = effectiveTokenCount(legacy, METER_MSGS);
    assert.deepEqual(r3, { tokens: 639_673, source: "estimate" }, "absent calibrated field falls back to the legacy reading");

    // B4: mis-calibrated k̂ overshoots the payload's own bound — the min cap
    // keeps C6 at or below today's fail-closed worst case.
    const overshoot = meterSession({
        lastInputTokens: 262_850, lastInputTokensSource: "usage", lastUsagePayloadUpper: 639_673,
        compressCreditTokens: 0, contextTokensSource: "estimate", localInputEstimate: 639_673, contextEstimateTokens: 900_000,
    });
    const r4 = effectiveTokenCount(overshoot, METER_MSGS);
    assert.deepEqual(r4, { tokens: 639_673, source: "estimate" }, "never above the current payload's own upper bound");
});

const TRUNC_MARKER = "[truncated for context space]";

// 12 bash tool exchanges × 9_000-char results: ~27K tokens by the chars/4
// estimator (well under the 0.95×50K band) but ~108K+ chars (far above it).
// Each result clears the kernel's candidate bars (≥1000 tokens, >4000-char
// keep window) and sits outside preserveRecentMessages.
function truncPayload(): Record<string, unknown> {
    const FILLER = "x".repeat(9_000);
    const messages: unknown[] = [{ role: "user", content: "Run the diagnostics." }];
    for (let i = 0; i < 12; i++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `tu_${i}`, name: "bash", input: { command: `diag-${i}` } }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: FILLER }] });
    }
    messages.push({ role: "user", content: "Summarize the results." });
    return { model: "trunc-fake", max_tokens: 1024, stream: true, messages };
}

async function withTruncHarness(firstUsage: number, fn: (h: { url: string; bodies: string[] }) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            // Request 1 settles `firstUsage`; later requests complete WITHOUT
            // any usage frame — the field trigger condition.
            res.end(bodies.length === 1 ? okSse(firstUsage) : okSseNoUsage());
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "trunc-fake": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000),
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
        await fn({ url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, bodies });
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("e2e #5500 C7: a missing usage report must not arm the emergency truncate on a measured-safe session", async () => {
    await withTruncHarness(30_000, async (h) => {
        const headers = { "content-type": "application/json", "x-acp-session": "issue5500-trunc-a" };
        const body = JSON.stringify(truncPayload());

        const r1 = await fetch(h.url, { method: "POST", headers, body });
        assert.equal(r1.status, 200);
        await r1.text();
        const s = listSessions().find((x) => x.id === "issue5500-trunc-a");
        assert.ok(s, "session exists after request 1");
        assert.equal(s!.stats.lastInputTokens, 30_000, "request 1 settled the usage-grade anchor");
        assert.ok(!h.bodies[0]!.includes(TRUNC_MARKER), "measured-safe request 1 stays unclipped");

        const r2 = await fetch(h.url, { method: "POST", headers, body });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.ok(!h.bodies[1]!.includes(TRUNC_MARKER), "request 2 still rides the fresh anchor");
        assert.equal(s!.stats.contextTokensSource, "estimate", "request 2's send stamp is pending its (absent) report — the cycle goes stale here");

        // THE field damage: pre-fix request 3's meter rode the char bound
        // (~110K ≫ 0.95×window) and latched clips into the delivered view even
        // though the session's measured size (30K) sat safely under the band.
        const r3 = await fetch(h.url, { method: "POST", headers, body });
        assert.equal(r3.status, 200, "cycle-stale must not fail-fast either");
        await r3.text();
        assert.ok(!h.bodies[2]!.includes(TRUNC_MARKER), "no report ≠ over-window: the measured-safe session must not be clipped (#5500 round 3 / #4383 / #3939 ③ latch)");
    });
});

test("unit #5500 C7-control: the kernel emergency band itself is untouched (genuine over-limit readings still clip)", async () => {
    // C6 changed the HOST meter only; this pin proves the kernel band still
    // fires on a direct over-limit reading through the real pipeline node.
    const { createCore } = await import("acp-kernel");
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { getSession } = await import("../src/session.ts");
    const s = getSession(`issue5500-band-${Math.random().toString(36).slice(2)}`);
    const msgs: CoreMsg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ id: `call-${i}`, role: "assistant", contentType: "tool-call", toolName: "bash", text: JSON.stringify({ command: `diag-${i}` }) });
        msgs.push({ id: `res-${i}`, role: "user", contentType: "tool-result", toolName: "bash", text: "x".repeat(9_000) });
    }
    const turn = createCore().processTurn({
        messages: msgs,
        state: s.state,
        config: defaultConfig(50_000),
        tokenCount: 49_000,
        renderTags: "none",
    });
    assert.ok(
        turn.messages.some((m) => (m.text ?? "").includes(TRUNC_MARKER)),
        "a genuine ≥0.95×window reading still emergency-truncates (#3617 negative direction — C6 must not soften the band)",
    );
});
