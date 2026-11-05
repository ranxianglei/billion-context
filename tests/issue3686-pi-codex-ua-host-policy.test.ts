import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { codexHealthBarApplies, isCodexClient, isCodexHost } from "../src/codex-compact.ts";
import { instructionsFingerprintApplies } from "../src/session-id.ts";

// #3686: a native pi request explicitly stamped x-bili-plugin: pi may ship a
// Codex-shaped User-Agent for relay compatibility. The UA-only isCodexClient
// then activated the CODEX-ONLY HOST POLICY (0.9 preflight health bar, forge/
// reconcile lanes, CCR/image disarm, compact-trigger dispatch, codex-table
// window alignment, instructions-fingerprint keying) on a pi session — the
// observed real-session symptom was repeated premature compression near
// 0.9×budget with costly failing summary calls. Host policy must follow the
// DECLARED identity (isCodexHost); the WIRE PROFILE (the preflight summary
// payload's codex CLI signature, #2733) follows the presented UA and is pinned
// separately below.

const CODEX_UA = "codex_cli_rs/0.25.0";
const PI_HEADERS: Record<string, string> = {
    "user-agent": CODEX_UA,
    "x-bili-plugin": "pi",
};

test("#3686: isCodexHost — explicit plugin marker outranks UA guessing", () => {
    // Headerless clients keep today's UA detection byte-for-byte.
    assert.equal(isCodexHost({ "user-agent": CODEX_UA }), true);
    assert.equal(isCodexHost({ "user-agent": ["codex desktop/1.2"] }), true);
    assert.equal(isCodexHost({ "user-agent": "my codex bridge/1.0" }), true, "token-level fallback (#645) unchanged");
    assert.equal(isCodexHost({ "user-agent": "openai-node/4.0.0" }), false);
    assert.equal(isCodexHost({}), false);
    // Declared identity wins: pi shipping a codex UA for relay compat is pi.
    assert.equal(isCodexHost(PI_HEADERS), false, "explicit pi + codex UA is NOT the codex host");
    assert.equal(isCodexHost({ ...PI_HEADERS, "x-bili-plugin": ["pi"] }), false, "array-valued marker");
    assert.equal(isCodexHost({ "user-agent": CODEX_UA, "x-bili-plugin": "opencode" }), false);
    // A blank marker carries no identity — fall back to the UA guess.
    assert.equal(isCodexHost({ "user-agent": CODEX_UA, "x-bili-plugin": " " }), true);
    // And a declared codex host is codex even without the UA.
    assert.equal(isCodexHost({ "user-agent": "openai-node/4.0.0", "x-bili-plugin": "codex" }), true);
});

test("#3686: the wire profile stays UA-based (distinct from host policy)", () => {
    // Same headers: host policy says "not codex", wire profile says "codex".
    assert.equal(isCodexClient(PI_HEADERS), true, "relay sees the presented UA, not the marker");
    assert.equal(isCodexHost(PI_HEADERS), false);
});

test("#3686: codexHealthBarApplies — mode-gated host policy", () => {
    const saved = process.env.BILI_CODEX_COMPACT;
    try {
        process.env.BILI_CODEX_COMPACT = "intercept";
        assert.equal(codexHealthBarApplies({ "user-agent": CODEX_UA }), true);
        assert.equal(codexHealthBarApplies(PI_HEADERS), false);
        assert.equal(codexHealthBarApplies({ "user-agent": "openai-node/4.0.0" }), false);
        process.env.BILI_CODEX_COMPACT = "pass";
        assert.equal(codexHealthBarApplies({ "user-agent": CODEX_UA }), false, "pass mode keeps the full-limit bar for everyone");
    } finally {
        if (saved === undefined) delete process.env.BILI_CODEX_COMPACT;
        else process.env.BILI_CODEX_COMPACT = saved;
    }
});

