import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { acquireInFlight, releaseInFlight, getSession } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(): {
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
            id: "fix-stream-test",
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

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

/** A round whose compress call deterministically FAILS (no ref map in
 * makeCtx()). `round` varies the requested refs so consecutive rounds have
 * distinct failure signatures — the #156 identical-failure short-circuit
 * must not fire in these tests. */
function mutatingRound(round = 1): string {
    return [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: `m${String(round).padStart(5, "0")}`, endId: `m${String(round + 1).padStart(5, "0")}`, summary: "s" }] })),
        COMPLETED,
    ].join("");
}

async function drainSig(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    signal: AbortSignal | undefined,
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(
        stream,
        ctx,
        { model: "gpt-4o", input: [], stream: true },
        { url: "http://mock", headers: {} },
        createResponsesAdapter(),
        buildCompressSystemPrompt(),
        signal,
    )) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("client-abort: pre-aborted signal suppresses upstream re-request fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (() => { fetchCalls++; return new Response(mutatingRound(), { status: 200 }); }) as typeof fetch;
    try {
        const out = await drainSig(new Response(mutatingRound(), { status: 200 }).body!, makeCtx(), ac.signal);
        assert.equal(fetchCalls, 0, "no re-request fetch when signal is pre-aborted");
        assert.equal(out, "", "loop yielded nothing before bailing out");
    } finally {
        globalThis.fetch = orig;
    }
});

test("client-abort: signal aborted during a re-request stops further re-requests", async () => {
    const ac = new AbortController();
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (() => {
        fetchCalls++;
        ac.abort();
        return new Response(mutatingRound(), { status: 200 });
    }) as typeof fetch;
    try {
        await drainSig(new Response(mutatingRound(), { status: 200 }).body!, makeCtx(), ac.signal);
        assert.equal(fetchCalls, 1, "exactly one re-request fetch; subsequent rounds were skipped after abort");
    } finally {
        globalThis.fetch = orig;
    }
});

test("client-abort control: without a signal, mutating rounds keep re-requesting up to the loop limit", async () => {
    // #156 note: the fetch mock varies the failing range each round so the
    // identical-failure short-circuit stays out of the picture — what stops
    // this loop must be the round limit, not a signal and not short-circuit.
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (() => { fetchCalls++; return new Response(mutatingRound(fetchCalls + 1), { status: 200 }); }) as typeof fetch;
    try {
        await drainSig(new Response(mutatingRound(), { status: 200 }).body!, makeCtx(), undefined);
        assert.ok(fetchCalls > 1, `control path re-requested multiple times (fetchCalls=${fetchCalls}); abort is what stops it`);
    } finally {
        globalThis.fetch = orig;
    }
});

// MockRes simulates a downstream response whose socket is destroyed after the
// first write that needs drain: "drain" never fires, "close" does.
class MockRes extends EventEmitter {
    public written: Buffer[] = [];
    public writableNeedDrain = false;
    public writableEnded = false;
    public destroyed = false;
    write(chunk: Buffer): boolean {
        this.written.push(chunk);
        this.writableNeedDrain = true;
        setImmediate(() => {
            this.destroyed = true;
            this.emit("close");
        });
        return false;
    }
    end(): void { this.writableEnded = true; }
}

test("drain-race: pipe resolves on close and breaks on destroyed socket (no 10-min hang)", async () => {
    const res = new MockRes();
    const chunks = [Buffer.from("chunk1\n"), Buffer.from("chunk2\n"), Buffer.from("chunk3\n")];
    const pipe = (async () => {
        for (const chunk of chunks) {
            res.write(chunk);
            if (res.writableNeedDrain) {
                await Promise.race([
                    new Promise<void>((r) => res.once("drain", () => r())),
                    new Promise<void>((r) => res.once("close", () => r())),
                ]);
            }
            if (res.destroyed || res.writableEnded) break;
        }
        res.end();
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("pipe hung — drain race did not resolve on close")), 1000));
    await Promise.race([pipe, timeout]);
    assert.equal(res.destroyed, true, "socket reached destroyed state");
    assert.equal(res.written.length, 1, "pipe broke after the first (un-drained) write; did not keep writing to a dead socket");
});

function roundWithUsage(cached: number | undefined): string {
    const usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 5 };
    if (typeof cached === "number") usage.input_tokens_details = { cached_tokens: cached };
    return [
        sse("response.created", { response: { id: "resp_u", status: "in_progress" } }),
        sse("response.completed", {
            response: {
                id: "resp_u",
                status: "completed",
                output: [],
                usage,
            },
        }),
    ].join("");
}

test("recordUsage: cacheSamples only increments when cachedTokens is a number", async () => {
    const ctxNoCache = makeCtx();
    const orig = globalThis.fetch;
    globalThis.fetch = (() => new Response(roundWithUsage(42), { status: 200 })) as typeof fetch;
    try {
        await drainSig(new Response(roundWithUsage(undefined), { status: 200 }).body!, ctxNoCache, undefined);
    } finally {
        globalThis.fetch = orig;
    }
    assert.equal(ctxNoCache.session.stats.cacheSamples, 0, "no cacheSamples bump when cachedTokens undefined");
    assert.equal(ctxNoCache.session.stats.inputTokens, 100, "inputTokens still recorded");
    assert.equal(ctxNoCache.session.stats.cachedTokens, 0, "cachedTokens unchanged when undefined");

    const ctxWithCache = makeCtx();
    await drainSig(new Response(roundWithUsage(42), { status: 200 }).body!, ctxWithCache, undefined);
    assert.equal(ctxWithCache.session.stats.cacheSamples, 1, "cacheSamples bumped exactly once when cachedTokens=42");
    assert.equal(ctxWithCache.session.stats.cachedTokens, 42, "cachedTokens accumulated");
});

// acquireInFlight/releaseInFlight is the primitive the handle() reorder depends
// on: evictOldest skips sessions with inFlight>0, so holding inFlight across
// getSession→lock-acquisition closes the split-brain window. evictOldest itself
// is private; this guards the counter invariant.
test("inFlight: acquire/release is balanced and floors at 0 (never negative)", () => {
    const session = getSession(`fix-stream-d-${Math.random().toString(36).slice(2)}`);
    assert.equal(session.inFlight, 0, "fresh session is not in-flight");
    acquireInFlight(session);
    acquireInFlight(session);
    assert.equal(session.inFlight, 2, "acquire increments per request");
    releaseInFlight(session);
    assert.equal(session.inFlight, 1, "release decrements");
    releaseInFlight(session);
    assert.equal(session.inFlight, 0, "back to 0 after all releases");
    releaseInFlight(session);
    assert.equal(session.inFlight, 0, "release past 0 is a no-op (never negative)");
});
