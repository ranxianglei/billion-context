import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { DSH_TITLE_SYSTEM_PREFIX } from "../src/server/side-request.ts";

// #6466: the dsh title-gen sidecar (and every other side-lane request) is a
// best-effort utility call. Before this fix it rode the non-injected streaming
// branch with a LIVE continuation refetch, so the pipe's degenerate-turn gate
// (#732/#821 retry + #870 in-band error) fired for it: a title request that
// came back with no visible text (reasoning-only under effort=max) was
// re-issued (double-billing a utility call) and, on a second empty response,
// the client received an in-band stream error that DSH wrote straight into the
// session title (`❌ [ACP] stream error: the turn degenerated again ...`).
//
// The fix (src/server/relay.ts) passes refetch=undefined for sidePassthrough
// requests, which disables the pipe's degenerate gate AND the cut retries.
// This test pins BOTH directions (gate discipline #3617):
//   - side lane: a degenerate response ends as-is — no retry, no #870.
//   - non-side-lane non-injected: the gate still fires (retry + #870) — the
//     main path is unchanged.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-6466-side-degen-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const TITLE_SYSTEM = `${DSH_TITLE_SYSTEM_PREFIX} from the supplied human messages.\nReturn only the title on one line.`;
const MAIN_SYSTEM = "MAIN OPERATING SYSTEM";

// A degenerate chat-completion SSE turn: the ONLY visible text is a render-tag
// echo that the strip pipe removes (sawStrippedEcho=true, answerChars=0), and
// the turn ends on a clean stop — exactly the shape that trips the
// degenerate-turn gate (clean stop + no usable output + not bare).
const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";
function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
const DEGENERATE_SSE =
    chunk({ role: "assistant" }) +
    chunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context", "sessions"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    // Count upstream hits so the test can detect the degenerate retry (a
    // re-issue is a second hit on the same upstream).
    let upstreamHits = 0;
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
                upstreamHits += 1;
                if (body.stream === true) {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(DEGENERATE_SSE);
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
                }
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    // injectTool:false keeps the non-side-lane control request on the
    // NON-injected streaming branch (the one carrying the degenerate gate)
    // rather than the compress-rewriter loop.
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "fake-a": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const send = async (conversationId: string, body: Record<string, unknown>, plugin?: string) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId };
        if (plugin !== undefined) { headers["x-bili-plugin"] = plugin; headers["x-bili-plugin-conversation"] = conversationId; }
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return text;
    };
    return {
        upstreamHits: () => upstreamHits,
        send,
        close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); },
    };
}

test("#6466: a degenerate dsh title sidecar ends as-is — no retry, no #870 in-band error", async () => {
    const h = await harness();
    try {
        const history = [{ role: "user", content: "set up the workspace" }, { role: "assistant", content: "done" }];
        const titleBody = { model: "fake-a", max_completion_tokens: 4096, stream: true, messages: [{ role: "system", content: TITLE_SYSTEM }, ...history, { role: "user", content: `[${JSON.stringify(history)}]` }] };
        const text = await h.send("conv-side", titleBody, "dsh");
        assert.equal(h.upstreamHits(), 1, "side lane must not re-issue the request (no degenerate retry)");
        assert.ok(!text.includes("stream_error"), `no in-band stream error for a side lane; got: ${text}`);
        assert.ok(!text.includes("degenerated again"), `no #870 escalation for a side lane; got: ${text}`);
        assert.ok(!text.includes("[ACP] stream error"), `no [ACP] marker for a side lane; got: ${text}`);
    } finally {
        await h.close();
    }
});

test("#6466 control: a degenerate non-side-lane non-injected turn still retries + escalates (#732/#821/#870)", async () => {
    const h = await harness();
    try {
        const mainBody = { model: "fake-a", max_completion_tokens: 8192, stream: true, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "do something" }, { role: "assistant", content: "ok" }, { role: "user", content: "now do more" }], tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }] };
        const text = await h.send("conv-main", mainBody);
        assert.equal(h.upstreamHits(), 2, "non-side-lane degenerate turn must retry once (re-issue the upstream)");
        assert.ok(text.includes("stream_error"), `non-side-lane degenerate turn must escalate to an in-band error; got: ${text}`);
        assert.ok(text.includes("degenerated again"), `non-side-lane #870 message; got: ${text}`);
    } finally {
        await h.close();
    }
});
