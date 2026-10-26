import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// #4004/#4242: envelope-corruption rejection is the legacy-layer guard; pin
// it so the unified index cannot mask the tampered envelope.
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createInitialState, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #2129: buildRecord() persists the entire stats object, but buildSession()
// restored a hand-picked list that dropped the measurement state — learned k̂,
// the real-usage anchor, the per-turn outbound estimate, and their origins.
// After a proxy restart the preflight gate judged on the UNCALIBRATED local
// estimate (folding fitting payloads) and nudge sizing fell through to the raw
// char-count bound (EMERGENCY ghosts on fitting sessions — the #2122 incident).
// Round-trip half pins every restored field plus corrupt-value rejection; the
// e2e half replays a mature session across a simulated restart and pins that
// the oversized resend forwards without folds or an EMERGENCY nudge.

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

type StatsBlob = Record<string, unknown>;

function findRecordFile(dir: string): string {
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `expected exactly one session record, found ${files.length}`);
    return join(dir, files[0] as string);
}

test("measurement-state stats survive a reload round-trip (#2129)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-2129-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i2129-rt");
        const st = s.stats;
        st.localInputEstimate = 12345;
        st.lastUsageGradeTokens = 9876;
        st.lastInputTokensOrigin = "http://127.0.0.1:8787";
        st.calibratedEstimate = 0.4375;
        st.calibratedEstimateOrigin = "http://127.0.0.1:8787";
        st.calibrationRing = { origin: "http://127.0.0.1:8787", values: [0.4, 0.45, 0.48] };
        st.lastInputTokens = 4321;
        st.wholeBlockRestores = 3;
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i2129-rt");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.localInputEstimate, 12345, "localInputEstimate round-trips");
        assert.equal(back.stats.lastUsageGradeTokens, 9876, "lastUsageGradeTokens round-trips");
        assert.equal(back.stats.lastInputTokensOrigin, "http://127.0.0.1:8787", "lastInputTokensOrigin round-trips");
        assert.equal(back.stats.calibratedEstimate, 0.4375, "calibratedEstimate round-trips");
        assert.equal(back.stats.calibratedEstimateOrigin, "http://127.0.0.1:8787", "calibratedEstimateOrigin round-trips");
        assert.deepEqual(back.stats.calibrationRing, { origin: "http://127.0.0.1:8787", values: [0.4, 0.45, 0.48] }, "calibrationRing round-trips");
        assert.equal(back.stats.lastInputTokens, 4321, "control counter still round-trips");
        assert.equal(back.stats.wholeBlockRestores, 3, "control counter still round-trips");
    } finally {
        rmrf(dir);
    }
});

test("in-memory-only measurement fields ride to disk but are not restored (#2129 triage)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-2129-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i2129-rt2");
        s.stats.pendingFoldUsage = true;
        s.stats.lastLocalTextEstimate = 111;
        s.stats.lastLocalTextEstimateOrigin = "http://127.0.0.1:8787";
        s.stats.localInputEstimate = 12345;
        await store.writeNow(s);
        await store.flushAll([]);

        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i2129-rt2");
        assert.ok(back, "session reloaded");
        // pendingFoldUsage: restoring a stale true would mislabel the next
        // unrelated usage report; lastLocalTextEstimate(+Origin): the pending
        // k̂ pairing input whose doc already says a restart loses one pair.
        assert.equal(back.stats.pendingFoldUsage, undefined, "pendingFoldUsage intentionally not restored");
        assert.equal(back.stats.lastLocalTextEstimate, undefined, "lastLocalTextEstimate intentionally not restored");
        assert.equal(back.stats.lastLocalTextEstimateOrigin, undefined, "lastLocalTextEstimateOrigin intentionally not restored");
        assert.equal(back.stats.localInputEstimate, 12345, "restored fields unaffected");
    } finally {
        rmrf(dir);
    }
});

