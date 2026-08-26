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
        end() {},
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
    const flushDelta = text.split("\n\n").find((l) => l.includes("tail"));
    assert.ok(flushDelta?.includes("msg_1"), "flushed tail delta carries item_id");
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
