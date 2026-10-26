import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { applyUsageSample, pipePluginChatWithStrip } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

// #793: a gateway that sends placeholder all-zero usage in message_start
// (devin-gateway style: real input arrives in message_delta) clobbered the
// session's last trusted lastInputTokens with 0 when the stream was settled
// before the authoritative usage arrived — typically a client abort mid-stream.
// Nudge then froze at 0% until the next successful turn. A zero-total input
// sample carries no information (every real request has input tokens) and must
// never overwrite lastInputTokens — in plugin mode (applyUsageSample) nor in
// proxy mode (recordUsage).

const SID = "plug-793-test";

function makeSession(lastInputTokens = 112712, extraStats: Record<string, number> = {}): Session {
    return {
        id: SID,
        metadata: {},
        stats: {
            requests: 0,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            contextTokens: 0,
            lastInputTokens,
            ...extraStats,
        },
    } as unknown as Session;
}

function makeRes() {
    const chunks: string[] = [];
    return {
        res: {
            write(b: Buffer | string) {
                chunks.push(typeof b === "string" ? b : b.toString("utf8"));
                return true;
            },
            end(b?: Buffer | string) {
                if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            },
            once() {},
            destroyed: false,
            writableEnded: false,
        } as unknown as import("node:http").ServerResponse,
        chunks,
    };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(enc.encode(chunks[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function failingStream(chunks: string[], err: Error): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(enc.encode(chunks[i]));
                i += 1;
            } else {
                controller.error(err);
            }
        },
    });
}

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const startZero = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_z", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, cache_read_input_tokens: 0 },
    },
});
const startReal = ev("message_start", {
    type: "message_start",
    message: {
        id: "msg_r", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 273, cache_read_input_tokens: 112439 },
    },
});
const deltaZeroEcho = ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: 7 },
});
const deltaReal = ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: 273, cache_read_input_tokens: 112439, output_tokens: 42 },
});
const messageStop = ev("message_stop", { type: "message_stop" });

let logs: string[] = [];

beforeEach(() => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    logs = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
});

afterEach(() => {
    setLogCapture(null);
});

test("#793 plugin (anthropic): client abort after all-zero message_start keeps last trusted lastInputTokens", async () => {
    const s = makeSession(50000);
    const { res } = makeRes();
    await pipePluginChatWithStrip(failingStream([startZero], new Error("client aborted")), res, "anthropic", s);
    assert.equal(s.stats.lastInputTokens, 50000, "placeholder zeros must not clobber the last trusted value");
    assert.equal(s.stats.inputTokens, 0);
    assert.equal(s.stats.cacheSamples, 0, "a degenerate zero sample is not a cache observation");
    assert.ok(logs.some((l) => l.includes("skipped zero-total usage sample")), "the skip is observable in logs");
});

test("#411 control: a POSITIVE message_start still settles on abort (#793 must not regress this)", async () => {
    const s = makeSession(50000);
    const { res } = makeRes();
    await pipePluginChatWithStrip(failingStream([startReal], new Error("client aborted")), res, "anthropic", s);
    assert.equal(s.stats.lastInputTokens, 112712, "273 fresh + 112439 cached");
    assert.equal(s.stats.cacheSamples, 1);
});

test("#793 plugin (anthropic): authoritative message_delta overrides the zero placeholder on normal completion", async () => {
    const s = makeSession(50000);
    const { res } = makeRes();
    await pipePluginChatWithStrip(streamOf([startZero, deltaReal, messageStop]), res, "anthropic", s);
    assert.equal(s.stats.lastInputTokens, 112712);
    assert.equal(s.stats.outputTokens, 42);
});

test("#793 plugin (anthropic): relay echoing 0/0 through normal completion keeps lastInputTokens, output still counts", async () => {
    const s = makeSession(50000);
    const { res } = makeRes();
    await pipePluginChatWithStrip(streamOf([startZero, deltaZeroEcho, messageStop]), res, "anthropic", s);
    assert.equal(s.stats.lastInputTokens, 50000);
    assert.equal(s.stats.outputTokens, 7);
    assert.equal(s.stats.cacheSamples, 0);
});

test("#793 applyUsageSample: zero-total sample never touches lastInputTokens/cached stats", () => {
    const s = makeSession(50000);
    applyUsageSample(s, { inputTokens: 0, cachedTokens: 0 }, "anthropic");
    assert.equal(s.stats.lastInputTokens, 50000);
    assert.equal(s.stats.cacheSamples, 0);
    applyUsageSample(s, { inputTokens: 0, cachedTokens: 0, outputTokens: 9 }, "anthropic");
    assert.equal(s.stats.outputTokens, 9, "output-side stats still count");
    assert.equal(s.stats.lastInputTokens, 50000);
});

test("#793 applyUsageSample: positive samples still settle, with credit net-out", () => {
    const s = makeSession(50000, { compressCreditTokens: 1000 });
    applyUsageSample(s, { inputTokens: 1000, cachedTokens: 500 }, "anthropic");
    assert.equal(s.stats.lastInputTokens, 1500 - 1000);
    assert.equal(s.stats.inputTokens, 1500);
    assert.equal(s.stats.cacheSamples, 1);
});

const ANTHROPIC_BODY = { model: "claude", messages: [], stream: true, max_tokens: 10 };

function makeCtx(id: string, logSink?: string[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
            meta: {},
            stats: {
                requests: 0,
                tokensSaved: 0,
                inputTokens: 0,
                cachedTokens: 0,
                outputTokens: 0,
                cacheSamples: 0,
                contextTokens: 0,
                lastInputTokens: 112712,
                compressCreditTokens: 0,
                retrieveCalls: 0,
                retrieveHits: 0,
                retrieveMisses: 0,
                storedBytes: 0,
                storeBytesSaved: 0,
                rangeRestores: 0,
            },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => {
            logSink?.push(m);
        },
    };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>): Promise<string> {
    const adapter = createAnthropicAdapter(ANTHROPIC_BODY);
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, ANTHROPIC_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("#793 proxy loop (anthropic): 0/0 relay through completion keeps last trusted lastInputTokens", async () => {
    const sink: string[] = [];
    const ctx = makeCtx("loop-793-a", sink);
    await drain(streamOf([startZero, deltaZeroEcho, messageStop]), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 112712);
    assert.equal(ctx.session.stats.outputTokens, 7);
    assert.ok(sink.some((m) => m.includes("zero-total: lastInputTokens kept")));
});

test("#793 proxy loop control: real usage still records", async () => {
    const ctx = makeCtx("loop-793-b");
    await drain(streamOf([startReal, deltaZeroEcho, messageStop]), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 112712);
    assert.equal(ctx.session.stats.outputTokens, 7);
});
