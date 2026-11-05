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

// #2733 regression: new-api / anyrouter-family codex relays validate inbound
// calls as "legitimate Codex requests" — input must be typed message items
// AND carry include:["reasoning.encrypted_content"] (the real codex CLI's
// signature, sent unconditionally by codex-rs core client.rs); anything else
// is HTTP 400 invalid_responses_request. bili's own side-channel summary call
// sent the minimal shape ({role,content}, no include) → preflight lane dead
// on such relays (12/12 rejections in the issue log) → codex local
// auto-compaction won the race. For a codex client the summary payload must
// now mirror the real CLI's wire shape; non-codex clients stay byte-identical.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state.";

const INVALID_CODEX_BODY = JSON.stringify({
    error: { message: "invalid codex request (request id: req_2733)", type: "new_api_error", param: "", code: "invalid_responses_request" },
});

type SummaryCall = { stream: boolean; codexShaped: boolean };

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// Mirrors the anyrouter-style validator: a summary call (single-item input)
// is rejected unless it carries the real codex CLI signature — typed message
// items with typed content parts AND the include array.
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

function makeUpstream(summaryCalls: SummaryCall[], strictCodexShape: boolean): http.Server {
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
                summaryCalls.push({ stream: parsed.stream === true, codexShaped: shaped });
                if (strictCodexShape && !shaped) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(INVALID_CODEX_BODY);
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: SUMMARY_TEXT }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(1000));
            res.end();
        });
    });
}

function longInput() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
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

test("#2733: codex client → summary payload carries the real CLI wire shape; strict relay accepts it, fold applies", async () => {
    const summaryCalls: SummaryCall[] = [];
    const upstream = makeUpstream(summaryCalls, true);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "codex_cli_rs/0.25.0" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "s2733-codex", instructions: "You are the test coding agent.", input: longInput() }),
        });
        assert.equal(r.status, 200, `preflight must fold despite the strict codex-shape validator (before the fix every summary call was 400'd), got ${r.status}`);
        const text = await r.text();
        void text;

        assert.ok(summaryCalls.length >= 1, `a summarization call must have been made (got ${summaryCalls.length})`);
        assert.ok(summaryCalls.every((c) => c.codexShaped),
            `every summary call must carry the codex CLI signature (typed message items + include:["reasoning.encrypted_content"]), got ${JSON.stringify(summaryCalls)}`);

        const sess = listSessions().find((s) => s.meta.label === "s2733-codex");
        assert.ok(sess, "session exists");
        assert.ok((sess!.state.blocks ?? []).some((b) => b.active), "the preflight fold landed on the session");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#2733: non-codex client → summary payload stays the legacy minimal shape (no codex signature leak)", async () => {
    const summaryCalls: SummaryCall[] = [];
    const upstream = makeUpstream(summaryCalls, false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "openai-node/4.0.0" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "s2733-noncodex", instructions: "You are the test coding agent.", input: longInput() }),
        });
        assert.equal(r.status, 200);
        await r.text();

        assert.ok(summaryCalls.length >= 1, `a summarization call must have been made (got ${summaryCalls.length})`);
        assert.ok(summaryCalls.every((c) => !c.codexShaped),
            `non-codex clients must keep the legacy minimal shape (no typed items, no include), got ${JSON.stringify(summaryCalls)}`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
