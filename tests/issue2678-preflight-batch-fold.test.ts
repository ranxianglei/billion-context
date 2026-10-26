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

// #2678/#2667: the preflight fold pass used to submit ONE external-summary
// request per range, sequentially awaited inside the session lock — a k-range
// pass cost k × (20-40s) of wall clock and hit the shared 180s deadline with
// whole ranges never dispatched. These E2E tests drive the real proxy with the
// external-summary lane armed and pin the new shape: several disjoint ranges
// are nominated into ONE summarize() call whose work items the executor's pool
// runs CONCURRENTLY (measured as overlapping request intervals on the summary
// upstream), a batch-failed range is left out of the skipSet so later rounds
// retry it (re-nominated into later batches while siblings fold; the serial
// walk takes over with halving once the batch applies nothing in a round)
// instead of dropping it silently, and nomination picks the OLDEST full-budget
// chunk of a multi-chunk range (the walk's first choice) without poisoning the
// rest of the range on a rejected sub-minimum tail.

const SUMMARY_TEXT =
    "PREFLIGHT BATCH SUMMARY: the segment covered iterative debugging of a proxy pipeline. " +
    "Decisions: batch nomination over per-range serialization because the pass deadline bounds total wall clock. " +
    "Files touched: src/preflight.ts:1487, src/external-summary.ts:76. Outcome: folded and verified.";

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

function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag} Message ${i}. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type Interval = { start: number; end: number; body: string };

function startMainUpstream(): Promise<{ server: http.Server; url: string }> {
    return new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(1000));
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
}

/** External summary upstream: records [start,end] per request (for overlap
 *  measurement) and holds each request briefly so concurrent dispatch is
 *  observable; failMark makes every request containing it answer HTTP 500. */
function startSummaryUpstream(failMark?: string): Promise<{ server: http.Server; url: string; intervals: Interval[] }> {
    return new Promise((resolve) => {
        const intervals: Interval[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            const start = Date.now();
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                const finish = (): void => {
                    intervals.push({ start, end: Date.now(), body });
                    if (failMark !== undefined && body.includes(failMark)) {
                        res.writeHead(500, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: "boom" }));
                        return;
                    }
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                };
                setTimeout(finish, 50);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, intervals }));
    });
}

function maxOverlap(intervals: Interval[]): number {
    let peak = 0;
    let live = 0;
    const points = intervals.flatMap((iv) => [[iv.start, 1], [iv.end, -1]] as const);
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, delta] of points) {
        live += delta;
        peak = Math.max(peak, live);
    }
    return peak;
}

