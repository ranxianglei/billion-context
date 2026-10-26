import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #413 follow-up (#862): stream died AFTER visible text reached the client —
// a blind re-fetch would make the client watch the answer regrow over the
// partial one, so re-fetch ONCE with a continuation nudge quoting the
// forwarded tail (last <=800 chars). Independent one-shot budget
// (continuationRetried), separate from #413's truncationRetried, so both cut
// orderings self-heal. Nudge is ephemeral: never in coreMessages/session state.

const OPENAI_BODY = { model: "deepseek-chat", stream: true };

function makeCtx(id: string) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
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
        } as unknown as Session,
        log: () => {},
        protocol: "openai" as const,
    };
}

const DONE = "data: [DONE]\n\n";

const frames = (list: Array<Record<string, unknown>>): string =>
    list.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

const chunk = (id: string, delta: Record<string, unknown>): Record<string, unknown> => ({
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }],
});

const finish = (id: string): Record<string, unknown> => ({
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

// Visible text, then EOF — no finish frame, no [DONE].
const PARTIAL_TEXT = frames([
    chunk("cm_1", { role: "assistant", content: "" }),
    chunk("cm_1", { content: "The fix is to reset the pool before" }),
]);

// Reasoning only, then EOF — zero client-visible output.
const REASONING_ONLY = frames([
    chunk("cm_2", { role: "assistant", content: "" }),
    chunk("cm_2", { reasoning_content: "invisible post-cut thinking" }),
]);

// A clean completion whose text appends to PARTIAL_TEXT's tail.
const GOOD_TAIL = frames([
    chunk("cm_3", { role: "assistant", content: "" }),
    chunk("cm_3", { content: " redeploying the workers." }),
    finish("cm_3"),
]) + DONE;

async function drain(
    first: string,
    retries: Array<string | Error>,
    id: string,
): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const spec = retries[fetchCalls - 1] ?? "";
        if (spec instanceof Error) throw spec;
        return new Response(spec, { status: 200 });
    }) as typeof fetch;
    const emitted: Buffer[] = [];
    try {
        const ctx = makeCtx(id);
        for await (const c of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            OPENAI_BODY,
            { url: "http://mock", headers: {} },
            createOpenaiAdapter(OPENAI_BODY),
            buildCompressSystemPrompt(),
        )) {
            emitted.push(c);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(emitted).toString("utf8"), fetchCalls, bodies };
}

test("#862 C1: visible-text truncation → one continuation retry, output appends after the forwarded tail", async () => {
    const { out, fetchCalls, bodies } = await drain(PARTIAL_TEXT, [GOOD_TAIL], "cont-c1");
    assert.equal(fetchCalls, 1, "exactly one continuation retry fired");
    assert.ok(bodies[0].includes("cut off mid-transmission"), "retry body carries the continuation nudge");
    assert.ok(bodies[0].includes("The fix is to reset the pool before"), "nudge quotes the already-forwarded tail");
    assert.ok(out.includes("The fix is to reset the pool before"), "attempt-1 text reached the client");
    assert.ok(out.includes("redeploying the workers."), "continuation output reached the client");
    assert.ok(out.indexOf("The fix is to reset the pool before") < out.indexOf("redeploying the workers."), "continuation appends AFTER the forwarded text");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed: no truncation error surfaced");
});

test("#862 C2: visible cut → invisible cut → good: both budgets fire (visible→invisible ordering)", async () => {
    const { out, fetchCalls } = await drain(PARTIAL_TEXT, [REASONING_ONLY, GOOD_TAIL], "cont-c2");
    assert.equal(fetchCalls, 2, "continuation then blind re-fetch: one extra fetch per budget");
    assert.ok(out.includes("redeploying the workers."), "final good stream delivered");
    assert.ok(!out.includes("upstream stream truncated"), "no error surfaced");
});

test("#862 C3: invisible cut → visible cut → good: #413 then continuation (invisible→visible ordering)", async () => {
    const { out, fetchCalls, bodies } = await drain(REASONING_ONLY, [PARTIAL_TEXT, GOOD_TAIL], "cont-c3");
    assert.equal(fetchCalls, 2, "blind re-fetch then continuation: one extra fetch per budget");
    assert.ok(!bodies[0].includes("cut off mid-transmission"), "blind re-fetch reuses the original body (no nudge)");
    assert.ok(bodies[1].includes("cut off mid-transmission"), "the later visible cut triggers the continuation nudge");
    assert.ok(out.includes("redeploying the workers."), "final good stream delivered");
    assert.ok(!out.includes("upstream stream truncated"), "no error surfaced");
});

test("#862 C4: budget bound — visible/invisible/visible cuts exhaust both one-shots, then the error surfaces", async () => {
    const { out, fetchCalls } = await drain(PARTIAL_TEXT, [REASONING_ONLY, PARTIAL_TEXT], "cont-c4");
    assert.equal(fetchCalls, 2, "at most one continuation + one blind re-fetch per request");
    assert.ok(out.includes("upstream stream truncated"), "after both budgets are spent the truncation error surfaces");
});

// The openai adapter buffers EVERY tool chunk until settle (finish/[DONE]), so
// a truncated stream settles nothing: no tool_call event reaches the loop and
// nothing tool-shaped reached the client either — the round retries cleanly
// like any visible-text cut. The calls.length===0 gate in core.ts remains as
// defense-in-depth for a hypothetical live-emitting adapter.
test("#862 C5: truncated round carrying tool-call fragments settles nothing → retried cleanly", async () => {
    const partialWithTool = frames([
        chunk("cm_9", { role: "assistant", content: "" }),
        chunk("cm_9", { content: "let me check the log" }),
        chunk("cm_9", { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }),
    ]);
    const { out, fetchCalls } = await drain(partialWithTool, [GOOD_TAIL], "cont-c5");
    assert.equal(fetchCalls, 1, "buffer-to-finish: no settled tool event → treated as a plain visible-text cut");
    assert.ok(out.includes("let me check the log"), "attempt-1 text reached the client");
    assert.ok(out.includes("redeploying the workers."), "continuation delivered");
    assert.ok(!out.includes("upstream stream truncated"), "self-healed");
});

test("#862 C6: nudge quotes only the last 800 chars of the forwarded text", async () => {
    const longText = "START_MARKER_" + "x".repeat(850) + "_ENDTAIL";
    const partialLong = frames([
        chunk("cm_7", { role: "assistant", content: "" }),
        chunk("cm_7", { content: longText }),
    ]);
    const { fetchCalls, bodies } = await drain(partialLong, [GOOD_TAIL], "cont-c6");
    assert.equal(fetchCalls, 1, "continuation retry fired");
    assert.ok(bodies[0].includes("_ENDTAIL"), "tail end is quoted in the nudge");
    assert.ok(!bodies[0].includes("START_MARKER_"), "text beyond the 800-char tail window is not quoted");
});

test("#862 C7: a failing continuation re-fetch falls back to the truncation error", async () => {
    const { out, fetchCalls } = await drain(PARTIAL_TEXT, [new Error("socket hang up")], "cont-c7");
    assert.equal(fetchCalls, 1, "the failed continuation attempt consumes the one-shot");
    assert.ok(out.includes("upstream stream truncated"), "client still sees the truncation error");
});
