import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, createOpenaiAdapter, createAnthropicAdapter } from "../src/loop/index.ts";
import { backfillHostUsage } from "../src/util.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, pipePluginJson, _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function makeSession(id: string, hostCreditTokens?: number): Session {
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
        ...(hostCreditTokens !== undefined ? { hostCreditTokens } : {}),
    };
}

function makeCtx(id: string, messages: CoreMessage[], hostCreditTokens?: number): {
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
        session: makeSession(id, hostCreditTokens),
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

test("backfillHostUsage: openai patches prompt_tokens + total_tokens", () => {
    const u: Record<string, unknown> = { prompt_tokens: 60000, completion_tokens: 5, total_tokens: 60005 };
    assert.equal(backfillHostUsage("openai", u, 40000), true);
    assert.equal(u.prompt_tokens, 100000);
    assert.equal(u.total_tokens, 100005);
    assert.equal(u.completion_tokens, 5);
});

test("backfillHostUsage: openai prompt_tokens only (no total_tokens invented)", () => {
    const u: Record<string, unknown> = { prompt_tokens: 60000 };
    assert.equal(backfillHostUsage("openai", u, 40000), true);
    assert.equal(u.prompt_tokens, 100000);
    assert.equal("total_tokens" in u, false);
});

test("backfillHostUsage: anthropic + responses patch input_tokens", () => {
    const a: Record<string, unknown> = { input_tokens: 60000, output_tokens: 5 };
    assert.equal(backfillHostUsage("anthropic", a, 40000), true);
    assert.equal(a.input_tokens, 100000);
    assert.equal(a.output_tokens, 5);
    const r: Record<string, unknown> = { input_tokens: 60000 };
    assert.equal(backfillHostUsage("responses", r, 40000), true);
    assert.equal(r.input_tokens, 100000);
});

test("backfillHostUsage: credit <= 0 or missing input field is a no-op", () => {
    const u: Record<string, unknown> = { prompt_tokens: 60000 };
    assert.equal(backfillHostUsage("openai", u, 0), false);
    assert.equal(u.prompt_tokens, 60000);
    const v: Record<string, unknown> = { completion_tokens: 5 };
    assert.equal(backfillHostUsage("openai", v, 40000), false);
    assert.equal(v.completion_tokens, 5);
});

test("#408: responses loop — host completion carries uncompressed baseline, internal ledger stays post-fold", async () => {
    const ctx = makeCtx("loop-resp", [textMsg("raw_1", "user", "hello")], 40000);
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
    assert.ok(out.includes('"input_tokens":100000'), `expected backfilled input_tokens in completed event, got: ${out}`);
    assert.ok(!out.includes('"input_tokens":60000'), "raw folded input_tokens must not reach the host");
    assert.equal(ctx.session.hostContextTokens, 100000);
    assert.equal(ctx.session.stats.lastInputTokens, 60000);
    assert.equal(ctx.session.stats.inputTokens, 60000);
});

test("#408: responses loop — no credit leaves usage untouched (control)", async () => {
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
    assert.equal(ctx.session.hostContextTokens, 60000);
    assert.equal(ctx.session.stats.lastInputTokens, 60000);
});

test("#408: openai adapter — raw finish chunk with usage carries the backfill on real tool calls", async () => {
    const adapter = createOpenaiAdapter({ model: "m" }, undefined, 40000);
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
    assert.ok(meta.includes('"prompt_tokens":90000'), `expected backfilled prompt_tokens in raw finish chunk: ${meta}`);
    assert.ok(meta.includes('"total_tokens":90010'), meta);
});

test("#408: anthropic adapter — first-round message_start meta carries backfilled input_tokens", async () => {
    const adapter = createAnthropicAdapter({ model: "m" }, undefined, 40000);
    const stream = streamOf([
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 60000, output_tokens: 1 } } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ]);
    let meta = "";
    for await (const ev of adapter.parseStream(stream, 1)) {
        if (ev.kind === "meta") meta += ev.chunk.toString("utf8");
    }
    assert.ok(meta.includes('"input_tokens":100000'), `expected backfilled input_tokens in message_start: ${meta}`);
});

before(_resetPluginStateForTest);

test("#408: pipePluginChatWithStrip — openai final usage chunk backfilled, ledger post-fold", async () => {
    await withTempStore("pipe-openai", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-oai", 40000);
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" } }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 60000, completion_tokens: 5, total_tokens: 60005 } })}\n\n`,
            "data: [DONE]\n\n",
        ]);
        await pipePluginChatWithStrip(stream, res, "openai", session);
        const out = chunks.join("");
        assert.ok(out.includes('"prompt_tokens":100000'), out);
        assert.ok(out.includes('"total_tokens":100005'), out);
        assert.equal(session.stats.lastInputTokens, 60000);
        assert.equal(session.hostContextTokens, 100000);
    });
});

test("#408: pipePluginChatWithStrip — anthropic message_start backfilled, zero message_delta untouched", async () => {
    await withTempStore("pipe-anthropic", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-ant", 40000);
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 60000, cache_read_input_tokens: 1000 } } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, output_tokens: 10 } })}\n\n`,
        ]);
        await pipePluginChatWithStrip(stream, res, "anthropic", session);
        const out = chunks.join("");
        assert.ok(out.includes('"input_tokens":100000'), out);
        assert.ok(out.includes('"input_tokens":0'), "zero message_delta input_tokens must stay 0");
        assert.equal(session.stats.lastInputTokens, 61000);
        assert.equal(session.hostContextTokens, 101000);
    });
});

test("#408: pipePluginChatWithStrip — no credit leaves bytes verbatim (control)", async () => {
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
        assert.equal(session.hostContextTokens, 60000);
    });
});

test("#408: pipePluginResponsesWithStrip — response.completed usage backfilled", async () => {
    await withTempStore("pipe-resp", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-resp", 40000);
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 60000, output_tokens: 5 } } })}\n\n`,
        ]);
        await pipePluginResponsesWithStrip(stream, res, session);
        const out = chunks.join("");
        assert.ok(out.includes('"input_tokens":100000'), out);
        assert.equal(session.stats.lastInputTokens, 60000);
        assert.equal(session.hostContextTokens, 100000);
    });
});

test("#408: pipePluginJson — openai JSON usage backfilled", async () => {
    await withTempStore("pipe-json", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-json", 40000);
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
        assert.equal(json.usage.prompt_tokens, 100000);
        assert.equal(json.usage.total_tokens, 100005);
        assert.equal(session.stats.lastInputTokens, 60000);
        assert.equal(session.hostContextTokens, 100000);
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

test("#408: prepareOpenai arms the credit — host sees backfilled usage after a compress fold", async () => {
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
        // it would leave the big content in the forwarded view and the credit
        // (est(original) − est(processed)) would stay ~0.
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
        const prompt = Number(m[1]);
        assert.ok(prompt > 100, `host-facing prompt_tokens must be backfilled above the post-fold 100 (got ${prompt})`);
        assert.ok(prompt >= 100 + 200, `backfill must carry a meaningful share of the folded ~1400-token range (got ${prompt})`);
        assert.ok(upstreamBodies.length >= 7, `expected 7 upstream requests (turn5 has a compress round-trip), got ${upstreamBodies.length}`);
        assert.ok(!upstreamBodies[6]!.includes("SENTINEL_FOLD_GONE"), "turn-6 upstream body must not carry the folded u2 content — fold must have happened");
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => relay.close((e) => (e ? reject(e) : resolve())));
    }
});
