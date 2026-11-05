import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #3713: on the Responses lane, plugin/codex requests mask every NON-leading
// role system/developer item in place (`__bili_inplace_sysdev`, #1638) while
// projecting to core — so those items enter neither projection.msgs nor
// projection.systemParts. prepare-responses recorded the k̂ denominator
// (session.stats.lastLocalTextEstimate) from exactly those two projections, so
// mid-history sys/dev mass was invisible to it while estimateWireOverhead (the
// preflight base) DID bill it: every usage report settled an inflated
// sample (billed/under-counted-denominator) and k̂ drifted toward the
// accumulation ratio (2.85x in the field), until raw × k̂ crossed the context
// limit and preflight rejected near-window turns with a non-retryable 502.
//
// Two pins, both driven through the real proxy in plugin mode:
//  1. denominator delta — appending one large mid-history developer item
//     between two otherwise-identical requests must raise BOTH
//     lastLocalTextEstimate and systemPromptTokens by that item's token cost
//     (pre-fix: the delta misses it entirely).
//  2. calibration stability — with an upstream that bills exactly chars/4 of
//     what it receives, k̂ must stay near 1 as mid-history items accumulate
//     (pre-fix: samples inflate monotonically with the accumulation ratio).
process.env.NODE_ENV = "test";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-r3713-"));
test.after(() => rmrf(testRoot));

type Item = Record<string, unknown>;

async function closeServer(srv?: http.Server): Promise<void> {
    if (!srv) return;
    srv.close();
    srv.closeIdleConnections?.();
    await once(srv, "close").catch(() => {});
}

const devItem = (text: string): Item => ({ role: "developer", content: text });
const userItem = (text: string): Item => ({ role: "user", content: text });
const assistantItem = (text: string): Item => ({ role: "assistant", content: text });

interface Harness {
    url: string;
    close: () => Promise<void>;
}

// Fake Codex-compatible Responses upstream. When `bill` is provided the
// response.completed frame carries usage whose input_tokens is bill(chars) of
// the received {input, instructions, tools} payload — the stand-in for "the
// provider tokenizer bills this exact wire". Without `bill` no usage is
// reported, so no calibration settle runs and the prepare-time denominator
// slot survives for inspection.
async function startHarness(bill?: (bodyChars: number) => number): Promise<Harness> {
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    let seq = 0;
    upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Item;
            const input = Array.isArray(body.input) ? body.input : [];
            seq += 1;
            const completed: Item = {
                id: `resp_${seq}`,
                object: "response",
                status: "completed",
                model: "gpt-test",
                output: [{
                    id: `msg_o_${seq}`,
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [{ type: "output_text", text: `ok ${seq}` }],
                }],
            };
            if (bill) {
                const chars = JSON.stringify({ input, instructions: body.instructions, tools: body.tools }).length;
                completed.usage = { input_tokens: bill(chars), output_tokens: 8 };
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: completed.id, object: "response", status: "in_progress", output: [] } })}\n\n`);
            res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
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
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
        close: async () => {
            await closeServer(proxy);
            await closeServer(upstream);
        },
    };
}

async function postTurn(url: string, conv: string, input: Item[]): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "omp-plugin/0.0.1",
            "x-bili-plugin-conversation": conv,
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input }),
    });
    const raw = await res.text();
    assert.ok(res.ok, `request failed HTTP ${res.status}: ${raw.slice(0, 300)}`);
    assert.ok(raw.includes("data:"), `not an SSE reply: ${raw.slice(0, 120)}`);
}

function findSession(conv: string) {
    const sess = listSessions().find((s) => s.id === conv || s.id.startsWith(`${conv}|`));
    assert.ok(sess, `session for conversation ${conv} not found (have: ${listSessions().map((s) => s.id).join(", ")})`);
    return sess;
}

test("#3713: the k̂ denominator counts masked mid-history sys/dev items (responses lane)", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "delta-"));
    try {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
        _resetSessionsForTest();
        setRegistryForTest({});
        _setStoreForTest(new SessionStore({ enabled: false }));

        const h = await startHarness();
        const conv = "conv-3713-delta";
        try {
            // ASCII so defaultCountTokens is exactly ceil(len/4).
            const lead = "host agent instructions line 0123456789. ".repeat(31);
            const big = "mid-history reminder unit abcdefghijklmnopqrstuvwxyz ".repeat(495);
            const bigTok = defaultCountTokens(big);
            assert.ok(bigTok >= 4000, `fixture too small to discriminate: ${bigTok}`);

            await postTurn(h.url, conv, [devItem(lead), userItem("q1 please analyze the repository layout")]);
            const e1 = findSession(conv).stats.lastLocalTextEstimate;
            const sp1 = findSession(conv).metadata.systemPromptTokens;
            assert.ok(typeof e1 === "number" && e1 > 0, `turn 1 denominator must be recorded (got ${String(e1)})`);
            assert.ok(typeof sp1 === "number" && sp1 > 0, `turn 1 systemPromptTokens must be recorded (got ${String(sp1)})`);

            // Same leading system, same tools — the ONLY new mass is the
            // mid-history developer item (plus two tiny messages).
            await postTurn(h.url, conv, [
                devItem(lead),
                userItem("q1 please analyze the repository layout"),
                assistantItem("a1 done, here is the layout"),
                devItem(big),
                userItem("q2 continue with the second pass"),
            ]);
            const e2 = findSession(conv).stats.lastLocalTextEstimate;
            const sp2 = findSession(conv).metadata.systemPromptTokens;
            assert.ok(typeof e2 === "number" && e2 > 0, `turn 2 denominator must be recorded (got ${String(e2)})`);
            assert.ok(typeof sp2 === "number" && sp2 > 0, `turn 2 systemPromptTokens must be recorded (got ${String(sp2)})`);

            const dE = e2! - e1!;
            const dSP = sp2! - sp1!;
            // Pre-fix the delta misses `big` entirely (tens of tokens for the
            // two tiny messages instead of ~5k) and fails the lower bound.
            assert.ok(dE >= bigTok - 160, `lastLocalTextEstimate must gain the mid-history sys/dev mass: delta=${dE}, expected ≈ ${bigTok}`);
            assert.ok(dE <= bigTok + 640, `lastLocalTextEstimate delta over-counted: delta=${dE}, expected ≈ ${bigTok}`);
            // #4166: a mid-history developer item is positioned conversation
            // data, not system prompt — systemPromptTokens must NOT absorb
            // its mass (pre-#4166 the hoist folded it into systemParts and
            // this delta was ≈ bigTok; that shape is retired).
            assert.ok(dSP <= 160, `systemPromptTokens must not absorb positioned mid-history sys/dev mass (#4166): delta=${dSP}`);
        } finally {
            await h.close();
        }
    } finally {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        rmrf(root);
    }
});

