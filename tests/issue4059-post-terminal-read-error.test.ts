import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";

// #4059: a read failure AFTER the turn's terminal event was already forwarded
// is transport noise, not truncation. Pre-fix, the responses catch path
// appended a contradictory `upstream_stream_truncated` error frame after
// response.completed (and its diagnostic self-reported "no-terminal-seen"),
// making clients retry or stop an already-finished turn; the chat-pipe twin
// re-sent a duplicate [DONE]/message_stop instead. This suite pins BOTH
// directions of the gate: post-terminal failures end clean, genuine
// pre-terminal failures keep the in-band signal (or its finished= synthesis),
// and a terminal consumed by the empty-turn retry (never forwarded) still
// raises the signal when the retry stream is cut.

function makeRes(chunks: string[]) {
    let ended = 0;
    const r = {
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            ended++;
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
        get endedCount() {
            return ended;
        },
    };
    return r as unknown as import("node:http").ServerResponse & { endedCount: number };
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
                controller.error(new Error("terminated"));
            } else {
                controller.close();
            }
        },
    });
}

function failingStream(err: Error): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.error(err);
        },
    });
}

function makeSession(metadata: Record<string, unknown> = {}): Session {
    return {
        id: "sess-4059",
        meta: {},
        stats: {
            requests: 0,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens: 0,
            compressCreditTokens: 0,
            contextTokens: 0,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
        pendingRetrievals: [],
        metadata,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

const sse = (e: string, d: Record<string, unknown>) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;

const responsesTurn = (terminal: "response.completed" | "response.failed" | "response.incomplete") => [
    sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } }),
    sse("response.content_part.added", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "" } }),
    sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "ok" }),
    sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }),
    sse("response.content_part.done", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "ok" } }),
    sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] } }),
    sse(terminal, { response: { id: "resp_1", status: terminal.split(".")[1] } }),
];

let logs: string[] = [];
// Gate-action lines (retry takeover, terminal-byte synthesis) ride the
// per-request `log` callback, not loggerLog — collect both into one list.
const logLine = (m: string) => logs.push(m);
beforeEach(() => {
    logs = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));
});
afterEach(() => {
    setLogCapture(null);
});

for (const terminal of ["response.completed", "response.failed", "response.incomplete"] as const) {
    test(`#4059 responses: read error after forwarded ${terminal} ends clean — no truncation frame`, async () => {
        const out: string[] = [];
        const res = makeRes(out);
        await pipePluginResponsesWithStrip(streamOf(responsesTurn(terminal), "error"), res, makeSession({ pluginAgent: "dsh" }));
        const wire = out.join("");
        assert.ok(wire.includes(`"type":"${terminal}"`), "terminal frame forwarded");
        assert.ok(wire.includes(`"status":"${terminal.split(".")[1]}"`), "terminal keeps its own status");
        assert.ok(!wire.includes("upstream_stream_truncated"), "no contradictory truncation error");
        assert.ok(!wire.includes("event: error"), "no synthetic error event");
        assert.ok(logs.some((l) => l.includes("terminal already forwarded")), "guarded catch branch logged");
        assert.equal(res.endedCount, 1, "stream still closed exactly once");
    });
}

test("#4059 responses: [DONE]-terminated stream + post-[DONE] read error ends clean", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf([sse("response.created", { response: { id: "resp_1" } }), "data: [DONE]\n\n"], "error"),
        makeRes(out),
        makeSession({ pluginAgent: "dsh" }),
    );
    const wire = out.join("");
    assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1, "terminal delivered exactly once");
    assert.ok(!wire.includes("upstream_stream_truncated"), "no truncation error after [DONE]");
});

test("#4059 responses contrast: cut BEFORE the terminal keeps the in-band error", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(responsesTurn("response.completed").slice(0, 4), "error"), makeRes(out), makeSession({ pluginAgent: "dsh" }));
    const wire = out.join("");
    assert.ok(wire.includes("upstream_stream_truncated"), "genuine cut still signals");
    assert.ok(wire.includes("event: error"), "error event still emitted");
    assert.ok(wire.includes('"classification":"no-terminal-seen"'), "diagnostic stays accurate");
});

test("#4059 responses contrast: malformed terminal frame + read error keeps the in-band error", async () => {
    const events = [
        ...responsesTurn("response.completed").slice(0, 7),
        'data: {"type":"response.complet\n\n',
    ];
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(events, "error"), makeRes(out), makeSession({ pluginAgent: "dsh" }));
    const wire = out.join("");
    assert.ok(wire.includes("upstream_stream_truncated"), "unparseable terminal is not a terminal — signal kept");
    assert.ok(wire.includes('"classification":"no-terminal-seen"'));
});

test("#4059 responses: normal completion + clean EOF unchanged", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(responsesTurn("response.completed")), makeRes(out), makeSession());
    const wire = out.join("");
    assert.ok(wire.includes('"type":"response.completed"'));
    assert.ok(!wire.includes("upstream_stream_truncated"));
    assert.ok(!logs.some((l) => l.includes("terminal already forwarded")), "clean EOF never hits the guarded branch");
});

test("#4059 responses: terminal consumed by empty-turn retry, retry stream cut → signal still fires", async () => {
    // The first attempt ends in a compression-draft closing tag with no
    // function call: retryEmptyTurn consumes the completed frame (client
    // never sees it) and swaps in the refetched stream, which is cut here.
    const first = [
        ...responsesTurn("response.completed").slice(0, 3),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "draft </summary>" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "draft </summary>" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "draft </summary>" } }),
        sse("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "draft </summary>" }] } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed" } }),
    ];
    const out: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(first),
        makeRes(out),
        makeSession({ pluginAgent: "dsh" }),
        logLine,
        async () => failingStream(new Error("terminated")),
    );
    const wire = out.join("");
    assert.ok(logs.some((l) => l.includes("retrying once")), "empty-turn retry took over");
    assert.ok(!wire.includes('"type":"response.completed"'), "consumed terminal never reached the client");
    assert.ok(wire.includes("upstream_stream_truncated"), "a cut retry stream is still a truncation");
});

