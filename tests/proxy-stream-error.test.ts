import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { emitStreamError } from "../src/stream-error.ts";

/** Collect all bytes written to a ServerResponse into a string. */
function makeCollector(): { res: http.ServerResponse; chunks: Buffer[]; done: Promise<string> } {
    const chunks: Buffer[] = [];
    // Minimal stub mimicking the methods emitStreamError uses.
    const res = {
        write(chunk: string | Buffer) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
        },
        end() {
            return this;
        },
    } as unknown as http.ServerResponse;
    return { res, chunks, done: Promise.resolve("") };
}

// #1455: the default is the protocol-native failure frame — a mid-stream
// failure must never arrive dressed as a successful completion (that shape
// silenced client retry logic in the incident). The old shapes are pinned
// below as the compat.streamErrorShape="completion" opt-out.
test("emitStreamError: openai default = top-level error frame + [DONE] (no fabricated completion)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "openai", "test failure");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /"error":\{"type":"server_error","code":"stream_error"/);
    assert.match(out, /test failure/);
    assert.match(out, /\[DONE\]/);
    assert.doesNotMatch(out, /finish_reason/);
});

test("emitStreamError: openai errorShape=\"completion\" restores error delta + finish + [DONE]", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "openai", "test failure", undefined, "completion");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /test failure/);
    assert.match(out, /finish_reason.*stop/);
    assert.match(out, /\[DONE\]/);
});

test("emitStreamError: anthropic default = protocol-native error event (no terminal)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "anthropic", "boom");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /^event: error$/m);
    assert.match(out, /"code":"stream_error"/);
    assert.match(out, /boom/);
    assert.doesNotMatch(out, /message_stop|message_delta|content_block_delta/);
});

// Parse every SSE event of an emitted stream into its data payload. All
// legacy-completion frames carry exactly one data line each.
function parseFrames(out: string): Record<string, unknown>[] {
    return out.split("\n\n")
        .filter((b) => b.startsWith("event:"))
        .map((b) => JSON.parse(b.slice(b.indexOf("data: ") + "data: ".length)) as Record<string, unknown>);
}

// #2689: the anthropic completion shape must be a WELL-FORMED lifecycle —
// strict clients (ZCode) validate every frame against the Anthropic SSE
// schema and rejected the whole turn on the old bare delta (no numeric
// index, no owning content_block_start). Defaults model a fresh stream:
// nothing forwarded yet → synthesize message_start, block index 0.
test("emitStreamError: anthropic errorShape=\"completion\" emits a full well-formed lifecycle (synthetic start + indexed block)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "anthropic", "boom", undefined, "completion");
    const out = Buffer.concat(chunks).toString("utf8");
    const order = [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ];
    let cursor = -1;
    for (const ev of order) {
        const at = out.indexOf(`event: ${ev}`);
        assert.notEqual(at, -1, `missing event ${ev}`);
        assert.ok(at > cursor, `${ev} out of order`);
        cursor = at;
    }
    // Every block-scoped frame carries the same NUMERIC index — the exact
    // field ZCode's validator failed on before the fix.
    const frames = parseFrames(out);
    const blockFrames = frames.filter((f) => f["type"] === "content_block_start" || f["type"] === "content_block_delta" || f["type"] === "content_block_stop");
    assert.equal(blockFrames.length, 3);
    for (const f of blockFrames) {
        assert.equal(typeof f["index"], "number");
        assert.equal(f["index"], 0);
    }
    assert.deepEqual(blockFrames[0], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    assert.deepEqual(blockFrames[1], { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\n❌ [ACP] stream error: boom" } });
    assert.deepEqual(blockFrames[2], { type: "content_block_stop", index: 0 });
    const md = frames.find((f) => f["type"] === "message_delta");
    assert.deepEqual(md, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } });
});

test("emitStreamError: anthropic completion honors caller-known stream state (mid-stream index, no re-start)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "anthropic", "boom", undefined, "completion", { blockIndex: 2, messageStarted: true });
    const out = Buffer.concat(chunks).toString("utf8");
    // The client already saw message_start and two blocks: no synthetic start,
    // and the error block lands at the next free index (2), not 0.
    assert.doesNotMatch(out, /event: message_start/);
    const frames = parseFrames(out);
    const blockFrames = frames.filter((f) => String(f["type"]).startsWith("content_block"));
    assert.equal(blockFrames.length, 3);
    for (const f of blockFrames) assert.equal(f["index"], 2);
    assert.match(out, /boom/);
    assert.match(out, /message_stop/);
});

test("emitStreamError: responses default = protocol-native error event", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "responses", "kaboom");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /^event: error$/m);
    assert.match(out, /"type":"error"/);
    assert.match(out, /kaboom/);
    assert.doesNotMatch(out, /output_item|response\.completed/);
});

test("emitStreamError: google default = Gemini error frame (numeric code + status)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "google", "gboom");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /"error":\{"code":500,"message":"\[acp-proxy: gboom\]","status":"INTERNAL"\}/);
});

test("emitStreamError: responses errorShape=\"completion\" emits a full item lifecycle (added → delta → done → completed)", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "responses", "kaboom", undefined, "completion");
    const out = Buffer.concat(chunks).toString("utf8");
    // Ordered: every delta must be preceded by output_item.added and followed
    // by the done events — a bare delta crashes strict clients (#62).
    const order = [
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
    ];
    let cursor = -1;
    for (const ev of order) {
        const at = out.indexOf(ev);
        assert.notEqual(at, -1, `missing event ${ev}`);
        assert.ok(at > cursor, `${ev} out of order`);
        cursor = at;
    }
    assert.match(out, /kaboom/);
    // Every item-scoped event carries the same item_id and output_index, so
    // strict clients can associate the delta with the added item.
    const itemId = "msg_acp_error";
    const itemEvents = out.split("\n\n").filter((block) => block.includes("item_id"));
    assert.ok(itemEvents.length >= 4, "expected item-scoped events");
    for (const block of itemEvents) {
        assert.match(block, new RegExp(`"item_id":"${itemId}"`));
        assert.match(block, /"output_index":0/);
    }
    // The completed response contains the error item in its output array.
    const completed = out.split("\n\n").find((b) => b.includes("response.completed"));
    assert.ok(completed);
    const data = JSON.parse((completed?.split("data: ")[1] ?? "").trim());
    assert.equal(data.response.output.length, 1);
    assert.equal(data.response.output[0].id, itemId);
    assert.ok(data.response.output[0].content[0].text.includes("kaboom"));
});

test("emitStreamError: never throws even if write throws (client gone)", () => {
    const res = {
        write() {
            throw new Error("write EPIPE");
        },
        end() {
            throw new Error("end EPIPE");
        },
    } as unknown as http.ServerResponse;
    assert.doesNotThrow(() => emitStreamError(res, "openai", "x"));
});

test("emitStreamError: calls the optional log callback", () => {
    const { res } = makeCollector();
    let logged = "";
    emitStreamError(res, "openai", "logged-msg", (m) => (logged = m));
    assert.match(logged, /stream aborted/);
    assert.match(logged, /logged-msg/);
});
