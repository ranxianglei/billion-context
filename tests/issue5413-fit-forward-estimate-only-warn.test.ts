import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

// #5413: the D2 stale-view guard shipped in #5409 with no regression pin.
// When the #4288 fit-forward exit judges on ESTIMATE ONLY (no usage baseline
// backing the fit) and the payload estimate reaches >= 85% of the HARD window
// limit (FIT_FORWARD_ESTIMATE_ONLY_MARGIN in src/preflight.ts), a WARN must
// fire exactly once: the local estimate excludes the system prompt + tool
// definitions and provider-side counting, so "fits by our scale" can still
// overflow upstream. Observability only — the forward still happens.
//
// Derived trigger recipe (from the preflight/server/kernel constants, NOT the
// issue sketch — the sketch's usage-baseline shape cannot reach the guard
// through the classic trigger: firing needs max(baseline, estimate) >= window,
// so either the baseline is >= window (then baselineFloor < textTarget fails)
// or the estimate is (then the fit-forward exit never trips)):
//   1. ANONYMOUS request (no identity header) on a FRESH prefix-affinity
//      session → lastInputTokens = 0 → the #553 unknownBaseline regime: the
//      TRIGGER arm judges on the char-count upper bound (never undershoots),
//      while every FIT judgment (per-round exit, fitsWindow) judges on the
//      optimistic CJK-aware estimate (#3146).
//   2. Many SMALL messages (each < 4000 chars AND < 1000 tokens) whose TOTAL
//      optimistic estimate (≈ chars/4 for ASCII) lands in [0.85*window, window)
//      while the raw char count exceeds the window. Small-per-message matters:
//      over-window payloads otherwise trip the kernel emergency-truncate node
//      (kernel/src/compress.ts emergencyTruncateNode, threshold 0.95), whose
//      clipped+latched view would shrink the judged estimate below the margin
//      and mask the guard. Sub-keep-window messages are skipped verbatim by
//      truncateLargeToolOutputs (keepPrefix+keepSuffix = 4000, minOutputTokens
//      = 1000), so the judged view IS the raw payload.
//   3. Preflight walks, round 1 exits fit-forward (estimate < window), and the
//      D2 check sees baselineFloor = 0 < textTarget with payloadEstimate >=
//      0.85*window.
//
// Gate discipline #3617: BOTH directions asserted — the positive control
// (in-band estimate → exactly ONE warn) and the sub-margin control (same
// shape, estimate clearly under 85% → ZERO warns), each with the proof that
// preflight actually ran (the "preflight compressing before forward" line)
// so the negative side is not vacuously green.

const WINDOW = 40_000;
// Mirror of the D2 margin (src/preflight.ts FIT_FORWARD_ESTIMATE_ONLY_MARGIN).
// Deliberately re-stated here instead of imported: the pin must break if the
// source constant moves, not track it.
const MARGIN = 0.85;

type Captured = { level: string; msg: string };

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

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

// count alternating ASCII messages of exactly msgLen chars each. Per-message
// size stays below the emergency-truncate keep window (keepPrefix+keepSuffix
// = 4000) AND its minOutputTokens gate (1000 ≈ 4000 ASCII), so every message
// is skipped verbatim by truncateLargeToolOutputs — the judged view IS the
// raw payload (a clipped+latched view would shrink the estimate under the
// margin and mask the guard). Pure ASCII keeps the estimator exact:
// optimistic ≈ total chars/4, char upper bound = chars.
function fillerConversation(msgLen: number, count: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        let body = `FILLER_${i}_`;
        while (body.length < msgLen) body += `x${i}_payload_content_`;
        msgs.push({ role, content: body.slice(0, msgLen) });
    }
    return msgs;
}

function d2Warns(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.level === "warn" && e.msg.includes("fit-forward on estimate only"));
}

/** Proof the walk actually ran: the caller logs this once when preflightCompress
 *  executes (it is absent on the early no-ranges forward, which would make the
 *  zero-warn assertion vacuous). */
function walkRan(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.msg.includes("reached preflight target") && e.msg.includes("preflight compressing before forward"));
}

