import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, createOpenaiAdapter, createAnthropicAdapter } from "../src/loop/index.ts";
import { promptInputTotal, usageTotals } from "../src/util.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, pipePluginJson, _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function makeCtx(id: string, messages: CoreMessage[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: makeSession(id),
        log: () => {},
    };
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(Buffer.from(events[i++], "utf8"));
            } else {
                controller.close();
            }
        },
    });
}

function makeRes(chunks: Buffer[]) {
    return {
        write: (b: Buffer | string) => {
            chunks.push(Buffer.from(b as string));
            return true;
        },
        end: (b?: Buffer | string) => {
            if (b !== undefined) chunks.push(Buffer.from(b as string));
        },
        once: () => {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

async function withTempStore(name: string, fn: (dir: string, store: SessionStore) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), `bili-host-usage-${name}-`));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    try {
        await fn(dir, store);
    } finally {
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
}

function jsonFilesUnder(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, entry.name);
            if (entry.isDirectory()) {
                walk(p);
            } else if (entry.name.endsWith(".json") && !entry.name.includes(".tmp-")) {
                out.push(p);
            }
        }
    };
    walk(dir);
    return out;
}

test("#660: responses loop — provider usage forwarded verbatim (internal ledger credits post-fold)", async () => {
    const ctx = makeCtx("loop-resp-ctrl", [textMsg("raw_1", "user", "hello")]);
    const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const body =
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }) +
        sse("response.completed", {
            type: "response.completed",
            response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 60000, output_tokens: 5 } },
        });
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(
        streamOf([body]),
        { ...ctx, protocol: "responses" },
        { model: "m", input: [] },
        { url: "https://upstream.test/v1/responses", headers: { authorization: "Bearer t" } },
        createResponsesAdapter(),
        "",
    )) {
        chunks.push(chunk);
    }
    const out = Buffer.concat(chunks).toString("utf8");
    assert.ok(out.includes('"input_tokens":60000'), out);
    assert.equal(ctx.session.stats.lastInputTokens, 60000);
});

test("#660: openai adapter — terminal usage chunk reaches the host untouched on real tool calls", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const stream = streamOf([
        chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] }),
        chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50000, completion_tokens: 10, total_tokens: 50010 } }),
        "data: [DONE]\n\n",
    ]);
    let meta = "";
    for await (const ev of adapter.parseStream(stream, 1)) {
        if (ev.kind === "meta") meta += ev.chunk.toString("utf8");
    }
    assert.ok(meta.includes('"prompt_tokens":50000'), `usage chunk must reach the host unmodified: ${meta}`);
    assert.ok(!meta.includes('"prompt_tokens":90'), meta);
});

test("#660: anthropic adapter — first-round message_start reaches the host untouched", async () => {
    const adapter = createAnthropicAdapter({ model: "m" });
    const stream = streamOf([
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 60000, output_tokens: 1 } } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ]);
    let meta = "";
    for await (const ev of adapter.parseStream(stream, 1)) {
        if (ev.kind === "meta") meta += ev.chunk.toString("utf8");
    }
    assert.ok(meta.includes('"input_tokens":60000'), `message_start usage must reach the host unmodified: ${meta}`);
});

before(_resetPluginStateForTest);

