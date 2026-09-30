// #955 runtime-info protocol: plugins report the client's OWN model config
// (model id / contextWindow / maxOutput) to the proxy — via per-request
// headers and a bootstrap POST — and the proxy prefers that truth over
// registry/table guessing in the native-window chain.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import {
    _resetPluginStateForTest,
    handlePluginRuntimeInfo,
    pluginHeadersMatchModel,
    pluginReportedMaxOutput,
    pluginReportedModel,
    pluginRuntimeInfoFor,
    pluginRuntimeInfoForConversation,
    recordPluginRuntimeInfo,
    runtimeConversationId,
} from "../src/plugin.ts";
import { extractV1Outputs } from "../src/agent/opencode-native.ts";
import { reportRuntimeInfoOnChange } from "../src/agent/shared.ts";
import { rmrf } from "./tmp-rm.ts";

function mockRes(): { res: http.ServerResponse; body(): string } {
    let body = "";
    const res = {
        writeHead: () => undefined,
        end: (chunk: unknown) => {
            body = String(chunk);
        },
    } as unknown as http.ServerResponse;
    return { res, body: () => body };
}

describe("runtime-info header parsing (#955)", () => {
    it("max-output is honored only from a plugin request", () => {
        const headers = { "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "32768" };
        assert.equal(pluginReportedMaxOutput(headers), 32768);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin-max-output": "32768" }), undefined);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "nope" }), undefined);
        assert.equal(pluginReportedMaxOutput({ "x-bili-plugin": "dsh", "x-bili-plugin-max-output": "0" }), undefined);
    });

    it("model id is honored only from a plugin request and must be a bare token", () => {
        assert.equal(pluginReportedModel({ "x-bili-plugin": "pi", "x-bili-plugin-model": "qwen3.5-33b" }), "qwen3.5-33b");
        assert.equal(pluginReportedModel({ "x-bili-plugin-model": "qwen" }), undefined);
        assert.equal(pluginReportedModel({ "x-bili-plugin": "pi", "x-bili-plugin-model": "a b" }), undefined);
    });

    it("header/model cross-check: a different body model rejects the plugin headers (#956 hardening)", () => {
        const h = { "x-bili-plugin": "pi", "x-bili-plugin-model": "qwen-a" };
        assert.equal(pluginHeadersMatchModel(h, "qwen-a"), true);
        assert.equal(pluginHeadersMatchModel(h, "qwen-b"), false);
        // provider/model composite bodies match the bare stamped id
        assert.equal(pluginHeadersMatchModel(h, "sglang/qwen-a"), true);
        assert.equal(pluginHeadersMatchModel(h, "sglang/qwen-b"), false);
        // no model header = pre-#956 trust preserved
        assert.equal(pluginHeadersMatchModel({ "x-bili-plugin": "pi" }, "qwen-b"), true);
        assert.equal(pluginHeadersMatchModel(h, undefined), true);
    });
});

describe("runtime-info endpoint handler (#955)", () => {
    beforeEach(() => _resetPluginStateForTest());
    afterEach(() => _resetPluginStateForTest());

    it("stores a valid report and rejects incomplete ones", () => {
        const ok = mockRes();
        handlePluginRuntimeInfo(JSON.stringify({ agent: "dsh", model: "m1", contextWindow: 262144, maxOutput: 8192, baseURL: "http://x", source: "client-config" }), ok.res);
        assert.ok(JSON.parse(ok.body()).ok);
        const entry = pluginRuntimeInfoFor("dsh", "m1");
        assert.equal(entry?.contextWindow, 262144);
        assert.equal(entry?.maxOutput, 8192);

        const bad = mockRes();
        handlePluginRuntimeInfo(JSON.stringify({ agent: "dsh" }), bad.res);
        assert.equal(JSON.parse(bad.body()).ok, false);

        const badJson = mockRes();
        handlePluginRuntimeInfo("not json", badJson.res);
        assert.equal(JSON.parse(badJson.body()).ok, false);
    });

    it("model-mismatched lookups return nothing (stale post-switch entry must not size a different model)", () => {
        recordPluginRuntimeInfo({ agent: "dsh", model: "old-model", contextWindow: 1000, source: "client-config", ts: Date.now() });
        assert.equal(pluginRuntimeInfoFor("dsh", "other-model"), undefined);
        assert.equal(pluginRuntimeInfoFor(undefined, "old-model"), undefined);
    });

    it("evicts oldest entries beyond the cap", () => {
        for (let i = 0; i < 40; i++) {
            recordPluginRuntimeInfo({ agent: `a${i}`, model: "m", source: "t", ts: Date.now() });
        }
        assert.equal(pluginRuntimeInfoFor("a0", "m"), undefined);
        assert.notEqual(pluginRuntimeInfoFor("a39", "m"), undefined);
    });

    it("#1531: a conversation-scoped report is invisible to the per-agent lookup", () => {
        recordPluginRuntimeInfo({ agent: "omp", model: "astra", contextWindow: 262144, maxOutput: 32768, conversationId: "sid-a", source: "client-config", ts: 1 });
        assert.equal(pluginRuntimeInfoFor("omp", "astra"), undefined, "agent slot must stay empty");
        const hit = pluginRuntimeInfoForConversation("sid-a", "astra");
        assert.equal(hit?.contextWindow, 262144);
        assert.equal(hit?.maxOutput, 32768);
    });

    it("#1531: conversation-scoped lookup is model-gated like the per-agent one", () => {
        recordPluginRuntimeInfo({ agent: "omp", model: "astra", contextWindow: 262144, conversationId: "sid-a", source: "client-config", ts: 1 });
        assert.equal(pluginRuntimeInfoForConversation("sid-a", "gemini"), undefined);
        assert.equal(pluginRuntimeInfoForConversation(undefined, "astra"), undefined);
    });

    it("#1531: sibling sessions do not clobber each other's conversation entries", () => {
        recordPluginRuntimeInfo({ agent: "omp", model: "astra", contextWindow: 262144, maxOutput: 32768, conversationId: "sid-a", source: "client-config", ts: 1 });
        recordPluginRuntimeInfo({ agent: "omp", model: "gemini", contextWindow: 1048576, maxOutput: 65536, conversationId: "sid-b", source: "client-config", ts: 2 });
        assert.equal(pluginRuntimeInfoForConversation("sid-a", "astra")?.contextWindow, 262144, "A survives B's report");
        assert.equal(pluginRuntimeInfoForConversation("sid-b", "gemini")?.contextWindow, 1048576);
    });

    it("#1531: conversation-scoped table evicts its own oldest past the cap", () => {
        for (let i = 0; i < 40; i++) {
            recordPluginRuntimeInfo({ agent: "omp", model: `m-${i}`, conversationId: `sid-${i}`, source: "t", ts: i });
        }
        assert.equal(pluginRuntimeInfoForConversation("sid-0", "m-0"), undefined);
        assert.notEqual(pluginRuntimeInfoForConversation("sid-39", "m-39"), undefined);
    });

    it("#1531: the endpoint stores body.conversationId when present", () => {
        const ok = mockRes();
        handlePluginRuntimeInfo(JSON.stringify({ agent: "omp", model: "astra", contextWindow: 262144, conversationId: "sid-x" }), ok.res);
        assert.ok(JSON.parse(ok.body()).ok);
        assert.equal(pluginRuntimeInfoForConversation("sid-x", "astra")?.contextWindow, 262144);
        assert.equal(pluginRuntimeInfoFor("omp", "astra"), undefined);
    });

    it("#1531: runtimeConversationId precedence — conversation header > custom session header > body prompt_cache_key > miss", () => {
        assert.equal(runtimeConversationId({ "x-session-id": "h-conv" }, { prompt_cache_key: "pck" }), "h-conv");
        assert.equal(runtimeConversationId({}, { prompt_cache_key: "pck" }), "pck");
        assert.equal(runtimeConversationId({}, { prompt_cache_key: 5 }), undefined);
        assert.equal(runtimeConversationId({}, {}), undefined);
        assert.equal(runtimeConversationId({}, null), undefined);
        assert.equal(runtimeConversationId({ "x-my-sess": "custom" }, {}, "x-my-sess"), "custom");
        // x-bili-plugin-conversation alone (no marker) is not honored — same rule as binding
        assert.equal(runtimeConversationId({ "x-bili-plugin-conversation": "c" }, {}), undefined);
    });
});

describe("extractV1Outputs (#955)", () => {
    it("reads limit.output from provider models", () => {
        const map = extractV1Outputs({ provider: { p1: { models: { m1: { limit: { context: 1000, output: 512 } }, m2: { limit: { context: 1000 } } } } } } as never);
        assert.equal(map.get("p1/m1"), 512);
        assert.equal(map.has("p1/m2"), false);
    });
});

describe("reportRuntimeInfoOnChange (#955)", () => {
    const originalFetch = globalThis.fetch;
    const posts: { url: string; body: unknown }[] = [];

    beforeEach(() => {
        posts.length = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            posts.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("posts once per model switch, and retries after a failure", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1", contextWindow: 1000 });
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1", contextWindow: 1000 });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.url, "http://proxy/__bili/plugin/runtime-info");

        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m2" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
        assert.equal((posts[1]?.body as { model: string }).model, "m2");

        reportRuntimeInfoOnChange(undefined, { agent: "pi", model: "m3" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
    });

    it("rolls back the dedupe key on failure so the next stamp retries", async () => {
        globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1" });
        await new Promise((r) => setTimeout(r, 10));
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            posts.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;
        reportRuntimeInfoOnChange("http://proxy", { agent: "pi", model: "m1" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);
    });

    it("#1531: re-reports when a reported field changes under the same (agent, conversation)", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", contextWindow: 1048576, conversationId: "sid-a" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);

        // same model id, window changed → fingerprint differs → re-POST
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", contextWindow: 258400, conversationId: "sid-a" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
        assert.equal((posts[1]?.body as { contextWindow?: number }).contextWindow, 258400);
    });

    it("#1531: sibling conversations with identical configs each report once", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", contextWindow: 258400, conversationId: "sid-c1" });
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", contextWindow: 258400, conversationId: "sid-c2" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
        const convs = posts.map((p) => (p.body as { conversationId?: string }).conversationId).sort();
        assert.deepEqual(convs, ["sid-c1", "sid-c2"]);

        // interleaving back to the first conversation with unchanged fields stays quiet
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", contextWindow: 258400, conversationId: "sid-c1" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
    });

    it("#1531: a proxy-origin change re-reports (origin is part of the fingerprint)", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "omp", model: "astra", conversationId: "sid-o" });
        await new Promise((r) => setTimeout(r, 10));
        reportRuntimeInfoOnChange("http://proxy2", { agent: "omp", model: "astra", conversationId: "sid-o" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 2);
        assert.equal(posts[1]?.url, "http://proxy2/__bili/plugin/runtime-info");
    });

    it("#1531: legacy agent-scoped reports (no conversationId) still dedupe per agent", async () => {
        reportRuntimeInfoOnChange("http://proxy", { agent: "dsh", model: "m1" });
        reportRuntimeInfoOnChange("http://proxy", { agent: "dsh", model: "m1" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(posts.length, 1);
    });
});

// ---- E2E: the window chain prefers a matching runtime-info report ----

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    // isolate the state dir: prefix-affinity hydration reattaches anonymous
    // sessions from disk, which would defeat the "no session yet" preconditions
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ri-state-"));
    const prevStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: {} } },
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");

    return {
        proxyPort: proxy.address().port,
        upstreamPort,
        close: async () => {
            proxy.close();
            upstream.close();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
            if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevStateHome;
            rmrf(stateHome);
        },
    };
}

