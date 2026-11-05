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

// #3900/#4079 (closed-loop half): a route whose payloads the local estimator
// UNDER-counts (CJK-heavy bodies; est 20k for a body the provider bills at
// 40k message tokens) used to 400 forever — the estimator only learns from
// SUCCESSFUL usage reports (settleUsageReport), and a route that never
// succeeds never teaches. Now the 400's own stated counts (#3450) feed the
// SAME calibration ring: after two agreeing rejections k̂ ≈ 2 publishes, so
// the NEXT preflight judges the same payload at its true size instead of
// "fits". The arm (#1110/#3738/#3450) keeps its exact old behavior — only
// the learning path is added.

// Local estimate of the body below: 20,000 CJK chars → ~20k tokens
// (defaultCountTokens bills CJK one char per token). The upstream states the
// rejected payload at 40k message tokens → implied k̂ ≈ 2.0 on every rejection.
const OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 30000 tokens. However, you requested 45000 tokens (40000 in the messages, 5000 in the completion). Please reduce the length of the inputs or output.",
    },
});

const CJK_TURN = "据".repeat(20_000);

function proxyBaseOptions(upstreamPort: number, window: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: window } } } },
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
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
    } as ProxyOptions;
}

test("e2e #3900: two overflow 400s with stated counts publish k̂ — the estimator learns from rejections, the arm behaves exactly as before", async () => {
    let calls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            chunks.length = 0;
            calls += 1;
            res.writeHead(400, { "content-type": "application/json" });
            res.end(OVERFLOW_BODY);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 30_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [{ role: "user", content: CJK_TURN }] });
        const headers = { "content-type": "application/json", "x-acp-session": "t3900-learn-sess" };

        // The local estimate (~20k) fits the 30k window, so both turns forward —
        // and both get rejected with the provider's own counts.
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 400, "turn 1 surfaces the upstream rejection (single active turn: nothing foldable)");
        await r1.text();
        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 400, "turn 2 (same body, client retry) is forwarded again — est still fits");
        await r2.text();
        assert.ok(calls >= 2, `upstream saw the doomed body at least twice (got ${calls})`);

        const s = listSessions().find((x) => x.id === "t3900-learn-sess");
        assert.ok(s, "session exists");
        const st = s!.stats;
        // THE point of the PR: k̂ published from the rejections themselves.
        // The pending pair estimates ~24.5k (20k content + the injected tool/system
        // text estimate) for a body the provider bills at 40k message tokens →
        // implied k̂ ≈ 1.63, consistently on every rejection.
        const k = st.calibratedEstimate;
        assert.ok(typeof k === "number" && k > 1.4 && k < 2.1, `k̂ ≈ 40k/24.5k ≈ 1.6 learned from two 400s: got ${k}`);
        assert.ok(st.calibrationRing && st.calibrationRing.values.length >= 2, "at least two samples in the ring");
        for (const v of st.calibrationRing!.values) assert.ok(v > 1.4 && v < 2.1, `ring sample ≈1.63 (got ${v})`);
        assert.equal(st.calibratedEstimateOrigin, st.calibrationRing!.origin, "published factor carries the ring's route provenance");
        // (The pair the 400s consumed is retired by settleOverflowCalibration —
        // pinned directly in the unit test; here the refold hook's re-prepare
        // legitimately notes a fresh pair afterwards, so lastLocalTextEstimate
        // may hold a new value by the time we look.)
        // The arm keeps its #1110/#3738/#3450 semantics untouched: the
        // baseline is still min(stated message tokens, the judging limit).
        // Only the judging limit moves: this 400 proved the upstream bills a
        // 5_000-token completion share against the 30_000 wall (#3900), so
        // handle.ts rewrites effectiveContextLimit to 25_000 and the clamp
        // lands there - the window the session can actually use. The clamp
        // RULE is what this assertion pins; the stated ceiling is unchanged
        // by it (asserted right below).
        assert.equal(st.lastInputTokensSource, "overflow-arm");
        assert.equal(st.lastInputTokens, 25_000, "armed at min(stated messages 40k, proven judging limit 25k = 30k - 5k completion share) - #3738 clamp");
        assert.equal(st.overflowArmTokens, 30_000, "guard keeps the stated ceiling");
        assert.equal(st.overflowArmCompletionReserve, 5_000, "the completion share stays reserved (#3450)");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #3900 negative: without stated counts the estimator learns nothing (legacy shapes stay legacy)", async () => {
    // A 400 with no parseable counts/window marker shape — pre-#3450 providers —
    // must not invent a sample: the ring stays empty, k̂ stays unpublished.
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            chunks.length = 0;
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 30000 tokens. However, you requested 45000 tokens. Please reduce the length of the inputs." } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 30_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [{ role: "user", content: CJK_TURN }] });
        const headers = { "content-type": "application/json", "x-acp-session": "t3900-neg-sess" };
        for (let i = 0; i < 2; i++) {
            const r = await fetch(url, { method: "POST", headers, body });
            assert.equal(r.status, 400);
            await r.text();
        }
        const s = listSessions().find((x) => x.id === "t3900-neg-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.stats.calibratedEstimate, undefined, "no stated counts → no sample → no k̂ (fail-closed)");
        assert.ok(!s!.stats.calibrationRing || s!.stats.calibrationRing.values.length === 0, "ring admits nothing");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
