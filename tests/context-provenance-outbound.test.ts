import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

const root = mkdtempSync(join(tmpdir(), "bili-outbound-provenance-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
process.env.NODE_ENV = "test";

type Wire = "anthropic" | "openai" | "responses" | "google";
interface Status {
    contextTokens: number;
    contextTokensSource: string;
    contextTokensAt: number;
    contextGeneration: string;
    inputTokens: number;
}

async function harness(wire: Wire) {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    _setForTest({});
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    let usage = false;
    let fail = false;
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
            if (fail) { res.end(JSON.stringify({ error: { message: "isolated fixture failure" } })); return; }
            const bodies = {
                anthropic: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "answer" }], ...(usage ? { usage: { input_tokens: 10000, output_tokens: 10 } } : {}) },
                openai: { id: "chat_fixture", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], ...(usage ? { usage: { prompt_tokens: 10000, completion_tokens: 10 } } : {}) },
                responses: { id: "resp_fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], ...(usage ? { usage: { input_tokens: 10000, output_tokens: 10 } } : {}) },
                google: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }], ...(usage ? { usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 10 } } : {}) },
            };
            res.end(JSON.stringify(bodies[wire]));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "model-test": { context: 400000 }, "model-switched": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    const send = async (texts: string[], model = "model-test") => {
        const messages = texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));
        const body = wire === "google" ? { contents: texts.map((text, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text }] })), generationConfig: { maxOutputTokens: 1024 } }
            : wire === "responses" ? { model, input: messages, max_output_tokens: 1024, stream: false }
                : { model, messages, max_tokens: 1024, stream: false };
        const endpoint = wire === "anthropic" ? "/v1/messages" : wire === "openai" ? "/v1/chat/completions" : wire === "responses" ? "/v1/responses" : `/v1beta/models/${model}:generateContent`;
        const r = await fetch(`${origin}/bili/${upstreamUrl}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "fixture", "x-bili-plugin-conversation": "outbound" }, body: JSON.stringify(body) });
        assert.equal(r.status, fail ? 503 : 200, await r.text());
    };
    const status = async (): Promise<Status> => {
        const r = await fetch(origin + "/__bili/plugin/status?conversationId=outbound");
        assert.equal(r.status, 200);
        return await r.json() as Status;
    };
    return { send, status, forwarded, setUsage: (value: boolean) => { usage = value; }, setFail: () => { fail = true; }, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

for (const wire of ["anthropic", "openai", "responses", "google"] as const) {
    test(`HTTP ${wire} first no-usage publishes this outbound estimate`, async (t) => {
        const h = await harness(wire);
        try {
            t.mock.method(Date, "now", () => 1791049001000);
            await h.send(["first payload ".repeat(750)]);
            const s = await h.status();
            const session = resolveConversation("outbound").session!;
            assert.equal(s.contextTokensSource, "estimate");
            assert(s.contextTokens >= 10500, JSON.stringify(s));
            assert.equal(s.contextTokens, session.stats.localInputEstimate);
            assert.equal(s.contextTokensAt, 1791049001000);
            assert.equal(session.metadata.contextTokensAt, undefined, "no usage timestamp without usage");
            assert.equal(s.inputTokens, 0);
            assert.equal(h.forwarded.length, 1);
        } finally { await h.close(); }
    });

    for (const scenario of ["no-usage", "upstream-failure", "model-switch"] as const) {
        test(`HTTP ${wire} ${scenario} replaces old usage with a growing outbound estimate`, async (t) => {
            const h = await harness(wire);
            try {
                let now = 1791049002000;
                t.mock.method(Date, "now", () => now);
                const history = ["first payload ".repeat(750)];
                h.setUsage(true);
                await h.send(history);
                const before = await h.status();
                assert.equal(before.contextTokensSource, "usage");
                assert.equal(before.contextTokens, 10000);
                const session = resolveConversation("outbound").session!;
                const usageAt = session.metadata.contextTokensAt;
                assert.equal(usageAt, now);
                h.setUsage(false);
                if (scenario === "upstream-failure") h.setFail();
                now = 1791049003000;
                // #2683: the failure arm adopts a billing-caliber reading (chars/4-class,
                // k̂-scaled) instead of the char-count bound — size the growth so that
                // reading still outgrows the 10000-token fixture bill and the
                // replace-stale-usage mechanic under test keeps firing.
                await h.send([...history, "prior response", "x".repeat(60_000)], scenario === "model-switch" ? "model-switched" : "model-test");
                const after = await h.status();
                assert.equal(after.contextTokensSource, "estimate");
                assert(after.contextTokens > 18000, JSON.stringify(after));
                assert.equal(after.contextTokens, session.stats.localInputEstimate);
                assert.equal(after.contextTokensAt, now);
                assert.notEqual(after.contextGeneration, before.contextGeneration);
                assert.equal(session.metadata.contextTokensAt, usageAt, "prepare cannot refresh the last real usage time");
                // #2683: a MODEL switch retires the cross-model usage reading — the bill was
                // measured under the previous model's tokenizer, so it loses decision
                // authority (baseline + anchor) until the next usage report. The raw sample
                // meter (cumulative inputTokens) and the last-usage timestamp are forensic
                // only, so they survive the switch. Same-model turns keep the reading: a
                // no-usage success keeps the last real bill, and a failed turn whose payload
                // outgrew it replaces it with the outbound reading.
                assert.equal(session.stats.lastUsageGradeTokens, scenario === "model-switch" ? undefined : 10000);
                assert.equal(session.stats.lastInputTokensSource, scenario === "upstream-failure" ? "estimate" : scenario === "model-switch" ? undefined : "usage");
                assert.equal(after.inputTokens, 10000);
                assert.equal(h.forwarded.length, 2);
                t.diagnostic(JSON.stringify({ wire, scenario, before: before.contextTokens, after: after.contextTokens, source: after.contextTokensSource, usageAt, estimateAt: after.contextTokensAt }));
            } finally { await h.close(); }
        });
    }
}