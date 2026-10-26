import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #413 follow-up (#862): a reasoning-only prefix is invisible to host turn
// semantics — the client's turn does not start until visible text or a tool
// call arrives. A round-1 truncation after live-forwarded reasoning chunks is
// therefore retried once (blind re-fetch): the re-fetched stream appends its
// own thinking + answer to the same wire and the client never sees an error.
// Pre-#862 this shape was left as a hard error because the gate counted
// reasoning bytes as client-visible (forwardedAny); the gate is now
// !forwardedVisible (src/loop/core.ts).

const OPENAI_BODY = { model: "glm", messages: [], stream: true, max_tokens: 10 };

function makeCtx(id: string): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    protocol: "openai";
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
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
        protocol: "openai",
    };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: ReturnType<typeof makeCtx>): Promise<string> {
    const adapter = createOpenaiAdapter(OPENAI_BODY);
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, OPENAI_BODY, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function mockFetch(handler: () => Response): { calls: () => number; restore: () => void } {
    let n = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        n++;
        return handler();
    }) as typeof fetch;
    return { calls: () => n, restore: () => { globalThis.fetch = orig; } };
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

test("truncation after live reasoning chunks retries once (reasoning-only prefix is invisible to host turn semantics)", async () => {
    const partial = sse({ id: "c1", choices: [{ index: 0, delta: { reasoning_content: "partial thought before EOF" } }] });
    const full = sse({ id: "c2", choices: [{ index: 0, delta: { reasoning_content: "second attempt reasoning" } }] })
        + sse({ id: "c2", choices: [{ index: 0, delta: { content: "FINAL ANSWER" } }] })
        + sse({ id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        + "data: [DONE]\n\n";
    const mock = mockFetch(() => new Response(full, { status: 200 }));
    const ctx = makeCtx("trunc-reasoning");
    try {
        const out = await drain(new Response(partial, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 1, "one blind re-fetch: nothing client-VISIBLE reached the turn yet");
        const firstIdx = out.indexOf("partial thought before EOF");
        assert.ok(firstIdx >= 0, "attempt-1 partial reasoning was forwarded to the client");
        assert.equal(out.indexOf("partial thought before EOF", firstIdx + 1), -1, "partial reasoning appears exactly once (no duplicated attempt)");
        assert.ok(out.includes("FINAL ANSWER"), "the re-fetched stream's answer reached the client");
        assert.ok(!out.includes("upstream stream truncated"), "self-healed: no truncation error surfaced");
    } finally {
        mock.restore();
    }
});