test("corrupt persisted measurement values are rejected at restore (#2129)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-2129-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("i2129-rt3");
        s.stats.localInputEstimate = 12345;
        s.stats.lastUsageGradeTokens = 9876;
        s.stats.lastInputTokensOrigin = "http://127.0.0.1:8787";
        s.stats.calibratedEstimate = 0.4375;
        s.stats.calibratedEstimateOrigin = "http://127.0.0.1:8787";
        s.stats.calibrationRing = { origin: "http://127.0.0.1:8787", values: [0.4, 0.45, 0.48] };
        await store.writeNow(s);
        await store.flushAll([]);

        const file = findRecordFile(dir);
        const goodEnv = JSON.parse(readFileSync(file, "utf8")) as { payload: { stats: StatsBlob } };
        const loadMutated = async (mutate: (stats: StatsBlob) => void): Promise<Session> => {
            const env = structuredClone(goodEnv);
            mutate(env.payload.stats);
            writeFileSync(file, JSON.stringify(env));
            const fresh = new SessionStore({ dir, debounceMs: 5, enabled: true });
            try {
                const back = fresh.loadSync("i2129-rt3");
                assert.ok(back, "session reloaded");
                return back;
            } finally {
                await fresh.flushAll([]);
            }
        };

        // Out-of-band values: a k̂ above the two-way clamp band [0.25, 4] (#2366)
        // would move every calibrated reading off-scale (applyEstimateCalibration
        // applies the stored factor unclamped), negative anchors/estimates are
        // nonsense, empty origins match no route.
        // JSON encodes NaN/Infinity as null — the restore guards reject both.
        const bad = await loadMutated((st) => {
            st.calibratedEstimate = 5;
            st.calibrationRing = { origin: "", values: [0.5] };
            st.localInputEstimate = -1;
            st.lastUsageGradeTokens = -5;
            st.calibratedEstimateOrigin = "  ";
            st.lastInputTokensOrigin = "";
        });
        assert.equal(bad.stats.calibratedEstimate, undefined, "out-of-band k̂ rejected");
        assert.equal(bad.stats.calibrationRing, undefined, "empty-origin ring rejected");
        assert.equal(bad.stats.localInputEstimate, undefined, "negative estimate rejected");
        assert.equal(bad.stats.lastUsageGradeTokens, undefined, "negative anchor rejected");
        assert.equal(bad.stats.calibratedEstimateOrigin, undefined, "blank origin rejected");
        assert.equal(bad.stats.lastInputTokensOrigin, undefined, "empty origin rejected");

        // A malformed ring keeps only samples the learner itself would admit
        // (finite, within the plausibility band), newest window-size entries.
        const partial = await loadMutated((st) => {
            st.calibrationRing = { origin: "http://127.0.0.1:8787", values: [0.1, 0.4, 0.5, 6, null, 0.55, 0.6] };
            st.calibratedEstimate = null;
        });
        assert.deepEqual(partial.stats.calibrationRing, { origin: "http://127.0.0.1:8787", values: [0.5, 0.55, 0.6] }, "ring filtered to admissible newest samples");
        assert.equal(partial.stats.calibratedEstimate, undefined, "null k̂ rejected");
        assert.equal(partial.stats.localInputEstimate, 12345, "untouched valid fields still restore");
    } finally {
        rmrf(dir);
    }
});

const WINDOW = 20_000;

