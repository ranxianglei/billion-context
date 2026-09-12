import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { resetWeakOverflow } from "../src/weak-overflow.ts";
import type { Session } from "../src/session.ts";

const SID = "plug-trunc-test";

function makeSession(): Session {
    return {
        id: SID,
        metadata: { effectiveContextLimit: 100000 },
        stats: { lastInputTokens: 95000 },
    } as unknown as Session;
}

function makeRes() {
    const chunks: string[] = [];
    return {
        res: {
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
        } as unknown as import("node:http").ServerResponse,
        chunks,
    };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(enc.encode(chunks[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

beforeEach(() => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    resetWeakOverflow(SID);
});

function learnedOf(session: Session): number | undefined {
    return (session.metadata as { learnedContextLimit?: number }).learnedContextLimit;
}

test("chat pipe: 3 truncated streams at high usage learn a conservative window", async () => {
    let session = makeSession();
    for (let i = 0; i < 3; i++) {
        const { res } = makeRes();
        session = makeSession();
        await pipePluginChatWithStrip(streamOf([chatChunk({ content: "hi" })]), res, "openai", session);
    }
    assert.equal(learnedOf(session), 95000, "learned the failing input size after the 3rd truncation");
});

test("chat pipe: a [DONE]-terminated stream never arms the signal", async () => {
    let session = makeSession();
    for (let i = 0; i < 5; i++) {
        const { res } = makeRes();
        session = makeSession();
        await pipePluginChatWithStrip(streamOf([chatChunk({ content: "hi" }), DONE]), res, "openai", session);
    }
    assert.equal(learnedOf(session), undefined);
});

test("chat pipe (anthropic): message_stop terminates, no signal", async () => {
    let session = makeSession();
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 95000 } } })}\n\n`;
    const stop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    for (let i = 0; i < 5; i++) {
        const { res } = makeRes();
        session = makeSession();
        await pipePluginChatWithStrip(streamOf([start, stop]), res, "anthropic", session);
    }
    assert.equal(learnedOf(session), undefined);
});

test("responses pipe: stream without a done-family event arms the signal", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`;
    let session = makeSession();
    for (let i = 0; i < 3; i++) {
        const { res } = makeRes();
        session = makeSession();
        await pipePluginResponsesWithStrip(streamOf([delta]), res, session);
    }
    assert.equal(learnedOf(session), 95000);
});

test("responses pipe: response.completed terminates, no signal", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`;
    const completed = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 95000 } } })}\n\n`;
    let session = makeSession();
    for (let i = 0; i < 5; i++) {
        const { res } = makeRes();
        session = makeSession();
        await pipePluginResponsesWithStrip(streamOf([delta, completed]), res, session);
    }
    assert.equal(learnedOf(session), undefined);
});

// #721: a plugin-mode stream that ends without a terminal event must hand the
// client a well-formed end of stream (synthesized terminal byte or in-band
// error event) instead of a bare cut-off SSE.

const TRUNC_MARKER = "upstream_stream_truncated";

function failingStream(chunks: string[], err: Error): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(enc.encode(chunks[i]));
                i += 1;
            } else {
                controller.error(err);
            }
        },
    });
}

test("#721 chat pipe (openai): mid-generation cut emits in-band error frame + [DONE]", async () => {
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([chatChunk({ content: "partial" })]), res, "openai", makeSession());
    const out = chunks.join("");
    assert.ok(out.includes('"content":"partial"'), "partial content still forwarded");
    const errIdx = out.indexOf(TRUNC_MARKER);
    const doneIdx = out.indexOf("data: [DONE]");
    assert.ok(errIdx !== -1, "in-band error frame emitted");
    assert.ok(doneIdx !== -1 && doneIdx > errIdx, "[DONE] terminates the stream after the error frame");
    assert.ok(out.includes(`"type":"server_error"`), "error frame carries the server_error type");
});

test("#721 chat pipe (openai): finish_reason seen, [DONE] lost → bare [DONE] synthesized, no error", async () => {
    const finish = `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([chatChunk({ content: "done turn" }), finish]), res, "openai", makeSession());
    const out = chunks.join("");
    assert.ok(!out.includes(TRUNC_MARKER), "no error frame when a finish reason was delivered");
    assert.ok(out.endsWith("data: [DONE]\n\n"), "missing terminal byte synthesized");
});

test("#721 chat pipe (anthropic): stop_reason seen, message_stop lost → message_stop synthesized, no error", async () => {
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 95000 } } })}\n\n`;
    const mdelta = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`;
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([start, mdelta]), res, "anthropic", makeSession());
    const out = chunks.join("");
    assert.ok(!out.includes(TRUNC_MARKER), "no error event when stop_reason was delivered");
    assert.ok(out.endsWith(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`), "missing message_stop synthesized");
});