test("#660: pipePluginChatWithStrip forwards usage frames verbatim", async () => {
    await withTempStore("pipe-ctrl", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-ctrl");
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 60000, completion_tokens: 5, total_tokens: 60005 } })}\n\n`,
            "data: [DONE]\n\n",
        ]);
        await pipePluginChatWithStrip(stream, res, "openai", session);
        const out = chunks.join("");
        assert.ok(out.includes('"prompt_tokens":60000'), out);
        assert.ok(!out.includes('"prompt_tokens":100000'), out);
    });
});

test("#408: promptInputTotal — protocol matrix incl. openai split-semantics violation", () => {
    // anthropic: fresh-only input, cached separate → sum
    assert.equal(promptInputTotal("anthropic", 1000, 40000), 41000);
    // openai true semantics: prompt_tokens is the total, cached ⊆ prompt
    assert.equal(promptInputTotal("openai", 41000, 40000), 41000);
    assert.equal(promptInputTotal("openai", 41000, undefined), 41000);
    // openai split-semantics violation (prompt < cached → cached NOT included)
    assert.equal(promptInputTotal("openai", 6, 26278), 26284);
    assert.equal(promptInputTotal("responses", 6, 26278), 26284);
    assert.equal(promptInputTotal("responses", 41000, 40000), 41000);
    // undefined protocol behaves like anthropic (fresh-only)
    assert.equal(promptInputTotal(undefined, 1000, 40000), 41000);
    // missing input → 0
    assert.equal(promptInputTotal("openai", undefined, 26278), 0);
});

test("#408: usageTotals — openai split-semantics upstream adds the cached segment back", () => {
    const { total, cached } = usageTotals("openai", {
        prompt_tokens: 6,
        completion_tokens: 197,
        total_tokens: 203,
        prompt_tokens_details: { cached_tokens: 26278 },
    });
    assert.equal(total, 26284);
    assert.equal(cached, 26278);
    // true OpenAI semantics unchanged
    const ok = usageTotals("openai", { prompt_tokens: 30000, prompt_tokens_details: { cached_tokens: 29999 } });
    assert.equal(ok.total, 30000);
});

test("#408: pipePluginChatWithStrip — split-semantics openai usage keeps lastInputTokens at the real prompt size", async () => {
    await withTempStore("pipe-split", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-split");
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" } }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 6, completion_tokens: 197, total_tokens: 203, prompt_tokens_details: { cached_tokens: 26278 } } })}\n\n`,
            "data: [DONE]\n\n",
        ]);
        await pipePluginChatWithStrip(stream, res, "openai", session);
        assert.equal(session.stats.lastInputTokens, 26284);
        assert.equal(session.stats.cachedTokens, 26278);
    });
});

