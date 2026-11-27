import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #7862: the model echoed a header marker AFTER its answer inside one SSE
// frame (`"\n✅ 正常" + \x3cacp tokens="3" type="text" time="..."\x3e`). The
// filter released the answer, then dropped the opening with leavesInterior=true;
// the answer ledger booked the frame's whole released slice as markup, read
// answerProse=0 as a degenerate turn, retried (#732/#821), hit the same echo
// and emitted the #870 in-band error — killing a turn whose answer had already
// reached the host (~450K input tokens per attempt, twice). An opening's
// interior can only be released AFTER it, so an attrs-bearing opening must not
// arm the frame; a bare opening that reaches the same record DOES arm it (the
// #2769 wrap shape, where the released prefix is the span's interior).
// Directions: T1/T2 are the fix; T3/T4/T5 keep the retry and markup contracts
// (#3617).

const OPEN = `\x3cacp tokens="3" type="text" time="2026-11-27 21:24:01"\x3e`;
const BARE_OPEN = `\x3cacp\x3e`;
const ANSWER = "\n✅ 正常";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
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
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

function chatFinish(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

async function run(deltas: string[]) {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "recovered answer" }), chatFinish("stop"), DONE]));
    };
    const events = [
        chatChunk({ role: "assistant", content: deltas[0] }),
        ...deltas.slice(1).map((content) => chatChunk({ content })),
        chatFinish("stop"),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    return { body: out.join(""), logs, refetches };
}

test("chat pipe: answer + trailing echo opening in ONE frame is not degenerate — no retry (#7862 sample)", async () => {
    const { body, logs, refetches } = await run([ANSWER + OPEN]);
    assert.equal(refetches, 0, "the released answer precedes the opening — it cannot be the opening's interior");
    assert.ok(body.includes("✅ 正常"), "the delivered answer reaches the client");
    assert.ok(!logs.some((l) => l.includes("degenerate terminal turn")), "no degenerate verdict for a healthy turn");
});

test("chat pipe: answer and the echo opening split across frames stay non-degenerate (#7862 chunking variant)", async () => {
    const { body, refetches } = await run([ANSWER, OPEN]);
    assert.equal(refetches, 0, "the prefix answer was already counted before the opening arrived");
    assert.ok(body.includes("✅ 正常"), "the delivered answer reaches the client");
});

test("chat pipe: an opening at the frame head still retries — its tail is tag content, not an answer (#7862 control)", async () => {
    const { body, logs, refetches } = await run([OPEN + ANSWER]);
    assert.equal(refetches, 1, "nothing usable was delivered — the retry must fire");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});

test("chat pipe: the #2769 wrap shape keeps the frame armed — prefix prose is its interior (#7862 control)", async () => {
    const { refetches } = await run([`pre${BARE_OPEN}    `]);
    assert.equal(refetches, 1, "a word-preceded bare opening wrapping whitespace is still no answer");
});

test("filter: an attrs-bearing opening leaves no interior, a word-preceded bare opening does (#7862)", () => {
    const attrs: boolean[] = [];
    const fa = createTagEchoFilter(undefined, undefined, false, undefined, (v) => attrs.push(v));
    const releasedA = fa.push(`answer text ${OPEN}`);
    assert.equal(releasedA, "answer text ", "the prose ahead of the quotation flows to the client");
    assert.deepEqual(attrs, [false], "a complete tag quote never arms the frame");

    const bare: boolean[] = [];
    const fb = createTagEchoFilter(undefined, undefined, false, undefined, (v) => bare.push(v));
    fb.push(`pre${BARE_OPEN}    `);
    assert.deepEqual(bare, [true], "the wrap shape keeps arming the frame");
});

test("filter: an attrs-bearing opening whose span resolves with a prose body still arms at the close (#7862 control)", () => {
    const verdicts: boolean[] = [];
    const f = createTagEchoFilter(undefined, undefined, false, undefined, (v) => verdicts.push(v));
    f.push(OPEN);
    const released = f.push(`wrapped body\x3c/acp\x3e`);
    assert.equal(released, "wrapped body", "the body is released (only the close goes)");
    assert.deepEqual(verdicts, [false, true], "the body-releasing close leaves interior; the opening itself does not");
});
