import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "responses",
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

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
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

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

test("plugin passthrough strips render tags from output_text.delta (single event)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `leading ${TAG_OPEN}m00042${TAG_CLOSE} trailing` }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "done" }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "render tag content must not pass through");
    assert.ok(text.includes("leading  trailing"), "non-tag prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 100, "usage still sampled from completed event");
});

test("plugin passthrough strips tags split across deltas and flushes tail before done", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `ok ${TAG_OPEN}m0` }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `0042${TAG_CLOSE} tail` }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "split tag fully swallowed");
    assert.ok(text.includes("ok "), "first delta prose passes");
    assert.ok(text.includes("tail"), "post-tag tail flushed before completed");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes("tail"));
    const completedIdx = blocks.findIndex((b) => b.includes("response.completed"));
    assert.ok(flushIdx !== -1 && completedIdx !== -1 && flushIdx < completedIdx, "flushed tail delta must precede the done-family event that triggered it");
    assert.ok((blocks[flushIdx] ?? "").includes("msg_1"), "flushed tail delta carries item_id");
});

test("plugin passthrough strips a tag streamed in tokenizer-sized fragments (#468)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const whole = `ok ${TAG_OPEN}m00042${TAG_CLOSE} tail`;
    const micro = whole.match(/.{1,4}/g) ?? [];
    const events = [
        ...micro.map((piece) => sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: piece })),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "micro-fragmented tag never reassembles downstream");
    assert.ok(!text.includes("\x3cacp") && !text.includes("\x3c/acp"), "no tag fragment survives");
    const joined = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()) as { type?: string; delta?: string })
        .filter((ev) => ev.type === "response.output_text.delta" && typeof ev.delta === "string")
        .map((ev) => ev.delta as string)
        .join("");
    assert.equal(joined, "ok  tail", "surrounding prose reassembles to the tag-free text");
});

test("plugin passthrough keeps function_call and non-tag events byte-identical", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const fc = sse({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "compress", call_id: "call_1", arguments: "{\"content\":[]}" } });
    const plain = sse({ type: "response.output_text.delta", item_id: "msg_2", output_index: 0, delta: "plain text no tags" });
    const events = [fc, plain, sse({ type: "response.completed", response: { usage: { input_tokens: 1 } } })];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(text.includes(fc.trim()), "function_call event untouched");
    assert.ok(text.includes(plain.trim()), "clean delta untouched");
});

test("plugin passthrough strips tags from done-family full-text payloads", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "clean" }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: `clean ${TAG_OPEN}m00001${TAG_CLOSE}` }),
        sse({ type: "response.completed", response: {} }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00001"), "done payload stripped");
    assert.ok(text.includes("clean "), "done payload prose survives");
});

test("plugin passthrough preserves SSE framing for tag-free done-family events (no data lines fused)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const done = sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "done text no tags" });
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hello" }),
        done,
        sse({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", name: "read", call_id: "c2", arguments: "{}" } }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 9 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    assert.equal(dataLines.length, 4, "event count preserved");
    for (const l of dataLines) {
        let parsed: unknown;
        assert.doesNotThrow(() => {
            parsed = JSON.parse(l.slice(5).trim());
        }, `every data line must stay valid JSON: ${l.slice(0, 120)}`);
        assert.ok(parsed);
    }
    assert.ok(text.includes(done.trim()), "tag-free done event byte-identical");
    assert.ok(text.endsWith("\n\n"), "stream keeps event framing to the end");
});

test("plugin passthrough resolves held tail at stream end without a done-family event", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_9", output_index: 0, delta: `prose ${TAG_OPEN}m0` }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(text.includes("prose "), "clean prefix passes");
    assert.ok(!text.includes("m0"), "content of an unclosed tag is dropped at stream end, not flushed as junk");

    const out2: string[] = [];
    const res2 = makeRes(out2);
    const events2 = [
        sse({ type: "response.output_text.delta", item_id: "msg_9", output_index: 0, delta: `prose \x3cac` }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events2), res2, session);
    const text2 = out2.join("");
    assert.ok(text2.includes(`"delta":"prose "`), "clean prefix passes once the ambiguous head is held");
    assert.ok(text2.includes(`"delta":"\x3cac"`), "ambiguous prefix flushed as its own delta at stream end, never lost");
});

test("plugin passthrough rebuildEvent collapses multi-line data payloads into one line", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const escOpen = TAG_OPEN.replace(/"/g, '\\"');
    const payload = `{ "type": "response.output_text.done",\n"item_id": "msg_1", "text": "done ${escOpen}m00001${TAG_CLOSE}" }`;
    const raw = `event: response.output_text.done\ndata: ${payload.split("\n")[0]}\ndata: ${payload.split("\n")[1]}\n\n`;
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "x" }),
        raw,
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    for (const l of dataLines) {
        assert.doesNotThrow(() => JSON.parse(l.slice(5).trim()), `single-line data stays parseable: ${l.slice(0, 100)}`);
    }
    assert.ok(!text.includes("m00001"), "multi-line done payload still stripped");
});

test("plugin JSON passthrough strips render tags for responses protocol", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const body = JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `hi ${TAG_OPEN}m00003${TAG_CLOSE}` }] }], usage: { input_tokens: 4 } });
    const stream = streamOf([body]);
    await pipePluginJson(stream, res as unknown as import("node:http").ServerResponse, session, "responses");
    const text = out.join("");
    const parsed = JSON.parse(text) as { output: Array<{ content: Array<{ text: string }> }> };
    assert.ok(!text.includes("m00003"), "tag stripped from non-streaming responses body");
    assert.equal(parsed.output[0]?.content[0]?.text, "hi ", "prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 4, "usage still sampled");
});

test("plugin JSON passthrough stays verbatim for tag-free bodies", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    {
        const out: string[] = [];
        const res = makeRes(out);
        const session = makeSession();
        const body = JSON.stringify({ choices: [{ message: { content: "clean chat" } }], usage: { prompt_tokens: 2 } });
        await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "openai");
        assert.equal(out.join(""), body, "tag-free openai body byte-identical");
    }
    {
        const out: string[] = [];
        const res = makeRes(out);
        const session = makeSession();
        const body = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "clean" }] }] });
        await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "responses");
        assert.equal(out.join(""), body, "tag-free responses body byte-identical");
    }
});
