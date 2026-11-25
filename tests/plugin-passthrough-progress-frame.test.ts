import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";

// MTPLX (local MLX server) interleaves a text-less progress frame into the
// stream roughly every ~15 decoded tokens:
//   {"choices":[{"index":0,"delta":{},"finish_reason":null}],"mtplx_progress":{…}}
// The frame is not terminal and carries nothing for the client, yet the no-text
// flush path drained the tag-echo filter on it. A render tag split across the
// frame lost its held head (`<acp tokens="3`) and the rest
// (`1" type="text" …>m00039`) no longer started with `<`, so it reached the
// host as prose (the #5192 shape). Inert frames must not change what the
// client sees.

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

const DONE = "data: [DONE]\n\n";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

const PROGRESS = `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    mtplx_progress: { completion_tokens: 14, decode_phase: "content", decode_tok_s: 60.9 },
})}\n\n`;

function contentOf(text: string): string {
    let out = "";
    for (const block of text.split("\n\n")) {
        const payload = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!payload || payload === "[DONE]") continue;
        const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
        const v = obj.choices?.[0]?.delta?.content;
        if (typeof v === "string") out += v;
    }
    return out;
}

async function visible(contents: string[], progressAfter: (i: number) => boolean): Promise<string> {
    const events = [chunk({ role: "assistant" })];
    contents.forEach((c, i) => {
        events.push(chunk({ content: c }));
        if (progressAfter(i)) events.push(PROGRESS);
    });
    events.push(chunk({}, "stop"), DONE);
    const chunks: string[] = [];
    await pipePluginChatWithStrip(streamOf(events), makeRes(chunks), "openai");
    return contentOf(chunks.join(""));
}

const HEAD = '<acp tokens="3';
const REST = '1" type="text" time="2026-11-06 15:30:10">m00039';

test("a progress frame inside a paired render tag does not leak the tag's tail", async () => {
    const out = await visible(["前の文章。", HEAD, REST + "</acp>", "後の文章"], (i) => i === 1);
    assert.equal(out, "前の文章。後の文章");
});

test("a progress frame inside an unclosed render tag yields the same text as without it", async () => {
    const contents = [HEAD, REST + "\n", "子作成完了"];
    const without = await visible(contents, () => false);
    const withProgress = await visible(contents, (i) => i === 0);
    assert.equal(withProgress, without);
    assert.doesNotMatch(withProgress, /type="text"|m00039/);
});

test("progress frames at every chunk boundary leave the visible text unchanged", async () => {
    const contents = [..."前の文章。", ...`<acp tokens="31" type="text" time="2026-11-06 15:30:10">m00039</acp>`, ..."後の文章"];
    const without = await visible(contents, () => false);
    const withProgress = await visible(contents, () => true);
    assert.equal(without, "前の文章。後の文章");
    assert.equal(withProgress, without);
});
