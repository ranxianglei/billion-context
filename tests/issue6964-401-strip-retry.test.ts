import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createGoogleAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #6964: a 401 on an [acp-loop] round-1 re-request (an expired OAuth Bearer
// mid-turn, the Antigravity/agy v1internal case) must NOT trigger the
// thinking-strip retry — the strip-retry recovers a 400 that rejected the
// replayed thinking, and nothing else. Re-sending the SAME expired credentials
// after stripping is a doomed second request that only delays the same error.
// These tests pin: a 401 propagates (one re-request, no strip-retry), while a
// neutral 400 still gets the degraded strip-retry (the gate is scoped to 400,
// not blanket-disabled).

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
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

function candidateFrame(parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { candidates: [{ content: { role: "model", parts }, index: 0, ...extra }] };
}

const GOOGLE_BODY: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "orig" }] }],
    tools: [{ functionDeclarations: [{ name: "acp_status", description: "status" }] }],
    generationConfig: { maxOutputTokens: 8192 },
};

// A round-1 stream with a thought (thinking) block + a proxy tool call: the
// loop records the thinking as an acp_loop_ reasoning message, so the
// strip-retry gate's coreMessages.some(isLoopThinking) precondition is met.
const round1WithThinking = [
    sse(candidateFrame([{ thought: true, text: "loop reasoning" }])),
    sse(candidateFrame([{ functionCall: { id: "call_6964", name: "acp_status", args: {} } }])),
    sse(candidateFrame([], { finishReason: "STOP" })),
].join("");

async function drainGoogleWithStatus(
    first: string,
    attempts: { body: string; status: number }[],
    id: string,
): Promise<{ out: string; calls: number; bodies: string[] }> {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        n += 1;
        if (typeof init?.body === "string") bodies.push(init.body);
        const a = attempts[n - 1] ?? { body: "", status: 200 };
        return new Response(a.body, { status: a.status });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    const ctx = makeCtx(id);
    (ctx as Record<string, unknown>).protocol = "google";
    try {
        for await (const c of runCompressLoop(
            streamOf(first),
            ctx,
            GOOGLE_BODY,
            { url: "http://mock", headers: {} },
            createGoogleAdapter(GOOGLE_BODY, undefined, undefined, "gemini-3-pro-preview"),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), calls: n, bodies };
}

test("#6964 a: a 401 on the re-request propagates — no doomed strip-retry", async () => {
    const authError = JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    const { out, calls } = await drainGoogleWithStatus(round1WithThinking, [{ body: authError, status: 401 }], "i6964-a");
    assert.equal(calls, 1, "exactly one re-request — the 401 must not trigger a strip-retry");
    assert.ok(out.includes("401"), `the 401 error surfaced to the client (got ${out.slice(0, 200)})`);
});

test("#6964 b: a neutral 400 on the re-request still gets the degraded strip-retry (gate scoped to 400)", async () => {
    const round2 = [
        sse(candidateFrame([{ text: "loop answer b" }])),
        sse(candidateFrame([], { finishReason: "STOP" })),
    ].join("");
    const neutral400 = JSON.stringify({ error: { message: "thinking block rejected" } });
    const { out, calls } = await drainGoogleWithStatus(
        round1WithThinking,
        [{ body: neutral400, status: 400 }, { body: round2, status: 200 }],
        "i6964-b",
    );
    assert.equal(calls, 2, "the neutral 400 still triggers the strip-retry (one re-request + one stripped retry)");
    assert.ok(out.includes("loop answer b"), "the stripped retry's answer reached the client");
});
