import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";

// #2328 Q2/Q4: the plugin-lane strip pipes now attach termination
// diagnostics (meta) to the in-band upstream_stream_truncated error frame and
// to the log line, and classify the cut:
//  - no-terminal-seen: EOF/read-error with no terminal bytes in flight.
//  - terminal-bytes-unrecognized: the dangling partial event at the cut
//    carries the opening bytes of the wire's own terminal ([DONE],
//    message_stop, finishReason chunk, response.completed family).
// This is what makes "the upstream never finished the turn" distinguishable
// from "the terminal arrived but its bytes never completed" (#2347 forensics)
// without needing a raw-SSE dump.

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

function streamOf(events: string[], then?: "error"): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else if (then === "error") {
                controller.error(new Error("upstream socket reset mid-stream"));
            } else {
                controller.close();
            }
        },
    });
}

/** Pull the first data-frame JSON that carries the truncation code. */
function truncationMeta(writes: string[], at: "top" | "nested"): Record<string, unknown> | undefined {
    for (const w of writes) {
        for (const frame of w.split("\n\n")) {
            const m = frame.match(/^(?:event: [^\n]+\n)?data: (.*)$/s);
            if (!m) continue;
            try {
                const ev = JSON.parse(m[1]!) as Record<string, unknown>;
                if (at === "top" && ev["code"] === "upstream_stream_truncated") return ev["meta"] as Record<string, unknown>;
                if (at === "nested") {
                    const err = ev["error"] as Record<string, unknown> | undefined;
                    // google's error object carries a numeric code (503) +
                    // gRPC status instead of the string code.
                    if (err && (err["code"] === "upstream_stream_truncated" || err["status"] === "UNAVAILABLE")) return err["meta"] as Record<string, unknown>;
                }
            } catch {
                /* not a JSON frame */
            }
        }
    }
    return undefined;
}

const openaiChunk = (fr: string | null) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: fr === null ? { content: "hi" } : {}, finish_reason: fr }] })}\n\n`;

test("chat pipe (openai): dangling `data: [DO` at EOF classifies as terminal-bytes-unrecognized", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([openaiChunk(null), "data: [DO"]),
        makeRes(out),
        "openai",
        undefined,
        (m) => logs.push(m),
    );
    const meta = truncationMeta(out, "nested");
    assert.ok(meta, "error frame carries meta");
    assert.equal(meta!["classification"], "terminal-bytes-unrecognized");
    assert.equal(meta!["cause"], "eof");
    assert.equal(meta!["protocol"], "openai");
    assert.equal(meta!["eofBufferBytes"], "data: [DO".length);
    assert.equal(meta!["eofBufferHead"], "data: [DO");
    assert.deepEqual(meta!["lastEventTypes"], ["chunk"]);
    assert.equal(meta!["events"], 1);
    assert.ok((meta!["bytes"] as number) > 0);
    assert.equal(meta!["retryZeroByteCutSpent"], false);
    assert.equal(meta!["retryDegenerateSpent"], false);
    // wire shape: openai meta nests inside `error`, and the [DONE] tail still
    // follows the error frame (#721 contract unchanged).
    assert.ok(out.join("").includes("data: [DONE]"));
    // log line: one grep-able line with the classification + full diag.
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes("classification=terminal-bytes-unrecognized"));
    assert.ok(line!.includes("cause=eof"));
    assert.ok(line!.includes("diag="));
});

test("chat pipe (anthropic): clean EOF with no terminal classifies as no-terminal-seen", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
        ]),
        makeRes(out),
        "anthropic",
    );
    const meta = truncationMeta(out, "nested");
    assert.ok(meta, "error frame carries meta");
    assert.equal(meta!["classification"], "no-terminal-seen");
    assert.equal(meta!["cause"], "eof");
    assert.equal(meta!["eofBufferBytes"], 0);
    assert.equal(meta!["eofBufferHead"], undefined);
    assert.deepEqual(meta!["lastEventTypes"], ["message_start", "content_block_delta"]);
    assert.ok((meta!["visibleChars"] as number) >= 2);
    assert.ok(out.join("").includes("event: error"));
});

test("chat pipe (google): meta rides the UNAVAILABLE error object and counts unparseable forwards", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([
            // one parseable chunk, then one unparseable frame (forwarded raw),
            // then EOF with nothing terminal in flight.
            `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hi" }] } }] })}\n\n`,
            "data: {{{not-json\n\n",
        ]),
        makeRes(out),
        "google",
    );
    const meta = truncationMeta(out, "nested");
    assert.ok(meta, "error frame carries meta");
    assert.equal(meta!["classification"], "no-terminal-seen");
    assert.equal(meta!["unparseableForwarded"], 1);
    assert.deepEqual(meta!["lastEventTypes"], ["chunk", "unparseable"]);
    const frame = out.join("");
    // Gemini's error object carries a numeric code + gRPC status, no string
    // code (see emitUpstreamTruncation) — UNAVAILABLE identifies the frame.
    assert.ok(frame.includes('"status":"UNAVAILABLE"'));
    assert.ok(frame.includes('"code":503'));
});