test("#660: pipePluginResponsesWithStrip — response.completed usage forwarded verbatim", async () => {
    await withTempStore("pipe-resp", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-resp");
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 60000, output_tokens: 5 } } })}\n\n`,
        ]);
        await pipePluginResponsesWithStrip(stream, res, session);
        const out = chunks.join("");
        assert.ok(out.includes('"input_tokens":60000'), out);
        assert.equal(session.stats.lastInputTokens, 60000);
    });
});

test("#660: pipePluginJson — openai JSON usage forwarded verbatim", async () => {
    await withTempStore("pipe-json", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-json");
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const body = JSON.stringify({
            id: "c1",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 60000, completion_tokens: 5, total_tokens: 60005 },
        });
        await pipePluginJson(streamOf([body]), res, session, "openai");
        const out = chunks.join("");
        const json = JSON.parse(out) as { usage: Record<string, unknown> };
        assert.equal(json.usage.prompt_tokens, 60000);
        assert.equal(json.usage.total_tokens, 60005);
        assert.equal(session.stats.lastInputTokens, 60000);
    });
});

test("#408: persist — negative lastInputTokens/contextTokens clamp to 0 on load and the stale file is migrated", async () => {
    await withTempStore("neg-stats", async (dir, store) => {
        const s = makeSession("neg1");
        s.stats.lastInputTokens = -54119;
        s.stats.contextTokens = -5;
        await store.writeNow(s);
        const store2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const loaded = await store2.loadAll();
        const got = loaded.get("neg1");
        assert.ok(got);
        assert.equal(got.stats.lastInputTokens, 0);
        assert.equal(got.stats.contextTokens, 0);
        const files = jsonFilesUnder(dir);
        assert.equal(files.length, 1);
        const env = JSON.parse(readFileSync(files[0], "utf8")) as { payload: { stats?: { lastInputTokens?: number; contextTokens?: number } } };
        assert.equal(env.payload.stats?.lastInputTokens, 0);
        assert.equal(env.payload.stats?.contextTokens, 0);
        store2.cancelAll();
    });
});

test("#408: persist — flat v1 negative lastInputTokens clamps to 0 on load", async () => {
    await withTempStore("neg-flat", async (dir, store) => {
        const s = makeSession("neg2");
        await store.writeNow(s);
        const files = jsonFilesUnder(dir);
        assert.equal(files.length, 1);
        const env = JSON.parse(readFileSync(files[0], "utf8")) as { payload: unknown };
        env.payload = { id: "neg2", state: createInitialState(), lastInputTokens: -54119 };
        writeFileSync(files[0], JSON.stringify(env));
        const store2 = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const loaded = await store2.loadAll();
        const got = loaded.get("neg2");
        assert.ok(got);
        assert.equal(got.stats.lastInputTokens, 0);
        store2.cancelAll();
    });
});

test("#408/#660: prepareOpenai — post-fold provider usage reaches the host verbatim", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstreamBodies: string[] = [];
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            upstreamBodies.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
            if (upstreamBodies.length === 5) {
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_c1", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00003", endId: "m00004", topic: "arm", summary: "summary of turns two and three: long-form filler dialogue about incremental context growth; key facts preserved for later reference" }] }) } }] }, finish_reason: null }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            } else {
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            // preserveRecentTokens defaults to 5000 — the whole small fixture
            // conversation would sit inside the token window and every range
            // would be protected. Disable it; the last-5-messages window stays.
            preserveRecentMessages: 5,
            preserveRecentTokens: 0,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    const big = "the quick brown fox jumps over the lazy dog. ".repeat(120);
    const history: Array<{ role: string; content: string }> = [];
    const post = async (): Promise<string> => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "host-usage-arm-1" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: history }),
            duplex: "half",
        } as RequestInit);
        if (!res.ok) {
            const text = await res.text();
            assert.fail(`HTTP ${res.status}: ${text}`);
        }
        let raw = "";
        for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
        return raw;
    };
    try {
        for (let i = 1; i <= 4; i++) {
            // u2 carries a sentinel: the fold must remove it from the forwarded view
            history.push({ role: "user", content: i === 2 ? `t2 SENTINEL_FOLD_GONE ${big}` : `t${i} ${big}` });
            const r = await post();
            assert.ok(r.includes('"prompt_tokens":100'), `turn ${i} must report the raw usage (no fold yet): ${r}`);
            history.push({ role: "assistant", content: "ok" });
        }
        // turn 5: the model folds m00003..m00004 (u2 + a2, outside the kernel's
        // protected zone of the last 5 messages). The range must NOT include
        // m00001 — the kernel never prunes the first user message, so folding
        // it would leave the big content in the forwarded view and the fold
        // assertion below would pass vacuously.
        history.push({ role: "user", content: "t5" });
        const r2 = await post();
        assert.ok(!r2.includes('"name":"compress"'), `compress tool call must be suppressed from the host: ${r2}`);
        assert.ok(!r2.includes("Compression FAILED"), `compress must succeed: ${r2}`);

        // turn 6: the forwarded view is folded; provider reports post-fold 100
        history.push({ role: "assistant", content: "ok" });
        history.push({ role: "user", content: "t6" });
        const r3 = await post();
        const m = r3.match(/"prompt_tokens":(\d+)/);
        assert.ok(m, `turn 6 usage chunk missing: ${r3}`);
        assert.equal(Number(m[1]), 100, `host-facing prompt_tokens must be the provider-measured post-fold value — no baseline backfill (#660): ${r3}`);
        assert.ok(upstreamBodies.length >= 7, `expected 7 upstream requests (turn5 has a compress round-trip), got ${upstreamBodies.length}`);
        assert.ok(!upstreamBodies[6]!.includes("SENTINEL_FOLD_GONE"), "turn-6 upstream body must not carry the folded u2 content — fold must have happened");
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => relay.close((e) => (e ? reject(e) : resolve())));
    }
});

