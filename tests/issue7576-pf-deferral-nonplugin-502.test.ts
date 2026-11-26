// #7576-1: a ≥1MiB OpenAI body carrying a pf handshake header gets its full
// JSON.parse DEFERRED in handle.ts (#7398) — `parsed.messages` is the null
// marker and the real parse is owed to prepareOpenai. That re-parse used to sit
// INSIDE the `pluginMode && !titleGen && watermark` gate, so when the server is
// NOT in plugin mode (lane degraded / subagent proxy fallback / #4855 / the
// watermark rolled back to 0) the null marker reached openaiToCore and the
// request 502'd with "wireMessages is not iterable" — the upstream never saw
// the bytes. The client stamps the pf headers unconditionally, so every large
// non-plugin request on such a server was a hard 502.
//
// Direction (#3617):
//   POSITIVE — big body + pf header, NON-plugin → 200 AND the upstream captured
//     the full messages array (the re-parse ran outside the gate).
//   NEGATIVE — same big body WITHOUT the pf header (no deferral) → 200, the
//     legacy full-parse path is unchanged.
//   NEGATIVE — small body + pf header (under the 1MiB deferral floor) → 200,
//     the deferral never fires, legacy parse.
//
// One server serves all three requests (distinct session names; pluginMode is
// false throughout, so the watermark lane never stamps and the sessions are
// independent).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";

const MODEL = "model-test";

function makeUpstream(sink: { raw: string }[]) {
    return http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            sink.push({ raw: data });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 1, model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
            }));
        });
    });
}

async function bringUp(captured: { raw: string }[]) {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), "pf-deferral-nonplugin-"));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { [MODEL]: { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { proxy, origin: `http://127.0.0.1:${paddr.port}`, upstream, root };
}

// A body ≥1MiB (the #7398 deferral floor) with a normal scannable shape.
function bigBody(): string {
    const pad = "x".repeat(1_200_000);
    return JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: pad }] });
}

function smallBody(): string {
    return JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hi" }] });
}

test("#7576-1: big pf-handshake body on a NON-plugin server must not 502 (re-parse outside the gate)", async () => {
    const captured: { raw: string }[] = [];
    const h = await bringUp(captured);
    try {
        const body = bigBody();
        assert.ok(Buffer.byteLength(body) >= 1_048_576, `test body must be ≥1MiB, got ${Buffer.byteLength(body)}`);

        // POSITIVE: pf header present, NO x-bili-plugin header → non-plugin mode.
        // Before the fix this 502'd with "wireMessages is not iterable".
        const res = await fetch(`${h.origin}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer k",
                "x-acp-session": "nonplugin-big-pf",
                "x-bili-pf-count": "1",
            },
            body,
        });
        const text = await res.text();
        assert.equal(res.status, 200, `big pf non-plugin request must succeed, got ${res.status}: ${text.slice(0, 300)}`);
        // The upstream must have received the FULL messages array (the deferral's
        // null marker was re-parsed, not forwarded).
        assert.equal(captured.length, 1, "upstream must see exactly one request");
        const upstreamObj = JSON.parse(captured[0].raw) as { messages?: unknown[] };
        assert.ok(Array.isArray(upstreamObj.messages) && upstreamObj.messages.length >= 1, "upstream must receive the full messages array");
        // The re-parse must have recovered the big user payload (the deferral's
        // null marker is NOT forwarded). Some element carries the 1.2MB content.
        const hasBigContent = upstreamObj.messages!.some((m) =>
            typeof (m as { content?: unknown }).content === "string"
            && (m as { content: string }).content.length >= 1_000_000);
        assert.ok(hasBigContent, "upstream must receive the full big user content (re-parse recovered the body)");

        // NEGATIVE: same big body WITHOUT the pf header (no deferral) → legacy
        // full-parse path, still 200.
        const res2 = await fetch(`${h.origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer k", "x-acp-session": "nonplugin-big-nopf" },
            body,
        });
        const text2 = await res2.text();
        assert.equal(res2.status, 200, `big non-pf request must succeed, got ${res2.status}: ${text2.slice(0, 300)}`);
        assert.equal(captured.length, 2);

        // NEGATIVE: small body WITH a pf header (under the deferral floor) →
        // the deferral never fires, legacy parse, 200.
        const res3 = await fetch(`${h.origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer k", "x-acp-session": "nonplugin-small-pf", "x-bili-pf-count": "1" },
            body: smallBody(),
        });
        const text3 = await res3.text();
        assert.equal(res3.status, 200, `small pf request must succeed, got ${res3.status}: ${text3.slice(0, 300)}`);
        assert.equal(captured.length, 3);
    } finally {
        await closeServers([h.proxy, h.upstream], "pf-deferral-nonplugin");
        rmSync(h.root, { recursive: true, force: true });
    }
});