test("#3686: instructionsFingerprintApplies — declared identity outranks codex UA keying", () => {
    assert.equal(instructionsFingerprintApplies({ "user-agent": CODEX_UA }), true, "headerless codex keeps task-id fingerprint keying (#150)");
    assert.equal(instructionsFingerprintApplies({ "user-agent": CODEX_UA, "x-codex-turn-metadata": "thread" }), true);
    assert.equal(instructionsFingerprintApplies(PI_HEADERS), false, "declared pi keys verbatim — mid-id system drift must not fork");
    assert.equal(instructionsFingerprintApplies({ "user-agent": "openai-node/4.0.0" }), false);
});

// ---------------------------------------------------------------------------
// Real-loopback: the 0.9 bar is host policy, the codex summary wire shape is
// not. A payload sized BETWEEN the two bars folds for a genuine codex client
// and stays untouched for declared pi; past the full window both fold, and the
// pi session's summary calls must still carry the codex CLI signature (#2733).
// ---------------------------------------------------------------------------

const LIMIT = 20_000;

type UpstreamCall = { kind: "summary" | "main"; codexShaped: boolean };

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held a deterministic load-growth payload across many turns; every raw marker is derivable from the seed and none carries unique state.";

const INVALID_CODEX_BODY = JSON.stringify({
    error: { message: "invalid codex request (request id: req_3686)", type: "new_api_error", param: "", code: "invalid_responses_request" },
});

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// Mirrors the anyrouter-style strict validator from #2733: a summary call
// (single-item input) is rejected unless it carries the real codex CLI
// signature — typed message items with typed content parts AND the include
// array. Applied to EVERY client here: the relay validates presented bytes.
function isCodexShaped(body: { input?: unknown; include?: unknown }): boolean {
    const inc = body.include;
    if (!Array.isArray(inc) || !inc.includes("reasoning.encrypted_content")) return false;
    const input = body.input;
    if (!Array.isArray(input) || input.length === 0) return false;
    return input.every((item) => {
        const i = item as { type?: unknown; content?: unknown };
        if (i.type !== "message") return false;
        return Array.isArray(i.content) && i.content.every((p) => typeof (p as { type?: unknown }).type === "string");
    });
}

function makeUpstream(calls: UpstreamCall[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; input?: unknown; include?: unknown } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = Array.isArray(parsed.input) && parsed.input.length === 1;
            if (isSummary) {
                const shaped = isCodexShaped(parsed);
                calls.push({ kind: "summary", codexShaped: shaped });
                if (!shaped) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(INVALID_CODEX_BODY);
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: SUMMARY_TEXT }));
                return;
            }
            calls.push({ kind: "main", codexShaped: false });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(1000));
            res.end();
        });
    });
}

/** Alternating user/assistant messages whose CONTENT totals at least
 *  textTokens (defaultCountTokens over the raw text); the last message
 *  overshoots by at most one chunk (~600 tok), kept well inside the band. */
function sizedInput(textTokens: number): { type: string; role: string; content: string }[] {
    const input: { type: string; role: string; content: string }[] = [];
    let acc = 0;
    let i = 0;
    while (acc < textTokens) {
        const chunk = `Message ${i} of the long conversation. `.repeat(40) + `MARKER_${i}_content_`.repeat(60);
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: chunk });
        acc += defaultCountTokens(chunk);
        i++;
    }
    return input;
}

async function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: LIMIT } } } },
        modelContextLimit: LIMIT,
        kernelConfig: defaultConfig(LIMIT),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return proxy;
}

async function withHarness(fn: (proxyUrl: string, calls: UpstreamCall[]) => Promise<void>): Promise<void> {
    const calls: UpstreamCall[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, calls);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

async function post(url: string, headers: Record<string, string>, sessionId: string, input: unknown[]): Promise<Response> {
    return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: sessionId, instructions: "You are the test coding agent.", input }),
    });
}

// Band arithmetic: window LIMIT=20_000 → codex bar 18_000 / full bar 20_000.
// Measured on this hermetic fixture: the trigger sees ~19.7K total for a
// genuine codex client (proxy lane, bili injections ON — crosses its 18K bar)
// and ~18.2K for declared pi (plugin lane — stays under its 20K full bar),
// so content sized to ≥15_000 tokens sits strictly between the two bars.
const STRADDLE_TEXT = 15_000;

