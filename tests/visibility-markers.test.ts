import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress, resolveVisibilityMode, type VisibilityMode } from "../src/compress-settings.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";

test("parseCompressSettings: visibilityMarkers boolean round-trips", () => {
    const off = parseCompressSettings({ tiers: true, visibilityMarkers: false });
    assert.deepEqual(off, { tiers: true, visibilityMarkers: false });
    const on = parseCompressSettings({ visibilityMarkers: true });
    assert.deepEqual(on, { visibilityMarkers: true });
});

test("parseCompressSettings: visibilityMarkers tri-state strings round-trip", () => {
    for (const mode of ["stream", "model-only", "off"] as const) {
        assert.deepEqual(parseCompressSettings({ visibilityMarkers: mode }), { visibilityMarkers: mode });
    }
});

test("parseCompressSettings: invalid visibilityMarkers poisons the block", () => {
    assert.equal(parseCompressSettings({ visibilityMarkers: "false" }), undefined);
    assert.equal(parseCompressSettings({ visibilityMarkers: "STREAM" }), undefined);
    assert.equal(parseCompressSettings({ visibilityMarkers: 0 }), undefined);
});

test("mergeCompress: visibilityMarkers merges per-level, deepest defined wins", () => {
    assert.equal(mergeCompress({ visibilityMarkers: false }, { visibilityMarkers: true }).visibilityMarkers, true);
    assert.equal(mergeCompress({ visibilityMarkers: true }, { visibilityMarkers: false }).visibilityMarkers, false);
    assert.equal(mergeCompress(undefined, undefined, { visibilityMarkers: false }).visibilityMarkers, false);
    assert.equal(mergeCompress({ visibilityMarkers: "stream" }, { visibilityMarkers: "model-only" }).visibilityMarkers, "model-only");
    assert.equal(mergeCompress({ tiers: true }).visibilityMarkers, undefined);
});

test("resolveVisibilityMode: legacy booleans and tri-state normalize", () => {
    assert.equal(resolveVisibilityMode(undefined), "stream");
    assert.equal(resolveVisibilityMode(true), "stream");
    assert.equal(resolveVisibilityMode(false), "off");
    assert.equal(resolveVisibilityMode("stream"), "stream");
    assert.equal(resolveVisibilityMode("model-only"), "model-only");
    assert.equal(resolveVisibilityMode("off"), "off");
});

function makeCtx(): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session: {
            id: "vm-marker-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const FC_COMPRESS = [
    sse("response.output_item.added", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress" }, output_index: 0 }),
    sse("response.function_call_arguments.delta", { item_id: "fc_c", delta: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] }) }),
    sse("response.output_item.done", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: "{}" }, output_index: 0 }),
].join("");

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

async function drainRound(ctx: Parameters<typeof runCompressLoop>[1], fetchBody: string = COMPLETED): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let n = 0;
    const bodies: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body !== undefined) bodies.push(String(init.body));
        return new Response(fetchBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        const stream = new Response(FC_COMPRESS + COMPLETED, { status: 200 }).body!;
        for await (const chunk of runCompressLoop(stream, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
            chunks.push(chunk);
        }
        return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls: n, bodies };
    } finally {
        globalThis.fetch = previousFetch;
    }
}

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test("loop: visibilityMode=\"stream\" keeps the marker (default parity)", async () => {
    const { out, fetchCalls } = await drainRound({ ...makeCtx(), visibilityMode: "stream" });
    assert.ok(out.includes("[ACP]"), "marker shown in stream mode");
    assert.ok(fetchCalls >= 1, "re-request still fires");
});

test("loop: visibilityMode=\"off\" suppresses the marker but executes + re-requests", async () => {
    const { out, fetchCalls, bodies } = await drainRound({ ...makeCtx(), visibilityMode: "off" });
    assert.ok(!out.includes("[ACP]"), "no marker line reaches the client when off");
    assert.ok(!out.includes("\u{1F4E6}"), "no 📦 icon in stream when off");
    assert.ok(fetchCalls >= 1, "the tool still executed and the continuation re-request fired");
    assert.ok(/event: response\.completed/.test(out), "graceful completion");
    assert.ok(bodies.length >= 1 && !bodies[0].includes("[ACP]"), "off: orphan marker message absent from the re-request, paired tool result still rides");
    assert.ok(bodies[0].includes('"compress"'), "paired tool-call/tool-result unaffected by off");
});

test("loop: visibilityMode=\"model-only\" keeps the client stream silent but the re-request carries the pair", async () => {
    const { out, fetchCalls, bodies } = await drainRound({ ...makeCtx(), visibilityMode: "model-only" });
    assert.ok(!out.includes("[ACP]"), "model-only: no receipt bytes reach the client");
    assert.ok(!out.includes("\u{1F4E6}"), "model-only: no 📦 icon in stream");
    assert.ok(fetchCalls >= 1, "the tool still executed and the continuation re-request fired");
    assert.ok(/event: response\.completed/.test(out), "graceful completion");
    assert.ok(bodies.length >= 1 && bodies[0].includes('"compress"'), "model-only: paired tool-call/tool-result still rides the re-request");
});

