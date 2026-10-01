import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { isOrphanMarkupText } from "../src/loop/tag-echo-filter.ts";
import type { Session } from "../src/session.ts";

// #1760: a single-line answer led by a non-ASCII char ("只回一个字：好" → "好")
// was misjudged degenerate on the chat-completions lane. The marker-line filter
// holds ANY non-ASCII line-start prefix across the whole stream (broad hold,
// strict decide — #717), and the #1546 terminal drain counted every released
// tail as markup residue. But a released tail is content preservation by design:
// the filters never drop an undecidable prefix. So a turn whose ONLY output was
// held prose read as "only orphan markup", burned its continuation nudge, and
// errored in-band. Released tails are now classified by byte shape
// (isOrphanMarkupText): markup-shaped tails stay residue (the #870 contract),
// prose counts as visible output.

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
        writes: chunks,
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
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const e of events) controller.enqueue(enc.encode(e));
            controller.close();
        },
    });
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
const chatChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => sse({ choices: [{ delta, ...extra }] });
const chatStop = (reason = "stop") => sse({ choices: [{ finish_reason: reason }] });
const coalescedChunk = (content: string, reason = "stop") => sse({ choices: [{ delta: { content }, finish_reason: reason }] });

function textDeltas(raw: string, proto: "openai" | "anthropic" = "openai"): string {
    const re = proto === "openai" ? /"content":"((?:[^"\\]|\\.)*)"/g : /"text":"((?:[^"\\]|\\.)*)"/g;
    let out = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) out += JSON.parse(`"${m[1]}"`) as string;
    return out;
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), ...[...text].map((c) => chatChunk({ content: c })), chatStop(), DONE];
}

function anthropicProseTurn(text: string): string[] {
    return [
        sse({ type: "message_start", message: { id: "msg_1", role: "assistant" } }),
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ...[...text].map((c) => sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } })),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        sse({ type: "message_stop" }),
    ];
}

test("isOrphanMarkupText classifies a released tail by its bytes, not its origin", () => {
    // Plain prose — the #1760 bug class. Non-ASCII leads are prose.
    assert.equal(isOrphanMarkupText("好"), false, "single CJK char is prose");
    assert.equal(isOrphanMarkupText("é"), false, "accented Latin lead is prose");
    assert.equal(isOrphanMarkupText("OK"), false);
    // A lone astral icon held to terminal is preserved content the client sees.
    assert.equal(isOrphanMarkupText("📦"), false);
    // Markup-shaped tails stay residue (the #870 contract).
    assert.equal(isOrphanMarkupText("\x3ca"), true, "partial render-tag head");
    assert.equal(isOrphanMarkupText('\x3cacp tokens="1" type="text"'), true, "unclosed render-tag opening");
    assert.equal(isOrphanMarkupText("\x3c/acp t"), true, "partial render-tag close");
    assert.equal(isOrphanMarkupText("[ACP] Compressed m00120–m0300"), true, "literal marker line");
    assert.equal(isOrphanMarkupText("\u003cbili-cha"), true, "truncated internal-artifact open");
});

test("#1760 repro: the recorded deepseek SSE returns 好 without a nudge re-issue", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    const events = [
        chatChunk({ role: "assistant", content: null, reasoning_content: "" }),
        chatChunk({ content: "好", reasoning_content: null }),
        sse({ choices: [{ delta: { content: "", reasoning_content: null }, finish_reason: "stop" }] }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 0, "a preserved-prose tail is visible output — no nudge re-issue");
    assert.ok(!text.includes("[ACP] stream error"), "no in-band degenerate error");
    assert.equal(textDeltas(text), "好", "the answer reaches the client");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "exactly one terminator");
});

test("#1760 fold path: a coalesced CJK content+finish chunk folds its tail as prose", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(
        streamOf([chatChunk({ role: "assistant" }), coalescedChunk("好"), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
        undefined,
        refetch,
    );
    const text = out.join("");
    assert.equal(calls, 0, "the folded tail is prose, not residue");
    assert.ok(!text.includes("[ACP] stream error"));
    assert.equal(textDeltas(text), "好");
});

test("#1760 anthropic lane: a single-line CJK answer drains as prose before stop_reason", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(anthropicProseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(anthropicProseTurn("好")), makeRes(out), "anthropic", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 0, "a prose tail is not residue");
    assert.ok(!text.includes("[ACP] stream error"));
    assert.equal(textDeltas(text, "anthropic"), "好");
});

test("#870 kept: a tail shaped like an unclosed render tag still retries once", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real answer after the nudge")));
    };
    await pipePluginChatWithStrip(
        streamOf([chatChunk({ role: "assistant" }), chatChunk({ content: "\x3ca" }), chatStop(), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
        undefined,
        refetch,
    );
    const text = out.join("");
    assert.equal(calls, 1, "markup-shaped residue still triggers the one invisible retry");
    assert.ok(textDeltas(text).includes("real answer after the nudge"), "the retry's prose reaches the client");
    assert.ok(!text.includes("[ACP] stream error"), "one retry suffices — no in-band error");
});

test("multi-line CJK answer in one chunk stays clean (never affected)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(
        streamOf([chatChunk({ role: "assistant" }), chatChunk({ content: "好\n世界" }), chatStop(), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
        undefined,
        refetch,
    );
    assert.equal(calls, 0);
    assert.equal(textDeltas(out.join("")), "好\n世界");
});