test("#590: pi plugin mode reports folded usage verbatim", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const upstreamBodies: string[] = [];
    const anthropicSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            upstreamBodies.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_pi_1", role: "assistant", usage: { input_tokens: 100, output_tokens: 3 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "claude-test": { context: 400_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/messages`;
    // Sizing copied from plugin-protocol.test.ts: the compressed head
    // (m00001..m00002) exceeds minCompressibleChars while the protected-zone
    // walk exhausts itself on the tail — so the fold is real and non-vacuous.
    const headFiller = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
    const tailFiller = "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate. ".repeat(28);
    type AnthropicMessage = { role: string; content: string | Array<Record<string, unknown>> };
    const history: AnthropicMessage[] = [];
    for (let i = 1; i <= 2; i++) {
        history.push({ role: "user", content: `turn-${i}-marker question: ${headFiller}` });
        history.push({ role: "assistant", content: `turn-${i}-marker ${i === 1 ? "SENTINEL_FOLD_GONE " : ""}answer: ${headFiller}` });
    }
    for (let i = 3; i <= 5; i++) {
        history.push({ role: "user", content: `turn-${i} padding question: ${tailFiller}` });
        history.push({ role: "assistant", content: `turn-${i} padding answer: ${tailFiller}` });
    }
    const conv = "pi-folded-usage-1";
    const post = async (messages: AnthropicMessage[]): Promise<string> => {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": conv,
                "x-bili-plugin": "pi",
                "x-bili-plugin-conversation": conv,
            },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages }),
        });
        if (!res.ok) {
            const text = await res.text();
            assert.fail(`HTTP ${res.status}: ${text}`);
        }
        let raw = "";
        for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
        return raw;
    };
    const inputTokensOf = (raw: string): number => {
        const m = raw.match(/"input_tokens":(\d+)/);
        assert.ok(m, `message_start usage missing: ${raw.slice(0, 400)}`);
        return Number(m[1]);
    };
    try {
        const r1 = await post(history);
        assert.equal(inputTokensOf(r1), 100, "pre-fold turn must pass the raw usage through");

        const toolResp = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: { content: [{ topic: "pi-folded-usage", startId: "m00001", endId: "m00002", summary: "pi-side compress of the two early turns covering the lorem-ipsum questions and answers" }] },
            }),
        });
        assert.equal(toolResp.status, 200);
        const toolJson = (await toolResp.json()) as { ok: boolean; result: string };
        assert.equal(toolJson.ok, true, `compress tool reported failure: ${toolJson.result}`);

        const r2 = await post([
            ...history,
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_pi_1", name: "compress", input: { startId: "m00001", endId: "m00002", topic: "pi-folded-usage", summary: "pi-side compress of the two early turns covering the lorem-ipsum questions and answers" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_pi_1", content: toolJson.result }] },
        ]);
        // The fold must have happened upstream (sentinel gone) — otherwise
        // this would pass vacuously with no credit to suppress.
        assert.equal(upstreamBodies.length, 2);
        assert.ok(!upstreamBodies[1]!.includes("SENTINEL_FOLD_GONE"), "post-fold upstream body must not carry the folded head content");
        assert.equal(inputTokensOf(r2), 100, "pi plugin mode must report the folded request's own usage verbatim (#590)");
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => relay.close((e) => (e ? reject(e) : resolve())));
    }
});

test("#623: omp plugin mode reports folded usage verbatim", async () => {
    // Mirrors the #590 pi e2e, binding the session as omp; reusing the proven
    // pi fixture guarantees a real fold (not a vacuous pass).
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const upstreamBodies: string[] = [];
    const anthropicSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            upstreamBodies.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_omp_1", role: "assistant", usage: { input_tokens: 100, output_tokens: 3 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "claude-test": { context: 400_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/messages`;
    const headFiller = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
    const tailFiller = "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate. ".repeat(28);
    type AnthropicMessage = { role: string; content: string | Array<Record<string, unknown>> };
    const history: AnthropicMessage[] = [];
    for (let i = 1; i <= 2; i++) {
        history.push({ role: "user", content: `turn-${i}-marker question: ${headFiller}` });
        history.push({ role: "assistant", content: `turn-${i}-marker ${i === 1 ? "SENTINEL_FOLD_GONE " : ""}answer: ${headFiller}` });
    }
    for (let i = 3; i <= 5; i++) {
        history.push({ role: "user", content: `turn-${i} padding question: ${tailFiller}` });
        history.push({ role: "assistant", content: `turn-${i} padding answer: ${tailFiller}` });
    }
    const conv = "omp-folded-usage-1";
    const post = async (messages: AnthropicMessage[]): Promise<string> => {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": conv,
                "x-bili-plugin": "omp",
                "x-bili-plugin-conversation": conv,
            },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages }),
        });
        if (!res.ok) {
            const text = await res.text();
            assert.fail(`HTTP ${res.status}: ${text}`);
        }
        let raw = "";
        for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
        return raw;
    };
    const inputTokensOf = (raw: string): number => {
        const m = raw.match(/"input_tokens":(\d+)/);
        assert.ok(m, `message_start usage missing: ${raw.slice(0, 400)}`);
        return Number(m[1]);
    };
    try {
        const r1 = await post(history);
        assert.equal(inputTokensOf(r1), 100, "pre-fold turn must pass the raw usage through");

        const toolResp = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: { content: [{ topic: "omp-folded-usage", startId: "m00001", endId: "m00002", summary: "omp-side compress of the two early turns covering the lorem-ipsum questions and answers" }] },
            }),
        });
        assert.equal(toolResp.status, 200);
        const toolJson = (await toolResp.json()) as { ok: boolean; result: string };
        assert.equal(toolJson.ok, true, `compress tool reported failure: ${toolJson.result}`);

        const r2 = await post([
            ...history,
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_omp_1", name: "compress", input: { startId: "m00001", endId: "m00002", topic: "omp-folded-usage", summary: "omp-side compress of the two early turns covering the lorem-ipsum questions and answers" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_omp_1", content: toolJson.result }] },
        ]);
        assert.equal(upstreamBodies.length, 2);
        assert.ok(!upstreamBodies[1]!.includes("SENTINEL_FOLD_GONE"), "post-fold upstream body must not carry the folded head content");
        assert.equal(inputTokensOf(r2), 100, "omp plugin mode must report the folded request's own usage verbatim (#623)");
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => relay.close((e) => (e ? reject(e) : resolve())));
    }
});