test("#3686 e2e: genuine codex client between the bars folds (control)", async () => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    try {
        await withHarness(async (url, calls) => {
            const r = await post(url, { "user-agent": CODEX_UA }, "s3686-codex", sizedInput(STRADDLE_TEXT));
            assert.equal(r.status, 200, `preflight must fold despite the strict codex-shape validator, got ${r.status}`);
            await r.text();
            const summaries = calls.filter((c) => c.kind === "summary");
            assert.ok(summaries.length >= 1, `a summarization call must have been made (got ${JSON.stringify(calls)})`);
            assert.ok(summaries.every((c) => c.codexShaped), `every summary call must carry the codex CLI signature, got ${JSON.stringify(summaries)}`);
            const sess = listSessions().find((s) => s.meta.label === "s3686-codex");
            assert.ok(sess, "session exists");
            assert.ok((sess!.state.blocks ?? []).some((b) => b.active), "the preflight fold landed on the session");
        });
    } finally {
        delete process.env.BILI_CODEX_COMPACT;
    }
});

test("#3686 e2e: declared pi between the bars does NOT fold (the bug)", async () => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    try {
        await withHarness(async (url, calls) => {
            const r = await post(url, { ...PI_HEADERS, "x-bili-plugin-conversation": "s3686-pi" }, "s3686-pi", sizedInput(STRADDLE_TEXT));
            assert.equal(r.status, 200, `request must forward cleanly, got ${r.status}`);
            await r.text();
            // Exactly the main forward — zero side-channel summary calls.
            assert.equal(calls.length, 1, `expected ONLY the main forward, got ${JSON.stringify(calls)}`);
            assert.equal(calls[0].kind, "main");
            const sess = listSessions().find((s) => s.meta.label === "s3686-pi");
            assert.ok(sess, "session exists");
            assert.ok(!(sess!.state.blocks ?? []).some((b) => b.active), "no fold may land for a declared pi host above the 0.9 bar");
        });
    } finally {
        delete process.env.BILI_CODEX_COMPACT;
    }
});

test("#3686 e2e: declared pi past the FULL window folds, summary calls keep the codex wire shape (#2733)", async () => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    try {
        await withHarness(async (url, calls) => {
            // Mid-window sanity first: nothing fires at 12K.
            const warm = await post(url, { ...PI_HEADERS, "x-bili-plugin-conversation": "s3686-pi-over" }, "s3686-pi-over", sizedInput(12_000));
            assert.equal(warm.status, 200);
            await warm.text();
            assert.equal(calls.length, 1, `mid-window request must not summarize, got ${JSON.stringify(calls)}`);

            // Past the full window the pi session DOES fold — and the strict
            // relay must accept its summary calls (wire profile follows UA).
            const r = await post(url, { ...PI_HEADERS, "x-bili-plugin-conversation": "s3686-pi-over" }, "s3686-pi-over", sizedInput(22_000));
            assert.equal(r.status, 200, `over-window preflight must succeed on the strict relay, got ${r.status}`);
            await r.text();
            const summaries = calls.filter((c) => c.kind === "summary");
            assert.ok(summaries.length >= 1, `an over-window summarization call must have been made (got ${JSON.stringify(calls)})`);
            assert.ok(summaries.every((c) => c.codexShaped),
                `declared pi still presents a codex UA, so its summary calls must keep the codex CLI signature (#2733), got ${JSON.stringify(summaries)}`);
            const sess = listSessions().find((s) => s.meta.label === "s3686-pi-over");
            assert.ok(sess, "session exists");
            assert.ok((sess!.state.blocks ?? []).some((b) => b.active), "the over-window fold landed on the session");
        });
    } finally {
        delete process.env.BILI_CODEX_COMPACT;
    }
});
