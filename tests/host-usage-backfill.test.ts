import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter, createOpenaiAdapter, createAnthropicAdapter } from "../src/loop/index.ts";
import { backfillHostUsage } from "../src/util.ts";
import { pipeThroughWithUsage, pipePluginResponsesWithStrip, pipePluginJson, _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

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

test("#408: pipeThroughWithUsage — openai final usage chunk backfilled, ledger post-fold", async () => {
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
        await pipeThroughWithUsage(stream, res, session, "openai");
        const out = chunks.join("");
        assert.ok(out.includes('"prompt_tokens":100000'), out);
        assert.ok(out.includes('"total_tokens":100005'), out);
        assert.equal(session.stats.lastInputTokens, 60000);
        assert.equal(session.hostContextTokens, 100000);
    });
});

test("#408: pipeThroughWithUsage — anthropic message_start backfilled, zero message_delta untouched", async () => {
    await withTempStore("pipe-anthropic", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-ant", 40000);
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 60000, cache_read_input_tokens: 1000 } } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, output_tokens: 10 } })}\n\n`,
        ]);
        await pipeThroughWithUsage(stream, res, session, "anthropic");
        const out = chunks.join("");
        assert.ok(out.includes('"input_tokens":100000'), out);
        assert.ok(out.includes('"input_tokens":0'), "zero message_delta input_tokens must stay 0");
        assert.equal(session.stats.lastInputTokens, 61000);
        assert.equal(session.hostContextTokens, 101000);
    });
});

test("#408: pipeThroughWithUsage — no credit leaves bytes verbatim (control)", async () => {
    await withTempStore("pipe-ctrl", async (_dir, store) => {
        _setStoreForTest(store);
        const session = makeSession("pipe-ctrl");
        const chunks: Buffer[] = [];
        const res = makeRes(chunks);
        const stream = streamOf([
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 60000, completion_tokens: 5, total_tokens: 60005 } })}\n\n`,
            "data: [DONE]\n\n",
        ]);
        await pipeThroughWithUsage(stream, res, session, "openai");
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
