import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { _setPreflightWallBudgetForTest } from "../src/preflight.ts";

// #3573 (second half): a summarization round against a real upstream costs
// 25-44s regardless of range size (#2682 measurement), while the common client
// timeout class (dsh ~60s) only fits ONE such round. Pre-fix, an over-window
// preflight marathon kept admitting rounds until the client disconnected
// mid-round — the attempt died, the in-flight summary call was wasted, and the
// user saw an opaque 60s hang loop. Fix: rounds that make upstream calls are
// admitted only while the wall clock leaves room for the next one (estimate:
// 2x the last round's measured time); the completed folds of a stopped attempt
// are persisted, so the client's retry resumes from the smaller view and the
// marathon converges ACROSS attempts. Pinned here end-to-end against the real
// proxy: a slow-summary upstream + a small wall-budget seam makes every
// attempt stop after its first expensive round with a 502 (no dead-end
// cooldown poison), each retry shrinks the view, and the loop eventually
// forwards 200 — while a fast upstream with a generous budget still finishes
// the whole marathon inside ONE attempt (multi-round, no stop line).

const SUMMARY_TEXT =
    "PREFLIGHT BATCH SUMMARY: the segment covered iterative debugging of a proxy pipeline. " +
    "Decisions: batch nomination over per-range serialization because the pass deadline bounds total wall clock. " +
    "Files touched: src/preflight.ts:1487, src/external-summary.ts:76. Outcome: folded and verified.";

const STOP_LINE = /stopping after round \d+:\s*\d+ms elapsed.*#3573/;
const COOLDOWN_MARK = "will not call the upstream again";
const NOT_FORWARDED_MARK = "NOT forwarded";

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag} Message ${i}. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function startMainUpstream(): Promise<{ server: http.Server; url: string; acceptedTokens: () => number[] }> {
    const acceptedTokens: number[] = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: unknown[] };
                const tokens = Math.ceil(JSON.stringify(payload.messages).length / 4);
                if (tokens > 12_000) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `prompt is too long: ${tokens} tokens > 12000 maximum` } }));
                    return;
                }
                acceptedTokens.push(tokens);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, acceptedTokens: () => acceptedTokens }));
    });
}

/** External-summary upstream whose every request costs `delayMs` of wall time —
 *  the stand-in for a real 25-44s summarization round. */
function startSummaryUpstream(delayMs: number): Promise<{ server: http.Server; url: string; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                setTimeout(() => {
                    n += 1;
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                }, delayMs);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls: () => n }));
    });
}

