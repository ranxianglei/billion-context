import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #4185: an IDENTIFIED session (its own stable id via the session header — the
// dsh/codex/claude-code lanes all stamp one) whose request exceeds the
// headroom-adjusted window with ZERO compressible ranges used to hit the
// final fail-fast: the #3146 forward-once gate keyed on `unknownBaseline`,
// whose `anonymous &&` (#553 trigger-side concern) excluded identified
// sessions. The 413 then armed #3846's local-refusal pin and every client
// retry re-failed deterministically — a session permanently dead from message
// one (2026-10-21 raccoon incident: ~227K est vs the 192001 headroom target
// while payload + clamped output budget fit the 256000 native window).
//
// Fix: the gate takes three arms with unchanged internals (doom bytes #2490,
// #3846 pin, forward once): unknownBaseline (original), noUpstreamEvidence
// (identified but lastInputTokens==0 and no stated wall → arbitrate), and
// nativeFitAfterClamp (the OUTBOUND body — already #453/#2096-clamped in
// prepare — plus its declared output budget fits the NATIVE window; the
// headroom reservation is policy, not physics).
//
// Zero-compressible construction (the incident shape): every foldable
// candidate is excluded by the HARD protectedTools carve, which preflight
// keeps even after relaxing the soft recent zone. The giant payload rides a
// protected tool result, so preflight spends ZERO summarization calls and
// returns a deterministic-exhausted verdict — exactly the incident lane.
//
// Both directions pinned (#3617): the over-headroom-but-natively-fitting
// payloads forward (tests 1–2), while mathematically doomed bytes (test 3)
// and a usage-backed payload that exceeds the NATIVE window (test 4) still
// fail fast 413 with nothing forwarded — the escape hatch must not become a
// floodgate.
//
// The mock upstream enforces the model window on a REALISTIC tokenizer (the
// CJK-aware caliber bili itself estimates with), like the #3146 fixture — so
// "natively fits" is judged by the same math a real provider bills with.

const WINDOW = 40_000;
// reserveOutputHeadroom: min(max_tokens=40000, 25% of 40000) = 10000 reserved
// → headroom-adjusted limit 30000. The incident shape (256000−63999=192001)
// scaled down 6.4×.
const LIMIT = WINDOW - 10_000;
// ~34k planning tokens of ASCII inside a protected tool result: over the
// 30000 headroom limit, under the 40000 native window with room for the
// 4096 clamped output budget — the incident shape.
const FIT_GIANT_CHARS = 134_000;

function okSseOpenai(inputTokens: number): string {
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    return (
        frame({ id: "c_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }) +
        frame({ id: "c_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: 5 } }) +
        "data: [DONE]\n\n"
    );
}

function realisticTokens(text: string): number {
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    return cjk + Math.ceil((text.length - cjk) / 4);
}

type Call = { stream: boolean; body: string };

// Upstream enforcing the window on the realistic tokenizer; records every
// call so tests can assert what was (not) forwarded.
function makeUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: Array<{ content?: unknown }> } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            const textTokens = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? realisticTokens(m.content) : 0), 0);
            if (textTokens > WINDOW) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `context_length_exceeded: ${textTokens} > ${WINDOW}`, type: "invalid_request_error" } }));
                return;
            }
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSseOpenai(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "SUMMARY: " + "folded detail. ".repeat(120) } }] }));
            }
        });
    });
}

async function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "q-small": { context: WINDOW } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, { protectedTools: ["load_report"] }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

function post(proxyPort: number, upstreamPort: number, sessionId: string, messages: unknown[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "q-small", stream: true, max_tokens: 40_000, messages }),
    });
}