async function startProxyCase(tag: string): Promise<{ port: number; upstreamPort: number; summaryCalls: () => number; close: () => Promise<void> }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bili-5413-${tag}-`));
    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                summaryCalls++;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text: "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session." }],
                    stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: WINDOW } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        logFile: path.join(tmp, "bili.log"),
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        port,
        upstreamPort,
        summaryCalls: () => summaryCalls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
            fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        },
    };
}

test("e2e #5413 D2 positive: fit-forward on an estimate-only judgment at >= 85% of the window warns exactly once", async () => {
    // 48 × 2700 = 129.6k ASCII chars → message estimate ≈ 32.4k + ACP tags +
    // injected-tool wire overhead (~4.3k, measured) ≈ 37.2k, tuned to sit
    // INSIDE [0.85*40k, 40k) with margin on both sides; the char upper bound
    // (~132k) exceeds the window, which is what arms the trigger in the
    // unknownBaseline regime.
    const { port, upstreamPort, summaryCalls, close } = await startProxyCase("pos");
    const { captured, stop } = captureLogs();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: fillerConversation(2_700, 48) }),
        }).catch(() => null);
        assert.ok(r, "request failed");
        assert.equal(r!.status, 200, "the estimate-fitting payload forwards (D2 is observability only — the forward still happens)");
        await r!.text();

        assert.equal(summaryCalls(), 0, "fit-forward folds nothing — no summarization call may hit upstream");
        assert.equal(walkRan(captured).length, 1, `preflight actually walked (evidence: ${walkRan(captured).map((e) => e.msg.slice(0, 120))})`);
        const warns = d2Warns(captured);
        assert.equal(warns.length, 1, `exactly ONE D2 warn for the in-band estimate-only fit (got ${warns.length}; walk line: ${walkRan(captured).map((e) => e.msg).join(" | ")}; all warns: ${captured.filter((e) => e.level === "warn").map((e) => e.msg.slice(0, 160))})`);
        assert.ok(warns[0].msg.includes("#5408") && warns[0].msg.includes("#4288"), `warn carries provenance refs: ${warns[0].msg}`);
        const estMatch = warns[0].msg.match(/~(\d+) tok vs window (\d+)/);
        assert.ok(estMatch, `warn quotes the judged estimate and window: ${warns[0].msg}`);
        const est = Number(estMatch![1]);
        const win = Number(estMatch![2]);
        assert.ok(est >= MARGIN * win && est < win, `judged estimate ${est} sits in [${MARGIN}*window, window) of the quoted window ${win}`);

        // The warn quotes the floor it judged with — 0 proves the decision
        // was estimate-only (a usage-backed baseline would print its tokens;
        // note the response's OWN usage settles into stats only AFTER the
        // forward, so inspecting stats here would test the wrong moment).
        assert.ok(warns[0].msg.includes("(baseline ~0)"), `judgment had no usage baseline: ${warns[0].msg}`);

        const s = listSessions()[0];
        assert.ok(s, "the anonymous request resolved a prefix-affinity session");
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "fit-forward exits without folding");
    } finally {
        stop();
        await close();
    }
});

test("e2e #5413 D2 negative: identical shape just under the 85% margin stays completely quiet", async () => {
    // Same anonymous/fresh-session shape, 48 × 2200 = 105.6k chars: the char
    // upper bound still exceeds the window (trigger fires, the walk runs and
    // exits fit-forward) but the optimistic estimate ≈ 26.4k + tags + wire
    // overhead (~4.3k, measured) ≈ 31.2k sits clearly BELOW 85% of the window
    // (34k) — no warn may fire.
    const { port, upstreamPort, summaryCalls, close } = await startProxyCase("neg");
    const { captured, stop } = captureLogs();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: fillerConversation(2_200, 48) }),
        }).catch(() => null);
        assert.ok(r, "request failed");
        assert.equal(r!.status, 200);
        await r!.text();

        assert.equal(summaryCalls(), 0, "the sub-margin fit also folds nothing");
        assert.equal(walkRan(captured).length, 1, `preflight actually walked (non-vacuous negative: ${walkRan(captured).map((e) => e.msg.slice(0, 120))})`);
        assert.equal(d2Warns(captured).length, 0, `sub-margin estimate-only fit must stay quiet (warns: ${d2Warns(captured).map((e) => e.msg.slice(0, 160))})`);

        const s = listSessions()[0];
        assert.ok(s, "the anonymous request resolved a prefix-affinity session");
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "fit-forward exits without folding");
    } finally {
        stop();
        await close();
    }
});

test("unit #5413 D2 boundary: the margin itself — at/above 0.85*window warns, just under stays quiet", async () => {
    // Direct preflightCompress pins the constant's semantics without the
    // trigger layer: estimate-only fit (baselineFloor = 0) at exactly 90% of
    // the window warns once; at 80% it is silent. Same exit either way
    // (fitsWindow, zero folds, no failure).
    const { preflightCompress } = await import("../src/preflight.ts");
    const { createCore, defaultPrompts } = await import("acp-kernel");
    type CoreMessage = import("acp-kernel").CoreMessage;
    const { getSession } = await import("../src/session.ts");
    const registry = await import("../src/registry.ts");
    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._resetForTest();

    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "summary text long enough to pass the apply gate at fifty chars." } }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as { port: number };

    const run = async (fillerChars: number): Promise<{ warns: number; fits: boolean; ranges: number; failure?: string }> => {
        const lines: Captured[] = [];
        const session = getSession(`issue5413-${Math.random().toString(36).slice(2)}`);
        const config = defaultConfig(WINDOW, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
        const messages: CoreMessage[] = [
            { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
            { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(Math.floor(fillerChars / 7)) },
            { id: "last", role: "user", contentType: "text", text: "Continue the task." },
        ];
        const result = await preflightCompress(
            {
                core: createCore(), session, config, prompts: defaultPrompts, protocol: "openai",
                url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "test-model",
                imageReserve: 0, wireOverhead: 0, unknownBaseline: true,
                log: (level, msg) => lines.push({ level, msg }),
            },
            messages,
        );
        return {
            warns: lines.filter((e) => e.level === "warn" && e.msg.includes("fit-forward on estimate only")).length,
            fits: result.fitsWindow,
            ranges: result.compressedRanges ?? 0,
            failure: result.failure?.kind,
        };
    };

    try {
        // "FILLER_" is 7 chars, so fillerChars/7 repeats yield exactly
        // fillerChars of filler text; the two short bookends add ~10 tokens,
        // so 144_000 → ~36_000+10 ≈ 90% of the 40k window.
        const hi = await run(144_000);
        assert.equal(hi.warns, 1, `at ~90% of the window the estimate-only fit warns exactly once (fits=${hi.fits}, ranges=${hi.ranges})`);
        assert.equal(hi.fits, true, "the payload fits the window by its own estimate");
        assert.equal(hi.ranges, 0, "fit-forward folds nothing");
        assert.equal(hi.failure, undefined, "no failure verdict over a fit-forward exit");

        // 128_000 → ~32_000+10 ≈ 80% of the window: same exit, no warn.
        const lo = await run(128_000);
        assert.equal(lo.warns, 0, "just under the 85% margin the fit-forward exit stays quiet");
        assert.equal(lo.fits, true);
        assert.equal(lo.ranges, 0);
        assert.equal(lo.failure, undefined);
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