async function startProxy(mainUrl: string, sumUrl: string, context: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    process.env.E2E_PATIENCE_SUM_KEY = "k";
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: mainUrl,
        routes: { [mainUrl]: { models: { "claude-small": { context } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, { compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"] },
        },
        namedProviders: { sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_PATIENCE_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return proxy;
}

function postTurn(proxy: http.Server, mainUrl: string, sessionId: string, msgs: Array<{ role: string; content: string }>): Promise<{ status: number; text: string }> {
    return fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${mainUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: msgs }),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

function activeBlocks(sessionId: string): number {
    const s = listSessions().find((x) => x.id === sessionId);
    return (s?.state.blocks ?? []).filter((b) => b.active).length;
}

function stopLines(logs: string[]): string[] {
    return logs.filter((l) => STOP_LINE.test(l));
}

test("#3573 slow summary rounds: each attempt stops at the wall budget with progress persisted, and retries converge to a forward", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _setPreflightWallBudgetForTest(600);
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream(250);
    // ~48k calibrated tokens vs a 12k window: comfortably over, far below
    // the emergency-digest bound and far from the futility gate (foldable
    // mass far exceeds the gap), yet too much for one batch round to fold —
    // convergence must come from retries.
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        const msgs = conversation(40, "t1-patience");
        let status = -1;
        let body = "";
        let blocksBefore = 0;
        let attempts = 0;
        let stoppedAttempts = 0;
        let summariesAtFirstStop = 0;
        const maxAttempts = 24;
        while (attempts < maxAttempts) {
            attempts += 1;
            const before = sum.calls();
            const stopsBefore = stopLines(logs).length;
            const r = await postTurn(proxy, main.url, "patience-slow-sess", msgs);
            status = r.status;
            body = r.text;
            const blocksNow = activeBlocks("patience-slow-sess");
            if (status === 400) {
                assert.ok(body.includes("prompt is too long:"), `attempt ${attempts}: only a context-overflow evidence probe may reach the main upstream before the payload fits`);
                continue;
            }
            if (status !== 200) {
                stoppedAttempts += 1;
                if (stoppedAttempts === 1) summariesAtFirstStop = sum.calls();
                assert.equal(status, 502, `attempt ${attempts}: an unfinished marathon fails fast with 502 (got ${status})`);
                assert.ok(body.includes(NOT_FORWARDED_MARK), `attempt ${attempts}: the fail-fast explains the over-window payload (body: ${body.slice(0, 200)})`);
                assert.ok(!body.includes(COOLDOWN_MARK), `attempt ${attempts}: a budget stop must NOT arm the dead-end cooldown (progress persists — retry is the cure)`);
                assert.ok(body.includes("client-patience wall budget"), `attempt ${attempts}: the fail-fast names the wall-budget stop honestly, not a phantom round/summary-budget exhaustion (body: ${body.slice(0, 200)})`);
                assert.match(stopLines(logs)[stopsBefore] ?? "", /stopping after round 1:/, `attempt ${attempts}: the first slow round must prevent admission of a second round`);
                assert.match(stopLines(logs)[stopsBefore] ?? "", /elapsed \+ ~[1-9]\d*ms for the next round/, `attempt ${attempts}: admission uses the duration of the round that just completed`);
                assert.ok(body.includes("after 1 round(s)"), `attempt ${attempts}: the receipt counts the completed round, not the rejected next round (body: ${body.slice(0, 200)})`);
                assert.ok(blocksNow > blocksBefore, `attempt ${attempts}: the stopped attempt still persisted its fold(s) (blocks ${blocksBefore} -> ${blocksNow})`);
                assert.ok(sum.calls() > before, `attempt ${attempts}: the attempt did run its summary round(s)`);
                blocksBefore = blocksNow;
            } else {
                break;
            }
        }
        assert.equal(status, 200, `the retry loop must converge to a forward within ${maxAttempts} attempts`);
        assert.ok(attempts >= 2, "with a 600ms budget and 250ms rounds a single attempt cannot converge — convergence must come from retries");
        assert.ok(stopLines(logs).length >= stoppedAttempts, `every stopped attempt logged the resume hint (got ${stopLines(logs).length} stop line(s))`);
        assert.ok(sum.calls() > summariesAtFirstStop, "retries perform more summary work after the first stopped attempt");
        assert.equal(main.acceptedTokens().length, 1, "exactly one fitting payload reaches the accepting main upstream");
        assert.ok(main.acceptedTokens()[0] <= 12_000, "success requires serialized messages to fit the fixture's chars/4 window");
    } finally {
        _setPreflightWallBudgetForTest(null);
        setLogCapture(null);
        delete process.env.E2E_PATIENCE_SUM_KEY;
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        main.server.close();
        main.server.closeIdleConnections?.();
        await once(main.server, "close");
        sum.server.close();
        sum.server.closeIdleConnections?.();
        await once(sum.server, "close");
    }
});

test("#3573 fast summary rounds: a generous budget still finishes the whole marathon inside ONE attempt", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _setPreflightWallBudgetForTest(60_000);
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream(5);
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        const r = await postTurn(proxy, main.url, "patience-fast-sess", conversation(40, "t2-patience"));
        assert.equal(r.status, 200, "the over-window turn folds to a fit and forwards in one attempt");
        assert.equal(stopLines(logs).length, 0, "a fast marathon must never trip the wall budget");
        assert.ok(sum.calls() >= 2, `the single attempt ran multiple summary work items (got ${sum.calls()})`);
        assert.ok(activeBlocks("patience-fast-sess") >= 2, `the attempt applied several folds (got ${activeBlocks("patience-fast-sess")})`);
    } finally {
        _setPreflightWallBudgetForTest(null);
        setLogCapture(null);
        delete process.env.E2E_PATIENCE_SUM_KEY;
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        main.server.close();
        main.server.closeIdleConnections?.();
        await once(main.server, "close");
        sum.server.close();
        sum.server.closeIdleConnections?.();
        await once(sum.server, "close");
    }
});
