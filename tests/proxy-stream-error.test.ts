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

test("emitStreamError: openai emits error delta + finish + [DONE]", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "openai", "test failure");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /test failure/);
    assert.match(out, /finish_reason.*stop/);
    assert.match(out, /\[DONE\]/);
});

test("emitStreamError: anthropic emits content_block_delta + message_stop", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "anthropic", "boom");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /content_block_delta/);
    assert.match(out, /boom/);
    assert.match(out, /message_stop/);
});

test("emitStreamError: responses emits output_text.delta + response.completed", async () => {
    const { res, chunks } = makeCollector();
    emitStreamError(res, "responses", "kaboom");
    const out = Buffer.concat(chunks).toString("utf8");
    assert.match(out, /response\.output_text\.delta/);
    assert.match(out, /kaboom/);
    assert.match(out, /response\.completed/);
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
