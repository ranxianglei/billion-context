import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #413 review: the truncation-retry predicate must treat live-forwarded
// reasoning chunks as client-visible side effects. The openai adapter yields
// reasoning events with `raw` (adapter-openai.ts:328) and no meta precedes a
// pure reasoning_content chunk — if those yields don't set forwardedAny, a
// round-1 truncation after reasoning-only output retries and the client sees
// the partial reasoning TWICE.

const OPENAI_BODY = { model: "glm", messages: [], stream: true, max_tokens: 10 };

function makeCtx(id: string): {
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

test("truncation after live reasoning chunks must not retry (reasoning already reached the client)", async () => {
    const partial = sse({ id: "c1", choices: [{ index: 0, delta: { reasoning_content: "partial thought before EOF" } }] });
    const full = sse({ id: "c2", choices: [{ index: 0, delta: { reasoning_content: "second attempt reasoning" } }] })
        + sse({ id: "c2", choices: [{ index: 0, delta: { content: "FINAL ANSWER" } }] })
        + sse({ id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        + "data: [DONE]\n\n";
    const mock = mockFetch(() => new Response(full, { status: 200 }));
    const ctx = makeCtx("trunc-reasoning");
    try {
        const out = await drain(new Response(partial, { status: 200 }).body!, ctx);
        assert.equal(mock.calls(), 0, "no retry: reasoning bytes were already forwarded to the client");
        const firstIdx = out.indexOf("partial thought before EOF");
        assert.ok(firstIdx >= 0, "partial reasoning was forwarded to the client");
        assert.equal(out.indexOf("partial thought before EOF", firstIdx + 1), -1, "partial reasoning appears exactly once (no duplicated attempt)");
        assert.ok(!out.includes("second attempt reasoning"), "retry stream content never fetched");
        assert.ok(out.includes("upstream stream truncated"), "truncation surfaced to client");
    } finally {
        mock.restore();
    }
});
