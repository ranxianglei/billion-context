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

test("emitStreamError: anthropic errorShape=\"completion\" restores content_block_delta + message_stop", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "anthropic", "boom", undefined, "completion");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /content_block_delta/);
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