test("#3713: k̂ stays near the true billing ratio as mid-history sys/dev accumulates", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "khat-"));
    try {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
        _resetSessionsForTest();
        setRegistryForTest({});
        _setStoreForTest(new SessionStore({ enabled: false }));

        // Provider bills exactly chars/4 of the wire payload it receives —
        // the true ratio is 1.0. Pre-fix the denominator misses the growing
        // mid-history share, so samples inflate with the accumulation ratio.
        const h = await startHarness((chars) => Math.floor(chars / 4));
        const conv = "conv-3713-khat";
        try {
            const lead = "host instruction line 0123456789. ".repeat(267); // ~8k chars
            const fillUser = "user context paragraph ".repeat(100); // ~2k chars
            const fillAsst = "assistant context paragraph ".repeat(100); // ~2.4k chars
            const mid = (tag: string, chars: number): string => `${tag} ` + "x".repeat(Math.max(0, chars - tag.length - 1));

            let input: Item[] = [devItem(lead), userItem(fillUser), assistantItem(fillAsst)];
            await postTurn(h.url, conv, input);

            input = [...input, devItem(mid("notification-A", 3000)), userItem("q2 next step")];
            await postTurn(h.url, conv, input);

            input = [...input, assistantItem("a2 done"), devItem(mid("notification-B", 6000)), userItem("q3 next step")];
            await postTurn(h.url, conv, input);

            input = [...input, assistantItem("a3 done"), devItem(mid("notification-C", 9000)), userItem("q4 next step")];
            await postTurn(h.url, conv, input);

            // The loop settles usage after the client body completes; give the
            // end-of-stream bookkeeping a beat before reading the session stats.
            await new Promise((r) => setTimeout(r, 250));
            const sess = findSession(conv);
            assert.ok(sess.stats.lastInputTokens > 0, `usage must settle on the responses wire (lastInputTokens=${sess.stats.lastInputTokens})`);
            const k = sess.stats.calibratedEstimate;
            assert.ok(typeof k === "number", `calibratedEstimate must publish on the responses lane (got ${String(k)})`);
            const values = sess.stats.calibrationRing?.values ?? [];
            assert.ok(values.length >= 2, `calibration ring must hold samples (got ${values.length}: ${JSON.stringify(values)})`);
            const first = values[0];
            const last = values[values.length - 1];
            const max = Math.max(...values);
            const min = Math.min(...values);
            // True ratio is 1.0; the local estimator vs raw-JSON-chars gap
            // keeps post-fix samples in a tight band around ~1.1. Pre-fix the
            // last sample inflates toward S/(S-midShare) (~2.5+) and the ring
            // spreads accordingly.
            assert.ok(k! <= 1.6, `k̂ must stay near the true ratio (fake bills chars/4), got ${k} — inflated denominator drift`);
            assert.ok(max / min <= 1.35, `calibration samples must stay stable across accumulation, got spread ${max / min} (${JSON.stringify(values)})`);
            assert.ok(last / first <= 1.3, `samples must not drift upward as mid-history mass accumulates, got ${last / first} (${JSON.stringify(values)})`);
        } finally {
            await h.close();
        }
    } finally {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        rmrf(root);
    }
});