const countMarkerMessages = (out: string): number => new Set([...out.matchAll(/"id":"(marker-\d+-\d+)"/g)].map((m) => m[1])).size;

test("loop: model-only surfaces exactly one visible marker at terminal failure", async () => {
    const { out, fetchCalls } = await drainRound({ ...makeCtx(), visibilityMode: "model-only" }, FC_COMPRESS + COMPLETED);
    assert.equal(countMarkerMessages(out), 1, "exactly one terminal receipt message, intermediate ones silent");
    assert.ok(out.includes("❌"), "terminal line carries the failure icon");
    assert.ok(out.indexOf("[ACP]") < out.indexOf("response.completed"), "terminal line precedes completion");
    assert.equal(fetchCalls, 1, "identical-failure early break after round 2 (one continuation re-request)");
});

test("loop: off surfaces no marker even at terminal failure", async () => {
    const { out, fetchCalls } = await drainRound({ ...makeCtx(), visibilityMode: "off" }, FC_COMPRESS + COMPLETED);
    assert.ok(!out.includes("[ACP]"), "off: double-off holds at terminal failure");
    assert.equal(fetchCalls, 1, "same early-break cadence as model-only");
});

function jsonCtx(log: (m: string) => void, visibilityMode?: VisibilityMode): Parameters<typeof compressLoopResponsesJson>[1] {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession("vm-json-test"),
        log,
        ...(visibilityMode !== undefined ? { visibilityMode } : {}),
    };
}

test("json: read-only acp_status marker suppressed when off", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "r", status: "completed", output: [] }), { status: 200 })) as typeof fetch;
    try {
        const initial = {
            id: "resp_vm_ro",
            status: "completed",
            output: [{ type: "function_call", id: "fc_st", call_id: "call_st", name: "acp_status", arguments: "{}" }],
        };
        const on = await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}), { model: "gpt-4o", input: [{ type: "message", role: "user", content: "status" }] }, { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(JSON.stringify(on.output).includes("[ACP]"), "default: read-only marker surfaced");
        const off = await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, "off"), { model: "gpt-4o", input: [{ type: "message", role: "user", content: "status" }] }, { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(!JSON.stringify(off.output).includes("[ACP]"), "off: no read-only marker in output");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("json: mutating compress re-request body carries the developer marker only when enabled", async () => {
    const bodies: Record<string, unknown>[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "r2", status: "completed", output: [] }), { status: 200 });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_vm_mut",
            status: "completed",
            output: [{ type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] }) }],
        };
        const request = { model: "gpt-4o", input: [{ type: "message", role: "user", content: "go" }] };
        await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}), structuredClone(request), { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(bodies.length === 1, "mutating tool triggers exactly one re-request");
        assert.ok(JSON.stringify(bodies[0]).includes("[ACP]"), "default: developer marker rides the re-request");
        bodies.length = 0;
        await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, "off"), structuredClone(request), { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(bodies.length === 1, "off: re-request still fires");
        assert.ok(!JSON.stringify(bodies[0]).includes("[ACP]"), "off: no developer marker in re-request body");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("json: model-only splits polarity — developer marker on the re-request, zero marker bytes in the returned output", async () => {
    const bodies: Record<string, unknown>[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "r2", status: "completed", output: [] }), { status: 200 });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_vm_mo",
            status: "completed",
            output: [{ type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] }) }],
        };
        const request = { model: "gpt-4o", input: [{ type: "message", role: "user", content: "go" }] };
        const res = await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, "model-only"), structuredClone(request), { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(bodies.length === 1, "re-request fires");
        assert.ok(JSON.stringify(bodies[0]).includes("[ACP]"), "model-only: developer marker still rides the re-request (model sees the receipt)");
        assert.ok(!JSON.stringify(res.output).includes("[ACP]"), "model-only: zero receipt bytes in the client-facing output");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("json: model-only appends exactly one terminal marker at the loop limit after repeated failures", async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({
            id: `r${fetchCalls}`,
            status: "completed",
            output: [{ type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00999", endId: "m00999", summary: "s" }] }) }],
        }), { status: 200 });
    }) as typeof fetch;
    try {
        const initial = {
            id: "resp_vm_term",
            status: "completed",
            output: [{ type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00999", endId: "m00999", summary: "s" }] }) }],
        };
        const request = { model: "gpt-4o", input: [{ type: "message", role: "user", content: "go" }] };
        const res = await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, "model-only"), structuredClone(request), { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        const serialized = JSON.stringify(res.output);
        assert.equal(countOccurrences(serialized, "[ACP]"), 1, "exactly one terminal marker appended at the cap exit");
        assert.ok(serialized.includes("❌"), "terminal marker carries the failure icon");
        assert.ok(fetchCalls > 1, "loop ran multiple rounds before the cap exit");
    } finally {
        globalThis.fetch = previousFetch;
    }
});