type Call = { summary: boolean; stream: boolean; emergency: boolean };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function longMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const pad = Math.max(1, charsPerMsg - 12);
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i}: ` + "f".repeat(pad),
        });
    }
    return messages;
}

// Bills what it receives: sum(messages[].content chars)/4 x factor — the same
// caliber bili estimates with, scaled to simulate a provider whose tokenizer
// counts fewer tokens than chars/4 (factor 0.5 teaches k̂≈0.5).
function makeUpstream(factor: number): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ content?: unknown }> };
                // "Context limit reached" appears ONLY in the kernel's emergency
                // nudge renderings (T1 header / T2-T3 trigger line) — a reliable
                // ghost-nudge marker in the outbound body.
                calls.push({ summary: isSummary, stream: !!parsed.stream, emergency: !isSummary && raw.includes("Context limit reached") });
                if (!isSummary) {
                    const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                    const billed = Math.round((chars / 4) * factor);
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(chatSse("forwarded answer", { prompt_tokens: billed, completion_tokens: 3 }));
                    return;
                }
            } catch { /* fall through */ }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "SUMMARY: load-growth fixture segment." }, finish_reason: "stop" }] }));
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("e2e: restart restores k̂ + usage anchor — the over-raw resend forwards without folds or an EMERGENCY nudge (#2129)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-2129-e2e-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    let store2: SessionStore | undefined;
    _setStoreForTest(store);
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream(0.5);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`;
    const post = (messages: Array<{ role: string; content: string }>) =>
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i2129-e2e" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });

    try {
        // Phase 1 — mature the session: two growth turns teach the route its
        // billing scale (two agreeing samples publish k̂≈0.5).
        const t1 = longMessages(4, 4000);
        const r1 = await post(t1);
        assert.equal(r1.status, 200, `turn 1 must forward: HTTP ${r1.status}`);
        await r1.text();

        const t2msgs = [...t1, ...longMessages(4, 4000)];
        const r2 = await post(t2msgs);
        assert.equal(r2.status, 200, `turn 2 must forward: HTTP ${r2.status}`);
        await r2.text();

        const s = getSession("i2129-e2e");
        assert.ok(s, "session tracked before restart");
        assert.ok((s.stats.calibratedEstimate ?? 0) > 0.3 && (s.stats.calibratedEstimate ?? 0) < 0.6, `two consistent samples must publish k̂≈0.4–0.5, got ${s.stats.calibratedEstimate}`);
        assert.ok((s.stats.lastUsageGradeTokens ?? 0) > 0, "usage anchor must be settled before restart");
        assert.ok((s.stats.localInputEstimate ?? 0) > 0, "per-turn outbound estimate must be recorded before restart");
        const preRestart = {
            k: s.stats.calibratedEstimate,
            anchor: s.stats.lastUsageGradeTokens,
            est: s.stats.localInputEstimate,
        };

        // Simulate the incident's terminal pre-restart state: the last request
        // ran preflight (estimate-grade baseline write-back, src/server.ts:5933
        // shape) and the host is a prefix-affinity plugin with no client-
        // provided session identity — the DSH web-plugin shape from the #2122
        // repro. Without BOTH, the bug hides: a usage-grade baseline passes
        // nudge tier 1 even pre-fix, and without the PFA flag the dropped
        // anchor degrades to tier 4 blind-zero instead of the char-count bound.
        s.stats.lastInputTokensSource = "estimate";
        s.metadata.anonymousPrefixAffinity = { depth: 22, tailHash: "i2129-test-tail", via: "prefix" };

        // Simulated restart: snapshot the terminal state to disk (what the
        // debounced persist would eventually have captured), wipe memory, swap
        // in a fresh store — the next request hits the buildSession() reload path.
        await store.writeNow(s);
        await store.flushAll([]);
        const env = JSON.parse(readFileSync(findRecordFile(dir), "utf8")) as { payload: { stats?: StatsBlob; metadata?: StatsBlob } };
        assert.equal(env.payload.stats?.calibratedEstimate, preRestart.k, "k̂ must be on disk after restart");
        assert.equal(env.payload.stats?.lastUsageGradeTokens, preRestart.anchor, "usage anchor must be on disk after restart");
        assert.equal(env.payload.stats?.localInputEstimate, preRestart.est, "per-turn estimate must be on disk after restart");
        assert.ok(env.payload.metadata?.anonymousPrefixAffinity, "PFA stamp must be on disk after restart");
        _resetSessionsForTest();
        store2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        _setStoreForTest(store2);

        // Phase 3 — READY resend: the raw local estimate crosses the target
        // while the calibrated one stays under. Pre-fix the dropped k̂ fired
        // preflight (folding a fitting payload) and the dropped anchor sent
        // nudge sizing to the char-count bound (EMERGENCY ghost at ~120%+).
        const t3msgs = [...t2msgs, ...longMessages(14, 4000)];
        const r3 = await post(t3msgs);
        const body3 = await r3.text();
        assert.equal(r3.status, 200, `calibrated-fit resend must forward, not fold: HTTP ${r3.status} ${body3.slice(0, 240)}`);
        assert.ok(body3.includes("forwarded answer"), "the model reply must reach the client");
        assert.equal(calls.filter((c) => c.summary).length, 0, `no preflight summarization may have run (got ${calls.filter((c) => c.summary).length})`);
        assert.ok(!calls.some((c) => c.emergency), "no EMERGENCY nudge may be injected into the resent history");

        // Host retry (incident aborted/retried shape): the same oversized blob again.
        const r4 = await post(t3msgs);
        const body4 = await r4.text();
        assert.equal(r4.status, 200, `retry must forward: HTTP ${r4.status} ${body4.slice(0, 240)}`);
        assert.ok(body4.includes("forwarded answer"), "the model reply must reach the client on retry");
        assert.equal(calls.filter((c) => c.summary).length, 0, "retry must not fold either");
        assert.ok(!calls.some((c) => c.emergency), "retry must not inject EMERGENCY either");
        assert.equal(calls.filter((c) => c.stream).length, 4, "all four requests were forwarded as-is");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        store.cancelAll();
        store2?.cancelAll();
        rmrf(dir);
    }
});