// #648/#660: ZCode — a plain proxy client on the anthropic wire (no
// x-bili-plugin header, no special UA). Every host sees the folded request's
// own provider-measured usage (#660). The fold is real (the relay emits a
// compress tool_use), not a vacuous pass.

const ZCODE_CONV_648 = "zcode-usage-648";

function zcodeSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function zcodeCompressToolUse(): string {
    const args = JSON.stringify({
        content: [{ startId: "m00001", endId: "m00002", topic: "setup", summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
    });
    return [
        zcodeSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_zcode_1", name: "compress", input: {} } }),
        zcodeSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
        zcodeSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    ].join("");
}

function zcodeNormalCompletion(inputTokens: number): string {
    return [
        zcodeSse("message_start", { type: "message_start", message: { id: "msg_zcode", role: "assistant", usage: { input_tokens: inputTokens, output_tokens: 3 } } }),
        zcodeSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        zcodeSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        zcodeSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        zcodeSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        zcodeSse("message_stop", { type: "message_stop" }),
    ].join("");
}

// 10 messages with filler; the sentinel sits in m00002 (the assistant message
// of the compressed head) so the fold is real and the post-fold upstream body
// provably drops the head content.
function zcodeConversation(): Array<{ role: string; content: string }> {
    const headFiller = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
    const tailFiller = "enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate. ".repeat(28);
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 1; i <= 2; i++) {
        history.push({ role: "user", content: `turn-${i}-marker question: ${headFiller}` });
        history.push({ role: "assistant", content: `turn-${i}-marker ${i === 1 ? "SENTINEL_FOLD_GONE " : ""}answer: ${headFiller}` });
    }
    for (let i = 3; i <= 5; i++) {
        history.push({ role: "user", content: `turn-${i} padding question: ${tailFiller}` });
        history.push({ role: "assistant", content: `turn-${i} padding answer: ${tailFiller}` });
    }
    return history;
}

async function withZCodeHarness(fn: (h: { proxy: http.Server; upstream: http.Server; bodies: string[]; url: string }) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                res.write(zcodeSse("message_start", { type: "message_start", message: { id: "msg_zcode_1", role: "assistant", usage: { input_tokens: 1000, output_tokens: 3 } } }));
                res.write(zcodeCompressToolUse());
                res.write(zcodeSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }));
                res.write(zcodeSse("message_stop", { type: "message_stop" }));
            } else {
                res.write(zcodeNormalCompletion(1000));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const h = { proxy, upstream, bodies, url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages` };
    try {
        await fn(h);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

function zcodeInputTokensOf(raw: string): number {
    const m = raw.match(/"input_tokens":(\d+)/);
    assert.ok(m, `message_start usage missing: ${raw.slice(0, 400)}`);
    return Number(m[1]);
}

async function setupZCodeCompressedSession(h: { bodies: string[]; url: string }): Promise<number> {
    const r1 = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": ZCODE_CONV_648 },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: zcodeConversation() }),
    });
    assert.equal(r1.status, 200);
    await r1.text();
    const s = listSessions().find((x) => x.meta.label === ZCODE_CONV_648);
    assert.ok(s, "session exists");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "setup created an active block (real fold)");
    assert.ok(h.bodies[0]!.includes("SENTINEL_FOLD_GONE"), "setup forwarded the unfolded head (sentinel present)");
    return h.bodies.length;
}

test("#648/#660: ZCode (anthropic wire, plain proxy client) reports folded usage verbatim", async () => {
    await withZCodeHarness(async (h) => {
        const afterSetup = await setupZCodeCompressedSession(h);
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": ZCODE_CONV_648 },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: zcodeConversation() }),
        });
        assert.equal(r2.status, 200);
        const raw = await r2.text();
        assert.equal(h.bodies.length, afterSetup + 1, "post-fold turn forwarded to upstream exactly once");
        assert.ok(!h.bodies[h.bodies.length - 1]!.includes("SENTINEL_FOLD_GONE"), "post-fold upstream body must not carry the folded head content");
        assert.equal(zcodeInputTokensOf(raw), 1000, "host usage must be the folded request's own provider-measured value — no baseline backfill (#648/#660)");
    });
});

// #645/#660: codex — a plain proxy client on the responses wire identified by
// UA. Every host sees the folded request's own provider-measured usage
// (#660). Harness mirrors codex-compact-e2e.test.ts (real fold, not a vacuous pass).

const CODEX_UA_645 = "codex_cli_rs/0.1.0 (linux x86_64)";
const CODEX_CONV_645 = "codex-usage-645";

function sseFrame(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completedFrame(inputTokens: number): string {
    return sseFrame("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

function compressFcEvents(callId: string): string {
    const args = JSON.stringify({
        content: [{ startId: "m00001", endId: "m00002", topic: "setup", summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
    });
    return [
        sseFrame("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sseFrame("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sseFrame("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}

// 7 messages × ~3800 chars (~6.7k tokens). Below the 10k window so preflight
// never fires. The sentinel sits in m00002 — the assistant message of the
// compressed head — because the kernel keeps the block's user anchor (m00001)
// resident and folds the assistant (same placement as the #590 pi test).
function codexConversation(): Array<{ type: string; role: string; content: string }> {
    const input: Array<{ type: string; role: string; content: string }> = [];
    for (let i = 0; i < 7; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ${i === 1 ? "SENTINEL_FOLD_GONE " : ""}` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

function completedUsageOf(raw: string): { input_tokens: number; total_tokens: number } {
    const m = raw.match(/event: response\.completed\ndata: (\{[\s\S]*?\})\n\n/);
    assert.ok(m, `response.completed frame missing: ${raw.slice(0, 400)}`);
    const frame = JSON.parse(m[1]!) as { response: { usage: { input_tokens: number; total_tokens: number } } };
    return frame.response.usage;
}

async function withCodexHarness(fn: (h: { proxy: http.Server; upstream: http.Server; bodies: string[]; url: string }) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                res.write(compressFcEvents("call_645"));
            }
            res.write(completedFrame(1000));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const h = { proxy, upstream, bodies, url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses` };
    try {
        await fn(h);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

// Returns the upstream-request count after setup (the compress execution
// triggers a re-ask, so setup is more than one upstream call — same shape as
// codex-compact-e2e's setupCompressedSession).
async function setupCodexCompressedSession(h: { bodies: string[]; url: string }, ua?: string): Promise<number> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ua) headers["user-agent"] = ua;
    const r1 = await fetch(h.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: CODEX_CONV_645, instructions: "You are the test coding agent.", input: codexConversation() }),
    });
    assert.equal(r1.status, 200);
    const raw = await r1.text();
    assert.equal(completedUsageOf(raw).input_tokens, 1000, "pre-fold turn must pass the raw usage through");
    const s = listSessions().find((x) => x.meta.label === CODEX_CONV_645);
    assert.ok(s, "session exists");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "setup created an active block");
    assert.ok(h.bodies[0]!.includes("SENTINEL_FOLD_GONE"), "setup forwarded the unfolded head (sentinel present)");
    return h.bodies.length;
}

test("#645/#660: codex UA client (responses wire) reports folded usage verbatim", async () => {
    await withCodexHarness(async (h) => {
        const afterSetup = await setupCodexCompressedSession(h, CODEX_UA_645);
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA_645 },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: CODEX_CONV_645, instructions: "You are the test coding agent.", input: codexConversation() }),
        });
        assert.equal(r2.status, 200);
        const raw = await r2.text();
        assert.equal(h.bodies.length, afterSetup + 1, "post-fold turn forwarded to upstream exactly once");
        assert.ok(!h.bodies[h.bodies.length - 1]!.includes("SENTINEL_FOLD_GONE"), "post-fold upstream body must not carry the folded head content");
        assert.equal(completedUsageOf(raw).input_tokens, 1000, "codex (UA) must report the folded request's own provider-measured usage — no baseline backfill (#645/#660)");
    });
});
