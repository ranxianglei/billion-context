import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #2407 addendum: the k̂ learning pair has TWO ends — the prepare-time
// denominator (lastLocalTextEstimate, written by the protocol lanes) and the
// settle-time numerator (usage report). prepare-google.ts was the only one of
// the four lanes never writing the denominator, so Gemini-native routes could
// never learn the calibration factor: settleUsageReport found no pending pair,
// discarded the samples, and the route stayed raw-estimate caliber forever
// (every gate downstream of currentCalibrationFactor ran on chars/4 even when
// the real tokenizer billed 2-4x that).
//
// Pin: drive a REAL google-wire conversation through the proxy against a fake
// Gemini upstream whose usageMetadata reports promptTokenCount = 3x the
// chars/4 estimate of the very body it received. With the denominator
// recorded, three turns must publish calibratedEstimate ≈ 3 (band 1.5-4.5 to
// stay robust to JSON-syntax overhead in the char count). Pre-fix this test
// fails at the first assertion — calibratedEstimate stays undefined.
process.env.NODE_ENV = "test";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-g-khat-"));
test.after(() => rmrf(testRoot));

type Item = Record<string, unknown>;

async function closeServer(srv?: http.Server): Promise<void> {
    if (!srv) return;
    srv.close();
    srv.closeIdleConnections?.();
    await once(srv, "close").catch(() => {});
}

test("google lane records the k̂ denominator and learns the calibration factor (#2407)", async () => {
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
    _resetSessionsForTest();
    setRegistryForTest({});
    _setStoreForTest(new SessionStore({ enabled: false }));

    // Fake Gemini: replies with a text frame + stop frame, both carrying
    // usageMetadata whose promptTokenCount is 3x the chars/4 caliber of the
    // received payload — the "real tokenizer bills 3x our estimate" stand-in.
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    const sessionId = "g-khat-2407";
    const model = "gemini-2.0-flash";
    const ctx = 200_000;
    try {
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Item;
                const chars = JSON.stringify({ contents: body.contents, systemInstruction: body.systemInstruction, tools: body.tools }).length;
                const billed = 3 * Math.floor(chars / 4);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const frame = (parts: Item[], finishReason?: string): void => {
                    const candidate: Item = { content: { role: "model", parts }, index: 0 };
                    if (finishReason) candidate.finishReason = finishReason;
                    res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: model, usageMetadata: { promptTokenCount: billed, cachedContentTokenCount: 0, candidatesTokenCount: 40, thoughtsTokenCount: 0, totalTokenCount: billed + 40 } })}\n\n`);
                };
                frame([{ text: `ok ${billed}` }]);
                frame([], "STOP");
                res.end();
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const options: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: ctx } } } },
            modelContextLimit: ctx,
            kernelConfig: defaultConfig(ctx),
            compress: { injectTool: true, injectNudge: false },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: true,
            releaseNotesCheck: true,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(options);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

        // Three growing ASCII turns — each prepare arms the denominator, each
        // usage report settles it into the calibration ring (>= 2 agreeing
        // samples publish; the third confirms stability).
        const hist: Item[] = [];
        for (let t = 1; t <= 3; t++) {
            hist.push({ role: "user", parts: [{ text: `Turn ${t}: analyze. ` + `x`.repeat(6000) }] });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ contents: [...hist], systemInstruction: { parts: [{ text: "you are a test assistant" }] }, generationConfig: { maxOutputTokens: 4096 } }) });
            const raw = await res.text();
            assert.ok(res.ok, `turn ${t}: HTTP ${res.status}: ${raw.slice(0, 300)}`);
            assert.ok(raw.includes("data:"), `turn ${t}: not an SSE reply: ${raw.slice(0, 120)}`);
            hist.push({ role: "model", parts: [{ text: `ok ${t}` }] });
        }

        // The loop settles usage after the client body completes; give the
        // end-of-stream bookkeeping a beat before reading the session stats.
        await new Promise((r) => setTimeout(r, 250));
        const sess = listSessions().find((s) => s.id === sessionId);
        assert.ok(sess, "session not found");
        assert.ok(sess.stats.lastInputTokens > 0, `usage must settle on the google wire (lastInputTokens=${sess.stats.lastInputTokens})`);
        const k = sess.stats.calibratedEstimate;
        assert.ok(typeof k === "number", `calibratedEstimate must publish on the google lane (got ${String(k)}) — pre-#2407 the denominator was never recorded`);
        assert.ok(k! >= 1.5 && k! <= 4.5, `k̂ ≈ 3 expected (fake bills 3x chars/4), got ${k}`);
        assert.ok(typeof sess.stats.calibratedEstimateOrigin === "string" && sess.stats.calibratedEstimateOrigin.length > 0, "calibratedEstimateOrigin must record the route");
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
    }
});
