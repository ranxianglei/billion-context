// #1891: the #1606 seam detector false-flagged the FIRST measurable sample of
// a session as a "suspected mid-history prefix break". Root cause: with no
// previous ledger baseline, decomposeSample(prev=null) forces growth=0 and
// books the ENTIRE uncached initial bill as ttlRepay — which detectSeam then
// misreads as an unexplained residual. In the field log (#1891) all five
// flagged events were exactly this shape (unexplained == input − cached).
// Fix: rebook the no-baseline residual as new content (closure invariant held),
// mark the line nb, skip it in detectSeam, surface initialBills in the report.
// Second half of the same failure domain: the main send path never captured
// outbound bodies, so lanes like /bili/-prefix streaming got "aggregate flag
// only" — no byte-level forensics possible. noteForwardedBody now runs at the
// single main chokepoint (server.ts fetchWithTransportRetry site).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, type Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `issue1891-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-10-02T03:59:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("#1891: first measurable sample books its uncached bill as new content, never flags a seam", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 0); // worst case: zero cache on the opener
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.nb, 1, "line marked no-baseline");
    assert.notEqual(line.seam, 1, "opener must not be flagged as a mid-history break");
    assert.equal(line.missed, 100_000);
    assert.equal(line.nc, 100_000, "whole uncached bill booked as new content");
    assert.equal(line.tr, 0, "nothing was billed before — nothing could have expired");
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(led.agg.nbSamples, 1);
    assert.equal(led.agg.nbInput, 100_000);
    const report = buildSessionCacheReport(s);
    assert.equal(report.totals.residual, 0, "closure invariant preserved by the rebooking");
    assert.equal(report.totals.balanced, true);
    assert.equal(report.invalidation.remaining, 0, "initial bill must not pollute the unattributed TTL bucket");
    assert.equal(report.initialBills.samples, 1);
    assert.equal(report.initialBills.inputTokens, 100_000);
    const text = handleAcpCache(s).text;
    assert.ok(!text.includes("CACHE SEAM"), "no seam section for an opener");
    assert.match(text, /initial bills \(no prior baseline\)/);
});

test("#1891 field signature: input=25074 cached=1024 (hit 4%) is an initial bill, not a seam", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["sys", "user"]));
    settle(s, T0, 25_074, 1_024);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.nb, 1);
    assert.equal(line.nc, 24_050, "unexplained==input−cached from the field log becomes newContent");
    assert.equal(line.tr, 0);
    assert.equal(led.agg.seamSuspects, 0);
    assert.ok(!handleAcpCache(s).text.includes("CACHE SEAM"));
});

test("#1891 guard against over-suppression: a REAL mid-history break after a baseline still flags", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000); // healthy baseline (now nb-marked, harmless)
    noteForwardedBody(s, body(["a", "B2", "c"])); // diverges at messages[1]
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.notEqual(line.nb, 1, "second sample HAS a baseline");
    assert.equal(line.seam, 1, "real break still flagged");
    assert.equal(led.agg.seamSuspects, 1);
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "forensic event recorded");
    assert.equal(ev!.msgIndex, 1);
    assert.ok(ev!.lcpBytes > 0);
});

test("#1891: unknown-cache first sample stays quarantined (unk wins over nb)", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 50_000, reportedCached: null, output: 0, protocol: "openai", upstream: "http://u" });
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.unk, 1);
    assert.notEqual(line.nb, 1, "unmeasurable samples carry no booking at all");
    assert.equal(led.agg.unknownSamples, 1);
    assert.equal(led.agg.nbSamples, 0);
    assert.equal(led.agg.seamSuspects, 0);
});

test("#1891: pre-upgrade ledger shape normalizes nb counters (no NaN after reload)", () => {
    const s = makeSession();
    const led = getCacheLedger(s);
    const agg = led.agg as Partial<typeof led.agg>;
    delete agg.nbSamples;
    delete agg.nbInput;
    settle(s, T0, 100_000, 0);
    const norm = getCacheLedger(s);
    assert.equal(norm.agg.nbSamples, 1, "counter restored and incremented");
    assert.equal(norm.agg.nbInput, 100_000);
    const report = buildSessionCacheReport(s);
    assert.ok(Number.isFinite(report.initialBills.samples));
    assert.ok(Number.isFinite(report.initialBills.inputTokens));
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const sse = (payload: string): string => `data: ${payload}\n\n`;

test("#1891: streaming /bili/ lane captures outbound bodies at the main chokepoint (byte forensics available)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let turn = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            turn += 1;
            const cached = turn === 1 ? 19_000 : 2_000;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse(JSON.stringify({ id: `chatcmpl-${turn}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `hi ${turn}` }, finish_reason: null }] })));
            res.write(sse(JSON.stringify({ id: `chatcmpl-${turn}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20_000, completion_tokens: 5, total_tokens: 20_005, prompt_tokens_details: { cached_tokens: cached } } })));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const sessionId = "issue-1891-streaming";
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const post = (messages: Array<{ role: string; content: string }>): Promise<Response> =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });

    try {
        const resp1 = await post([
            { role: "user", content: "alpha" },
            { role: "assistant", content: "beta" },
            { role: "user", content: "gamma" },
        ]);
        assert.equal(resp1.status, 200);
        await resp1.text();
        const s1 = getSession(sessionId);
        const line1 = getCacheLedger(s1).lines[0]!;
        assert.equal(line1.nb, 1, "streaming lane: opener marked no-baseline");
        assert.equal(line1.tr, 0, "streaming lane: opener booked as new content");
        assert.equal(getCacheLedger(s1).agg.seamSuspects, 0, "openers must not cry seam on the streaming lane");

        // Same shape, message[1] rewritten, cache collapses: a genuine mid-history
        // break. Pre-fix this lane had NO body capture → seamEvents undefined
        // ("aggregate flag only"); post-fix the chokepoint note yields forensics.
        // #3023: the rewrite here is authored BY THE CLIENT (this fetch rewrote
        // message[1] in its resent list), so the pair now books the client
        // bucket — with the same body-pair forensics the chokepoint provides.
        const resp2 = await post([
            { role: "user", content: "alpha" },
            { role: "assistant", content: "BETA-REWROTE" },
            { role: "user", content: "gamma" },
        ]);
        assert.equal(resp2.status, 200);
        await resp2.text();
        const s2 = getSession(sessionId);
        const led2 = getCacheLedger(s2);
        const line2 = led2.lines[led2.lines.length - 1]!;
        assert.equal(line2.prov, "client", "client-authored rewrite books the client bucket, not the seam bucket (#3023)");
        assert.equal(line2.seam, undefined);
        assert.equal(led2.agg.clientInserts, 1);
        assert.ok(led2.seamEvents?.length, "body-pair forensics now available on the streaming lane");
        assert.ok(led2.seamEvents![0]!.lcpBytes > 0, "LCP computed from captured bodies");
        assert.ok(led2.seamEvents![0]!.msgIndex !== null && led2.seamEvents![0]!.msgIndex >= 1, "divergence located past the stable head");
        assert.equal(led2.seamEvents![0]!.client?.idx, 1, "client forensics localize the host rewrite");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