async function startProxy(mainUrl: string, sumUrl: string, context: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    process.env.E2E_BATCH_SUM_KEY = "k";
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
        namedProviders: { sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_BATCH_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return proxy;
}

test("#2678: several preflight ranges fold in ONE external-summary batch that runs concurrently", async () => {
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream();
    // ~20k-token payload vs a 12k window: comfortably over, far below the
    // emergency-digest coverage bound, and long enough to expose several
    // viable ranges in the first round (cf. preflight-multi-range sizing).
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        const r = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${main.url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "batch-fold-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "t1-batch") }),
        });
        assert.equal(r.status, 200, "the over-window turn must be folded and forwarded");
        await r.text();

        assert.ok(sum.intervals.length >= 2, `expected at least two summary work items (got ${sum.intervals.length})`);
        assert.ok(maxOverlap(sum.intervals) >= 2,
            `work items must run concurrently inside the executor pool (max overlap ${maxOverlap(sum.intervals)} — the old serial loop never overlaps)`);

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 2, `the batch must apply several ranges before re-judging (got ${activeBlocks.length} block(s))`);
    } finally {
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

test("#2678: a batch-failed range is retried across later rounds instead of dropped silently", async () => {
    const main = await startMainUpstream();
    // The oldest range's content carries MARKER_0_, so every summarization of
    // it (batch AND walk retries) answers 500 while the rest succeed.
    const sum = await startSummaryUpstream("MARKER_0_");
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        const r = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${main.url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "batch-fallback-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "t2-fallback") }),
        });
        assert.equal(r.status, 200, "one poisoned range must not brick the turn — the rest fold and the payload fits");
        await r.text();

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `healthy batch ranges must still apply (got ${activeBlocks.length} block(s))`);
        // While siblings keep folding, the failed range is re-nominated into
        // LATER batches (the serial walk takes over only once the batch applies
        // nothing in a round) — a drop-silently failure mode would show exactly
        // one attempt.
        const failedAttempts = sum.intervals.filter((iv) => iv.body.includes("MARKER_0_")).length;
        assert.ok(failedAttempts >= 2, `the failed range must be retried beyond its batch attempt (got ${failedAttempts} attempt(s))`);
    } finally {
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

test("#2678: nomination picks the oldest chunk of a multi-chunk range without poisoning it", async () => {
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream();
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        // Four normal alternating messages, then a long SAME-ROLE assistant run
        // (five ~10k-char messages, one ~40k-char message that overflows the
        // 0.6×12k chunk budget on its own, one sub-minimum ~50-char message),
        // then four normal tail messages. The kernel packs the big range into
        // several chronological chunks whose NEWEST chunk is a sub-minimum tail.
        const msgs: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 4; i++) {
            msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `t3-span Message ${i}. ` + `MARKER_${i}_content_`.repeat(250) });
        }
        for (let i = 4; i <= 8; i++) {
            msgs.push({ role: "assistant", content: `t3-span run ${i}. ` + `MARKER_${i}_run_`.repeat(769) });
        }
        msgs.push({ role: "assistant", content: `t3-span big 9. ` + `MARKER_9_big_`.repeat(3333) });
        msgs.push({ role: "assistant", content: `tiny 10. ` + `MARKER_10_tail_`.repeat(3) });
        for (let i = 11; i <= 14; i++) {
            msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `t3-span tail ${i}. ` + `MARKER_${i}_content_`.repeat(250) });
        }
        const r = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${main.url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "batch-span-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: msgs }),
        });
        assert.equal(r.status, 200, "the over-window turn must be folded and forwarded");
        await r.text();

        // The first dispatch wave must carry the OLDEST full-budget chunk of the
        // big range (MARKER_4_ sits in it). The tail-first selection named the
        // sub-minimum newest chunk, had its preview rejected, and poisoned the
        // whole range — so under that selection no batch ever contained
        // MARKER_4_.
        const t0 = Math.min(...sum.intervals.map((iv) => iv.start));
        assert.ok(sum.intervals.some((iv) => iv.body.includes("MARKER_4_") && iv.start - t0 <= 10),
            `the first batch wave must include the oldest chunk of the multi-chunk range (first bodies: ${sum.intervals.slice(0, 4).map((iv) => iv.body.slice(0, 60)).join(" | ")})`);

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        // Big range: four foldable chunks plus the tail range — at least five
        // blocks. A poisoned big range yields only the single tail block.
        assert.ok(activeBlocks.length >= 5, `the multi-chunk range must keep folding chunk by chunk (got ${activeBlocks.length} block(s))`);
    } finally {
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

test("#2678: a batch-failed range is retried in later rounds while siblings keep folding", async () => {
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream("MARKER_0_");
    const proxy = await startProxy(main.url, sum.url, 12_000);
    try {
        const r = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${main.url}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "batch-retry-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "t4-retry") }),
        });
        assert.equal(r.status, 200, "one poisoned range must not brick the turn — the rest fold and the payload fits");
        await r.text();

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 2, `healthy batch ranges must still apply across rounds (got ${activeBlocks.length} block(s))`);
        // The failed range is re-nominated into later batches every round until
        // the pass ends — at least three attempts, not the single one a
        // drop-silently or poison-once mode would show.
        const failedAttempts = sum.intervals.filter((iv) => iv.body.includes("MARKER_0_")).length;
        assert.ok(failedAttempts >= 3, `the failed range must be retried across multiple rounds (got ${failedAttempts} attempt(s))`);
    } finally {
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
