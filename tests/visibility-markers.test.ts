import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";

test("parseCompressSettings: visibilityMarkers boolean round-trips", () => {
    const off = parseCompressSettings({ tiers: true, visibilityMarkers: false });
    assert.deepEqual(off, { tiers: true, visibilityMarkers: false });
    const on = parseCompressSettings({ visibilityMarkers: true });
    assert.deepEqual(on, { visibilityMarkers: true });
});

test("parseCompressSettings: non-boolean visibilityMarkers poisons the block", () => {
    assert.equal(parseCompressSettings({ visibilityMarkers: "false" }), undefined);
    assert.equal(parseCompressSettings({ visibilityMarkers: 0 }), undefined);
});

test("mergeCompress: visibilityMarkers merges per-level, deepest defined wins", () => {
    assert.equal(mergeCompress({ visibilityMarkers: false }, { visibilityMarkers: true }).visibilityMarkers, true);
    assert.equal(mergeCompress({ visibilityMarkers: true }, { visibilityMarkers: false }).visibilityMarkers, false);
    assert.equal(mergeCompress(undefined, undefined, { visibilityMarkers: false }).visibilityMarkers, false);
    assert.equal(mergeCompress({ tiers: true }).visibilityMarkers, undefined);
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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// acp_status vehicle: these tests pin marker visibility/suppression across execute
// + re-request. A failing compress ends the turn before any re-request (#4186),
// which would silently un-test the continuation path.
const FC_STATUS = [
    sse("response.output_item.added", { item: { type: "function_call", id: "fc_s", call_id: "call_s", name: "acp_status" }, output_index: 0 }),
    sse("response.function_call_arguments.delta", { item_id: "fc_s", delta: "{}" }),
    sse("response.output_item.done", { item: { type: "function_call", id: "fc_s", call_id: "call_s", name: "acp_status", arguments: "{}" }, output_index: 0 }),
].join("");

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

async function drainRound(ctx: Parameters<typeof runCompressLoop>[1]): Promise<{ out: string; fetchCalls: number }> {
    let n = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return new Response(COMPLETED, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        const stream = new Response(FC_STATUS + COMPLETED, { status: 200 }).body!;
        for await (const chunk of runCompressLoop(stream, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
            chunks.push(chunk);
        }
        return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls: n };
    } finally {
        globalThis.fetch = previousFetch;
    }
}

test("loop: explicit visibilityMarkers=true keeps the marker (default parity)", async () => {
    const { out, fetchCalls } = await drainRound({ ...makeCtx(), visibilityMarkers: true });
    assert.ok(out.includes("[ACP]"), "marker shown when explicitly enabled");
    assert.ok(fetchCalls >= 1, "re-request still fires");
});

test("loop: visibility marker message item carries an upstream-legal msg id (WC-015)", async () => {
    const { out } = await drainRound({ ...makeCtx(), visibilityMarkers: true });
    assert.ok(out.includes("[ACP]"), "marker emitted in this round");
    const messageItems = [...out.matchAll(/event: (response\.output_item\.(?:added|done))\ndata: ([^\n]+)\n\n/g)]
        .map((m) => JSON.parse(m[2]) as { item?: { type?: string; id?: unknown } })
        .map((e) => e.item)
        .filter((item): item is { type?: string; id?: unknown } => item?.type === "message");
    assert.ok(messageItems.length > 0, "marker rode a message item");
    for (const item of messageItems)
        assert.ok(typeof item.id === "string" && item.id.startsWith("msg"), `message item id must begin with 'msg'; got ${JSON.stringify(item.id)}`);
});

test("loop: visibilityMarkers=false suppresses the marker but executes + re-requests", async () => {
    const { out, fetchCalls } = await drainRound({ ...makeCtx(), visibilityMarkers: false });
    assert.ok(!out.includes("[ACP]"), "no marker line reaches the client when disabled");
    assert.ok(!out.includes("\u{1F4E6}"), "no 📦 icon in stream when disabled");
    assert.ok(fetchCalls >= 1, "the tool still executed and the continuation re-request fired");
    assert.ok(/event: response\.completed/.test(out), "graceful completion");
});

function jsonCtx(log: (m: string) => void, visibilityMarkers?: boolean): Parameters<typeof compressLoopResponsesJson>[1] {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession("vm-json-test"),
        log,
        ...(visibilityMarkers !== undefined ? { visibilityMarkers } : {}),
    };
}

test("json: read-only acp_status marker suppressed when disabled", async () => {
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
        const off = await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, false), { model: "gpt-4o", input: [{ type: "message", role: "user", content: "status" }] }, { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(!JSON.stringify(off.output).includes("[ACP]"), "disabled: no read-only marker in output");
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
        await compressLoopResponsesJson(structuredClone(initial), jsonCtx(() => {}, false), structuredClone(request), { url: "https://unused.example/responses", headers: { "content-type": "application/json" } });
        assert.ok(bodies.length === 1, "disabled: re-request still fires");
        assert.ok(!JSON.stringify(bodies[0]).includes("[ACP]"), "disabled: no developer marker in re-request body");
    } finally {
        globalThis.fetch = previousFetch;
    }
});