describe("runtime-info in the native-window chain (#955, e2e)", () => {
    let h: Harness | undefined;
    beforeEach(async () => {
        h = await startHarness();
    });
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    it("a matching bootstrap report sizes the window when no header carries one", async () => {
        const report = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 262144, maxOutput: 32768, source: "client-config" }),
        });
        assert.equal(report.status, 200);

        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-1" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);

        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-1`)).json() as { model: string | null; windowSource: string | null; runtimeInfo: { contextWindow?: number } | null };
        assert.equal(status.model, "test-model");
        assert.equal(status.windowSource, "runtime-info");
        assert.equal(status.runtimeInfo?.contextWindow, 262144);
    });

    it("a per-request window header still outranks the runtime table", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 111111, source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-2", "x-bili-plugin-context-window": "222222" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-2`)).json() as { windowSource: string | null };
        assert.equal(status.windowSource, "plugin");
    });

    it("a report for a DIFFERENT model never sizes this request", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "other-model", contextWindow: 111111, source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-ri-3" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=conv-ri-3`)).json() as { windowSource: string | null };
        assert.notEqual(status.windowSource, "runtime-info");
    });

    // #1531: header-less agents (omp native) resolve their conversation-scoped
    // report through the prompt_cache_key identity — no x-bili-plugin header is
    // ever sent on model requests by this lane.
    it("#1531: a header-less request adopts its own conversation-scoped report via prompt_cache_key", async () => {
        const register = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "sid-omp-1", agent: "omp", identity: true }),
        });
        assert.equal(register.status, 200);
        const report = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "omp", model: "test-model", contextWindow: 262144, maxOutput: 32768, conversationId: "sid-omp-1", source: "client-config" }),
        });
        assert.equal(report.status, 200);

        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "test-model", stream: false, prompt_cache_key: "sid-omp-1", messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);

        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=sid-omp-1`)).json() as { pluginAgent: string | null; model: string | null; windowSource: string | null; contextLimit: number | null; runtimeInfo: { contextWindow?: number } | null };
        assert.equal(status.pluginAgent, "omp");
        assert.equal(status.model, "test-model");
        assert.equal(status.windowSource, "runtime-info");
        // 262144 − min(32768, headroom cap × 262144) = 262144 − 32768
        assert.equal(status.contextLimit, 229376);
        assert.equal(status.runtimeInfo?.contextWindow, 262144);
    });

    it("#1531: sibling sessions no longer clobber each other's windows", async () => {
        const postReport = (model: string, window: number, maxOut: number, sid: string) =>
            fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ agent: "omp", model, contextWindow: window, maxOutput: maxOut, conversationId: sid, source: "client-config" }),
            });
        const ask = async (model: string, sid: string): Promise<{ windowSource: string | null; contextLimit: number | null }> => {
            const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model, stream: false, prompt_cache_key: sid, messages: [{ role: "user", content: "hello" }] }),
            });
            assert.equal(resp.status, 200);
            return (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=${sid}`)).json() as { windowSource: string | null; contextLimit: number | null };
        };

        await postReport("astra", 262144, 32768, "sid-a");
        const a1 = await ask("astra", "sid-a");
        assert.equal(a1.windowSource, "runtime-info");
        assert.equal(a1.contextLimit, 229376);

        await postReport("gemini", 1048576, 65536, "sid-b");
        const b1 = await ask("gemini", "sid-b");
        assert.equal(b1.windowSource, "runtime-info");
        assert.equal(b1.contextLimit, 983040);

        // old code: B's report clobbered the single omp slot → A regressed to
        // registry-peek here. Conversation-scoped storage keeps A intact.
        const a2 = await ask("astra", "sid-a");
        assert.equal(a2.windowSource, "runtime-info");
        assert.equal(a2.contextLimit, 229376);
    });

    it("#1531: a per-agent header still wins exclusively over a conversation entry", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "omp", model: "test-model", contextWindow: 100000, maxOutput: 10000, source: "client-config" }),
        });
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "omp", model: "test-model", contextWindow: 262144, maxOutput: 32768, conversationId: "sid-h", source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "omp", "x-bili-plugin-conversation": "sid-h" },
            body: JSON.stringify({ model: "test-model", stream: false, prompt_cache_key: "sid-h", messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=sid-h`)).json() as { windowSource: string | null; contextLimit: number | null };
        assert.equal(status.windowSource, "runtime-info");
        // 100000 − min(10000, cap × 100000) = 90000 — the AGENT-SLOT entry, not the conv entry's 229376
        assert.equal(status.contextLimit, 90000);
    });

    it("#1531: no conversation signal + no header still misses (plain clients unchanged)", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "omp", model: "test-model", contextWindow: 262144, maxOutput: 32768, conversationId: "sid-orphan", source: "client-config" }),
        });
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(resp.status, 200);
        const status = await (await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=sid-orphan`)).json().catch(() => null) as { windowSource: string | null } | null;
        if (status !== null) assert.notEqual(status.windowSource, "runtime-info");
    });
});