test("#721 chat pipe (anthropic): cut before stop_reason → in-band error event", async () => {
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 95000 } } })}\n\n`;
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([start]), res, "anthropic", makeSession());
    const out = chunks.join("");
    const errIdx = out.indexOf(TRUNC_MARKER);
    assert.ok(errIdx !== -1, "in-band error event emitted");
    const evIdx = out.indexOf("event: error");
    assert.ok(evIdx !== -1 && evIdx < errIdx, "delivered on the Anthropic error event channel");
});

test("#721 chat pipe (openai): upstream read failure emits in-band error instead of rethrowing", async () => {
    const { res, chunks } = makeRes();
    await assert.doesNotReject(
        pipePluginChatWithStrip(failingStream([chatChunk({ content: "partial" })], new Error("other side closed")), res, "openai", makeSession()),
    );
    const out = chunks.join("");
    assert.ok(out.includes('"content":"partial"'), "partial content still forwarded before the failure");
    const errIdx = out.indexOf(TRUNC_MARKER);
    const doneIdx = out.lastIndexOf("data: [DONE]");
    assert.ok(errIdx !== -1, "in-band error frame emitted");
    assert.ok(doneIdx > errIdx, "[DONE] terminates the stream after the error frame");
});

test("#721 chat pipe (openai): read failure AFTER finish_reason → bare [DONE], no error", async () => {
    const finish = `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    const { res, chunks } = makeRes();
    await assert.doesNotReject(
        pipePluginChatWithStrip(failingStream([chatChunk({ content: "x" }), finish], new Error("socket hang up")), res, "openai", makeSession()),
    );
    const out = chunks.join("");
    assert.ok(!out.includes(TRUNC_MARKER));
    assert.ok(out.endsWith("data: [DONE]\n\n"));
});

test("#721 responses pipe: mid-stream cut emits in-band error event instead of bare close", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`;
    const { res, chunks } = makeRes();
    await pipePluginResponsesWithStrip(streamOf([delta]), res, makeSession());
    const out = chunks.join("");
    const errIdx = out.indexOf(TRUNC_MARKER);
    assert.ok(errIdx !== -1, "in-band error event emitted");
    const evIdx = out.indexOf("event: error");
    assert.ok(evIdx !== -1 && evIdx < errIdx, "delivered on the Responses error event channel");
});

test("#721 responses pipe: upstream read failure emits in-band error instead of rethrowing", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`;
    const { res, chunks } = makeRes();
    await assert.doesNotReject(pipePluginResponsesWithStrip(failingStream([delta], new Error("fetch failed")), res, makeSession()));
    const out = chunks.join("");
    assert.ok(out.includes('"delta":"hello"'));
    assert.ok(out.indexOf(TRUNC_MARKER) !== -1);
});

test("#721 chat pipe: client abort suppresses the synthesized terminal/error", async () => {
    const { res, chunks } = makeRes();
    res.destroyed = true;
    await pipePluginChatWithStrip(streamOf([chatChunk({ content: "x" })]), res, "openai", makeSession());
    assert.ok(!chunks.join("").includes(TRUNC_MARKER), "no in-band error for a gone client");
});

test("#721 responses pipe: client abort suppresses the synthesized terminal/error", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`;
    const { res, chunks } = makeRes();
    res.destroyed = true;
    await pipePluginResponsesWithStrip(failingStream([delta], new Error("aborted")), res, makeSession());
    assert.ok(!chunks.join("").includes(TRUNC_MARKER), "no in-band error for a gone client");
});

test("#721 chat pipe: no session (#460 non-injected branch) still gets the in-band error", async () => {
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([chatChunk({ content: "x" })]), res, "openai");
    const out = chunks.join("");
    assert.ok(out.includes(TRUNC_MARKER));
    assert.ok(out.includes("data: [DONE]"));
});

// #721 review: a cut landing MID-EVENT leaves a dangling partial SSE line in
// the pipe's buffer. SSE joins every `data:` line inside one blank-line-
// delimited block, so writing that fragment before the synthesized signal
// fuses the two into a single malformed frame (corrupting the signal). The
// fragment must be dropped — matching the responses pipe, which never writes
// raw buf. These assert every emitted data payload is standalone-parseable.
function sseDataEvents(out: string): string[] {
    return out.split("\n\n").filter((b) => b.trim().length > 0).map((block) =>
        block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"),
    );
}

const PARTIAL_CHUNK = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "tial" }, finish_reason: null }] })}`; // NO trailing \n\n

test("#721 review (openai, EOF): mid-event cut drops the dangling fragment; signal stays well-formed", async () => {
    const { res, chunks } = makeRes();
    await pipePluginChatWithStrip(streamOf([chatChunk({ content: "par" }), PARTIAL_CHUNK]), res, "openai", makeSession());
    const out = chunks.join("");
    assert.ok(!out.includes("tial"), "dangling partial event must be dropped, not fused into the signal");
    for (const ev of sseDataEvents(out)) {
        if (ev === "[DONE]") continue;
        JSON.parse(ev);
    }
    assert.ok(sseDataEvents(out).some((ev) => ev.includes(TRUNC_MARKER)), "error frame still delivered as its own event");
});

test("#721 review (openai, read failure): mid-event cut drops the dangling fragment; signal stays well-formed", async () => {
    const { res, chunks } = makeRes();
    await assert.doesNotReject(
        pipePluginChatWithStrip(failingStream([chatChunk({ content: "par" }), PARTIAL_CHUNK], new Error("other side closed")), res, "openai", makeSession()),
    );
    const out = chunks.join("");
    assert.ok(!out.includes("tial"), "dangling partial event must be dropped on the read-failure path too");
    for (const ev of sseDataEvents(out)) {
        if (ev === "[DONE]") continue;
        JSON.parse(ev);
    }
    assert.ok(sseDataEvents(out).some((ev) => ev.includes(TRUNC_MARKER)), "error frame still delivered as its own event");
});