test("chat pipe: upstreamMeta threads HTTP status/content-type into the diag", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([openaiChunk(null)]),
        makeRes(out),
        "openai",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { status: 200, contentType: "text/event-stream" },
    );
    const meta = truncationMeta(out, "nested");
    assert.ok(meta);
    assert.equal(meta!["upstreamStatus"], 200);
    assert.equal(meta!["upstreamContentType"], "text/event-stream");
});

test("responses pipe: dangling response.completed head classifies as terminal-bytes-unrecognized", async () => {
    const out: string[] = [];
    const sse = (e: string, d: Record<string, unknown>) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
    await pipePluginResponsesWithStrip(
        streamOf([
            sse("response.created", { response: { id: "resp_1" } }),
            sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
            sse("response.content_part.added", { item_id: "msg_1", output_index: 0 }),
            sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "he" }),
            'event: response.completed\ndata: {"type":"response.comp',
        ]),
        makeRes(out),
    );
    const meta = truncationMeta(out, "top");
    assert.ok(meta, "error frame carries meta");
    assert.equal(meta!["classification"], "terminal-bytes-unrecognized");
    assert.equal(meta!["cause"], "eof");
    assert.equal(meta!["protocol"], "responses");
    assert.ok((meta!["eofBufferHead"] as string).includes("response.comp"));
    assert.deepEqual(meta!["lastEventTypes"], [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
    ]);
    assert.equal(meta!["heldEvents"], 0);
    assert.ok((meta!["visibleChars"] as number) >= 2);
});

test("responses pipe: clean EOF after deltas classifies as no-terminal-seen", async () => {
    const out: string[] = [];
    const sse = (e: string, d: Record<string, unknown>) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
    await pipePluginResponsesWithStrip(
        streamOf([
            sse("response.created", { response: { id: "resp_1" } }),
            sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
            sse("response.content_part.added", { item_id: "msg_1", output_index: 0 }),
            sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "hi" }),
        ]),
        makeRes(out),
    );
    const meta = truncationMeta(out, "top");
    assert.ok(meta);
    assert.equal(meta!["classification"], "no-terminal-seen");
    assert.equal(meta!["eofBufferBytes"], 0);
});

test("responses pipe: upstream read error records cause=read-error", async () => {
    const out: string[] = [];
    const sse = (e: string, d: Record<string, unknown>) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
    await pipePluginResponsesWithStrip(
        streamOf([sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "x" })], "error"),
        makeRes(out),
    );
    const meta = truncationMeta(out, "top");
    assert.ok(meta);
    assert.equal(meta!["cause"], "read-error");
    assert.equal(meta!["classification"], "no-terminal-seen");
});

test("chat pipe (anthropic): dangling message_stop head classifies as terminal-bytes-unrecognized", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
            "event: message_stop\ndata: {\"type\":\"mess",
        ]),
        makeRes(out),
        "anthropic",
    );
    const meta = truncationMeta(out, "nested");
    assert.ok(meta);
    assert.equal(meta!["classification"], "terminal-bytes-unrecognized");
});