// The incident shape: the giant content rides a load_report tool result. The
// protectedTools carve excludes the turn from every fold candidate (kept even
// under the relaxed recent zone), the trailing user message is an open turn —
// so preflight finds ZERO viable ranges, spends no summarization, and returns
// a deterministic verdict with the payload intact.
function incidentConversation(giantChars: number): unknown[] {
    return [
        { role: "user", content: "Load the incident log and summarize it." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_g", type: "function", function: { name: "load_report", arguments: JSON.stringify({ file: "incident.log" }) } }] },
        { role: "tool", tool_call_id: "call_g", content: "TOOLMARKER_4185_ " + "z".repeat(giantChars) },
        { role: "user", content: "Now analyze the report above." },
    ];
}

async function withFixture(fn: (proxyPort: number, upstreamPort: number, calls: Call[]) => Promise<void>): Promise<void> {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await fn(proxyPort, upstreamPort, calls);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("identified fresh session: over the headroom limit, zero compressible, natively fitting → forwarded once with no summarization spent (#4185 arm 2)", async () => {
    await withFixture(async (proxyPort, upstreamPort, calls) => {
        const r = await post(proxyPort, upstreamPort, "s-4185-fresh", incidentConversation(FIT_GIANT_CHARS));
        const body = await r.text();
        assert.equal(r.status, 200, `the identified fresh session must forward instead of fail-fast 413: ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, `exactly one upstream call (the forward); got ${calls.length}`);
        assert.ok(calls[0].stream, "the single call is the forwarded stream");
        assert.ok(calls[0].body.includes("TOOLMARKER_4185_"), "the protected-tool payload forwards intact");
        assert.equal(getSession("s-4185-fresh").stats.lastInputTokens, 1000, "the arbitrated turn's usage settles the baseline");
    });
});

test("usage-backed session: over the headroom limit, zero compressible → forwarded with the #453/#2096-clamped output budget that fits the native window (#4185 arm 3)", async () => {
    await withFixture(async (proxyPort, upstreamPort, calls) => {
        // Land a usage baseline first: the session is no longer "fresh", so
        // only the native-fit arm can save the over-headroom turn — the
        // incident's second-request shape (and any post-arbitration retry
        // that still has nothing to fold).
        const small = await post(proxyPort, upstreamPort, "s-4185-baseline", [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ]);
        await small.text();
        assert.equal(small.status, 200);
        assert.equal(getSession("s-4185-baseline").stats.lastInputTokens, 1000, "baseline landed");

        const r = await post(proxyPort, upstreamPort, "s-4185-baseline", incidentConversation(FIT_GIANT_CHARS));
        const body = await r.text();
        assert.equal(r.status, 200, `usage-backed but natively-fitting payload must forward: ${body.slice(0, 300)}`);

        const forwards = calls.filter((c) => c.stream);
        const giant = forwards[forwards.length - 1];
        assert.ok(giant, "the giant payload was forwarded");
        assert.ok(giant.body.includes("TOOLMARKER_4185_"), "the forward is the giant payload, not the warmup");
        const budget = (JSON.parse(giant.body) as { max_tokens?: number }).max_tokens;
        assert.equal(budget, 4096, "the outbound output budget is the clamped one (margin 2048 → capability floor 4096), riding the forward");
    });
});

test("identified fresh session with mathematically doomed bytes (>2MB core) → still fail-fast 413, nothing forwarded (#4185 negative)", async () => {
    await withFixture(async (proxyPort, upstreamPort, calls) => {
        const r = await post(proxyPort, upstreamPort, "s-4185-doomed", incidentConversation(2_100_000));
        const body = await r.text();
        assert.equal(r.status, 413, "doomed bytes must still fail fast");
        assert.ok(body.includes("no upstream can accept it"), `doom diagnostic present: ${body.slice(0, 300)}`);
        assert.equal(calls.length, 0, "nothing forwarded and no summarization spent");
    });
});

test("usage-backed session whose payload exceeds the NATIVE window → still fail-fast 413, nothing forwarded (#4185 negative)", async () => {
    await withFixture(async (proxyPort, upstreamPort, calls) => {
        const small = await post(proxyPort, upstreamPort, "s-4185-native-over", [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ]);
        await small.text();
        assert.equal(small.status, 200);

        // ~45k realistic tokens: over the 40000 NATIVE window itself — no
        // clamp can make input+output fit, so no arm may open.
        const r = await post(proxyPort, upstreamPort, "s-4185-native-over", incidentConversation(180_000));
        const body = await r.text();
        assert.equal(r.status, 413, `genuinely-unfit payload must still fail fast, got body: ${body.slice(0, 200)}`);
        assert.ok(body.includes("exceeds the model window"), `over-window diagnostic present: ${body.slice(0, 300)}`);
        assert.equal(calls.filter((c) => c.body.includes("TOOLMARKER_4185_")).length, 0, "the giant payload was never forwarded");
    });
});
