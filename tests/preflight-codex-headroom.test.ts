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
import { listSessions, _resetSessionsForTest } from "../src/session.ts";

const LIMIT = 20_000;
const CODEX_UA = "codex_cli_rs/0.1.0 (linux x86_64)";
const SUMMARY = "HEADROOM-SUMMARY: preserved the completed investigation and decisions; the repeated historical payload is no longer needed for the current task.";
type Input = { type: "message"; role: string; content: string };
type RequestBody = { stream?: boolean; input?: unknown; instructions?: string };

// About 18.5k tokens: fits the 20k model window but misses native compact's 18k gate.
function history(count = 10, totalChars = 74_000): Input[] {
    return Array.from({ length: count }, (_, i) => ({
        type: "message", role: i % 2 === 0 ? "user" : "assistant",
        content: `History ${i}: ` + "recorded work ".repeat(Math.floor(totalChars / count / 14)),
    }));
}

async function withProxy(mode: "intercept" | "pass", run: (h: {
    calls: RequestBody[];
    post: (input: unknown, headers?: Record<string, string>) => Promise<Response>;
}) => Promise<void>): Promise<void> {
    const calls: RequestBody[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
            calls.push(body);
            if (!body.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] }] }));
                return;
            }
            const inputTokens = Math.ceil(JSON.stringify(body.input).length / 4);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
            res.end(`event: response.completed\ndata: ${JSON.stringify({ response: {
                id: "resp_done", status: "completed", output: [],
                usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
            } })}\n\n`);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    const previousMode = process.env.BILI_CODEX_COMPACT;
    const previousPrompt = process.env.ACP_NO_COMPRESS_PROMPT;
    process.env.BILI_CODEX_COMPACT = mode;
    process.env.ACP_NO_COMPRESS_PROMPT = "1";
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [origin]: { models: { "gpt-resp": { context: LIMIT } } } },
        modelContextLimit: LIMIT, kernelConfig: defaultConfig(LIMIT),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null, autoUpdate: false,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: true, releaseNotesCheck: true,
        compat: { roles: {} }, streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    const url = `http://127.0.0.1:${proxyAddress.port}/bili/${origin}/v1/responses`;
    try {
        await run({ calls, post: (input, headers) => fetch(url, {
            method: "POST", headers: { "content-type": "application/json", "user-agent": CODEX_UA, ...headers },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "headroom-session", input }),
        }) });
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (previousMode === undefined) delete process.env.BILI_CODEX_COMPACT;
        else process.env.BILI_CODEX_COMPACT = previousMode;
        if (previousPrompt === undefined) delete process.env.ACP_NO_COMPRESS_PROMPT;
        else process.env.ACP_NO_COMPRESS_PROMPT = previousPrompt;
    }
}

for (const plugin of [false, true]) {
    test(`Codex intercept folds a fitting 90-100% request before native compact (plugin=${plugin})`, async () => {
        await withProxy("intercept", async ({ post, calls }) => {
            const headers: Record<string, string> = plugin ? { "x-bili-plugin": "codex", "x-bili-plugin-conversation": "headroom-plugin" } : {};
            const response = await post(history(), headers);
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.ok(calls.some((call) => !call.stream), "preflight must make room before the native 90% gate");
            const forwarded = calls.find((call) => call.stream);
            assert.ok(forwarded);
            assert.match(JSON.stringify(forwarded.input), /HEADROOM-SUMMARY/, "forwarded history retains the summary");
            assert.ok(listSessions()[0].stats.lastInputTokens < 18_000, `forwarded usage: ${listSessions()[0].stats.lastInputTokens}`);
            const beforeCompact = calls.length;
            const compact = await post([...history(), { type: "compaction_trigger" }], headers);
            const compactText = await compact.text();
            assert.equal(compact.status, 200, compactText);
            assert.match(compactText, /compaction/);
            assert.equal(calls.length, beforeCompact, "healthy ACP handles native compaction without upstream");
        });
    });
}

test("Codex preflight keeps folding after fitting the hard window while missing headroom", async () => {
    await withProxy("intercept", async ({ post, calls }) => {
        // ~30.5k initially; 12k-budget chunks can leave a hard-fitting ~19k remainder.
        const response = await post(history(50, 122_000));
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.ok(calls.filter((call) => !call.stream).length >= 2, "preflight continues across multiple ranges");
        assert.ok(listSessions()[0].stats.lastInputTokens < 18_000, `forwarded usage: ${listSessions()[0].stats.lastInputTokens}, summary calls: ${calls.filter((call) => !call.stream).length}`);
    });
});

test("Codex forwards hard-fitting protected recent content without relaxing it for headroom", async () => {
    await withProxy("intercept", async ({ post, calls }) => {
        const input = history(2);
        const response = await post(input);
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.equal(calls.length, 1, "no summaries of protected recent content");
        for (const item of input) assert.ok(JSON.stringify(calls[0].input).includes(item.content), "recent content remains intact");
        assert.ok(listSessions()[0].stats.lastInputTokens >= 18_000);
    });
});

for (const control of [
    { name: "Codex pass mode", mode: "pass", userAgent: CODEX_UA },
    { name: "non-Codex intercept mode", mode: "intercept", userAgent: "other-client/1.0" },
] as const) {
    test(`${control.name} keeps the existing hard-window threshold`, async () => {
        await withProxy(control.mode, async ({ post, calls }) => {
            const response = await post(history(), { "user-agent": control.userAgent });
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.equal(calls.length, 1, "fitting control request forwards without preflight");
            assert.ok(calls[0].stream);
            assert.ok(listSessions()[0].stats.lastInputTokens >= 18_000);
        });
    });
}