// ---- E2E: pre-first-request /acp served from the runtime table ----

describe("runtime-info pre-first-request status (#955)", () => {
    let h: Harness | undefined;
    beforeEach(async () => {
        h = await startHarness();
    });
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    it("answers from the agent-keyed table before any session exists", async () => {
        const report = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 262144, maxOutput: 32768, source: "client-config" }),
        });
        assert.equal(report.status, 200);

        // clients without a stable conversation id probe with their agent name
        // (fetchStatusLatest hardcodes conversationId=dsh&fallback=latest)
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=dsh&fallback=latest`);
        assert.equal(resp.status, 200);
        const json = (await resp.json()) as { ok: boolean; phase?: string; model: string | null; contextLimit: number | null; runtimeInfo: { maxOutput?: number } | null; panel: unknown };
        assert.equal(json.ok, true);
        assert.equal(json.phase, "pre-first-request");
        assert.equal(json.model, "test-model");
        assert.equal(json.contextLimit, 262144);
        assert.equal(json.runtimeInfo?.maxOutput, 32768);
        assert.equal(json.panel, null);
    });

    it("still 404s when nothing was reported", async () => {
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=dsh&fallback=latest`);
        assert.equal(resp.status, 404);
        const json = (await resp.json()) as { error: string };
        assert.match(json.error, /no session with activity since boot/);
    });

    it("yields to the real session once a model request lands", async () => {
        await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh", model: "test-model", contextWindow: 262144, source: "client-config" }),
        });
        const req = await fetch(`http://127.0.0.1:${h!.proxyPort}/bili/http://127.0.0.1:${h!.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-pre-1" },
            body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(req.status, 200);
        const resp = await fetch(`http://127.0.0.1:${h!.proxyPort}/__bili/plugin/status?conversationId=dsh&fallback=latest`);
        assert.equal(resp.status, 200);
        const json = (await resp.json()) as { phase?: string; conversationId: string };
        assert.equal(json.phase, undefined);
        assert.equal(json.conversationId, "conv-pre-1");
    });
});