const DONE = "data: [DONE]\n\n";
const chunk = (fr: string | null, content?: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: fr === null ? (content !== undefined ? { content } : {}) : {}, finish_reason: fr }] })}\n\n`;

test("#4059 openai: read error after forwarded [DONE] → exactly one [DONE], no error frame", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf([chunk(null, "hi"), chunk("stop"), DONE], "error"), res, "openai", makeSession({ pluginAgent: "dsh" }));
    const wire = out.join("");
    assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1, "terminal byte delivered exactly once");
    assert.ok(!wire.includes("upstream_stream_truncated"), "no synthetic error after [DONE]");
    assert.ok(logs.some((l) => l.includes("terminal byte already forwarded")), "guarded catch branch logged");
    assert.equal(res.endedCount, 1);
});

test("#4059 openai contrast: finish reason delivered but [DONE] lost → [DONE] still synthesized", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([chunk(null, "hi"), chunk("stop")], "error"), makeRes(out), "openai", makeSession({ pluginAgent: "dsh" }), logLine);
    const wire = out.join("");
    assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1, "synthesized terminal byte preserved");
    assert.ok(!wire.includes("upstream_stream_truncated"), "finished=true stays silent-completion, not an error");
    assert.ok(logs.some((l) => l.includes("synthesizing missing terminal byte")));
});

test("#4059 openai contrast: cut before any finish reason keeps the in-band error", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([chunk(null, "hi")], "error"), makeRes(out), "openai", makeSession({ pluginAgent: "dsh" }), logLine);
    const wire = out.join("");
    // OpenAI-wire truncation is a top-level `error` object followed by a
    // terminal [DONE] (never an `event: error` line — that's the responses
    // and anthropic wires).
    const errIdx = wire.indexOf('"code":"upstream_stream_truncated"');
    assert.ok(errIdx >= 0, "genuine cut still signals");
    const doneIdx = wire.indexOf("data: [DONE]");
    assert.ok(doneIdx > errIdx, "terminal byte lands after the error frame");
    assert.equal((wire.match(/data: \[DONE\]/g) ?? []).length, 1);
});

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const anthropicFrames = (withStop: boolean) => {
    const frames = [
        ev("message_start", { type: "message_start", message: { id: "msg_a", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 0 } } }),
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
        ev("content_block_stop", { type: "content_block_stop", index: 0 }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 3 } }),
    ];
    if (withStop) frames.push(ev("message_stop", { type: "message_stop" }));
    return frames;
};

test("#4059 anthropic: read error after forwarded message_stop → exactly one message_stop, no error frame", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf(anthropicFrames(true), "error"), res, "anthropic", makeSession({ pluginAgent: "dsh" }));
    const wire = out.join("");
    assert.equal((wire.match(/"type":"message_stop"/g) ?? []).length, 1, "terminal byte delivered exactly once");
    assert.ok(!wire.includes("upstream_stream_truncated"), "no synthetic error after message_stop");
    assert.ok(logs.some((l) => l.includes("terminal byte already forwarded")));
    assert.equal(res.endedCount, 1);
});

test("#4059 anthropic contrast: stop_reason delivered but message_stop lost → message_stop still synthesized", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf(anthropicFrames(false), "error"), makeRes(out), "anthropic", makeSession({ pluginAgent: "dsh" }), logLine);
    const wire = out.join("");
    assert.equal((wire.match(/"type":"message_stop"/g) ?? []).length, 1, "synthesized terminal byte preserved");
    assert.ok(!wire.includes("upstream_stream_truncated"), "finished=true stays silent-completion, not an error");
});

// #4059 review supplement: the google wire's terminator IS its finish-reason
// chunk — pin both gate directions there too (pre-fix, a post-terminator read
// error logged the misleading "truncation signal path" line and built a diag
// although no frame was ever appended).
const gchunk = (c: Record<string, unknown>) => `data: ${JSON.stringify({ candidates: [c] })}\n\n`;

test("#4059 google: read error after forwarded finish-reason chunk ends clean — no synthesized frame", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(
        streamOf([gchunk({ content: { parts: [{ text: "hi" }] } }), gchunk({ content: { parts: [{}] }, finishReason: "STOP" })], "error"),
        res,
        "google",
        makeSession({ pluginAgent: "dsh" }),
    );
    const wire = out.join("");
    assert.ok(wire.includes('"finishReason":"STOP"'), "terminator chunk forwarded");
    assert.ok(!wire.includes('"status":"UNAVAILABLE"'), "no synthesized UNAVAILABLE frame after the terminator");
    assert.ok(!wire.includes("upstream_stream_truncated"), "no truncation signal after the terminator");
    assert.ok(logs.some((l) => l.includes("terminal byte already forwarded")), "guarded catch branch logged");
    assert.equal(res.endedCount, 1);
});

test("#4059 google contrast: cut BEFORE the finish-reason chunk keeps the UNAVAILABLE frame", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([gchunk({ content: { parts: [{ text: "hi" }] } })], "error"), makeRes(out), "google", makeSession({ pluginAgent: "dsh" }), logLine);
    const wire = out.join("");
    assert.ok(wire.includes('"status":"UNAVAILABLE"'), "mid-flight cut still signals");
});
