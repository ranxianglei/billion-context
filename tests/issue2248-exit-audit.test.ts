// #2248: every raw-forward exit of the plugin pipes must leave a trace when it
// carries echo-residue-shaped bytes — otherwise a leak through an unmanaged
// field is invisible in the log (the zero-log leak class from #2190). The suite
// pins the exit audits on all wires (openai E1/E5 + parse-fail, anthropic
// non-delta / unmanaged-delta, google non-candidates / tail fallthrough,
// responses unrecognized-type + parse-fail). Every audited frame must ALSO stay
// byte-exact (#1039 wire fidelity) and argument frames must stay excluded.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";

// Matches containsEchoResidue (/m\d{4,}\s*<\/[A-Za-z]/) but ends in plain prose
// so the tag-head/tail heuristics stay quiet on managed-field fast paths.
const RESIDUE = "m1234 </p> trailing prose";

const DONE = "data: [DONE]\n\n";
const noRefetch = () => Promise.resolve(null);

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

async function runChat(frames: string[], protocol: "openai" | "anthropic" | "google"): Promise<{ out: string; rawForwardWarns: number }> {
    const out: string[] = [];
    const warns: string[] = [];
    setLogCapture((level, msg) => {
        if (level === "warn") warns.push(msg);
    });
    try {
        await pipePluginChatWithStrip(streamOf(frames), makeRes(out), protocol, makeSession(), undefined, noRefetch);
    } finally {
        setLogCapture(null);
    }
    return { out: out.join(""), rawForwardWarns: warns.filter((m) => m.includes("raw forward carried")).length };
}

async function runResponses(frames: string[]): Promise<{ out: string; rawForwardWarns: number }> {
    const out: string[] = [];
    const warns: string[] = [];
    setLogCapture((level, msg) => {
        if (level === "warn") warns.push(msg);
    });
    try {
        await pipePluginResponsesWithStrip(streamOf(frames), makeRes(out), makeSession(), undefined, noRefetch);
    } finally {
        setLogCapture(null);
    }
    return { out: out.join(""), rawForwardWarns: warns.filter((m) => m.includes("raw forward carried")).length };
}

const finOpenai = `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;

test("#2248 openai E1: no-choices frame carrying residue is audited and forwarded verbatim", async () => {
    const frame = `data: ${JSON.stringify({ id: "x", message: { role: "assistant", content: RESIDUE } })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 1, "exactly one raw-forward audit warn");
    assert.equal(out, frame + finOpenai + DONE, "bytes forwarded exactly as received");
});

test("#2248 openai E5: delta with unmanaged text field is audited and forwarded verbatim", async () => {
    const frame = `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { text: RESIDUE }, finish_reason: null }] })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, frame + finOpenai + DONE);
});

test("#2248 openai E5 exclusion: tool_calls argument frames are NOT audited (#1039)", async () => {
    const frame = `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `"${RESIDUE}"` } }] }, finish_reason: null }] })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 0, "argument bytes never flagged");
    assert.equal(out, frame + finOpenai + DONE);
});

test("#2248 openai negative control: clean role-only frame produces no audit warn", async () => {
    const frame = `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 0);
    assert.equal(out, frame + finOpenai + DONE);
});

test("#2248 anthropic non-delta exit: message_start-shaped frame with residue is audited verbatim", async () => {
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", content: [{ type: "text", text: RESIDUE }] } })}\n\n`;
    const stop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const { out, rawForwardWarns } = await runChat([start, stop], "anthropic");
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, start + stop);
});

test("#2248 anthropic unmanaged-delta exit: citation_delta residue is audited verbatim", async () => {
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "citation_delta", citation: RESIDUE } })}\n\n`;
    const stop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const { out, rawForwardWarns } = await runChat([delta, stop], "anthropic");
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, delta + stop);
});

test("#2248 anthropic input_json_delta exclusion: argument fragments are NOT audited (#1039)", async () => {
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: RESIDUE } })}\n\n`;
    const stop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const { out, rawForwardWarns } = await runChat([delta, stop], "anthropic");
    assert.equal(rawForwardWarns, 0, "argument bytes never flagged");
    assert.equal(out, delta + stop);
});

test("#2248 google non-candidates exit: usage-shaped frame with residue is audited verbatim", async () => {
    const frame = `data: ${JSON.stringify({ modelVersion: "gm", usageMetadata: { promptTokenCount: 1 }, note: RESIDUE })}\n\n`;
    const fin = `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, fin], "google");
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, frame + fin);
});

test("#2248 google tail fallthrough: text-only parts frame with residue is audited verbatim", async () => {
    const frame = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: RESIDUE }] } }] })}\n\n`;
    const fin = `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`;
    const { out, rawForwardWarns } = await runChat([frame, fin], "google");
    assert.ok(rawForwardWarns >= 1, "exit-level audit fired");
    assert.equal(out, frame + fin);
});

test("#2248 chat parse-fail: unparseable frame with residue is audited and forwarded verbatim", async () => {
    const bad = `data: {"choices":[{"delta":{"content":"${RESIDUE}"\n\n`;
    const { out, rawForwardWarns } = await runChat([bad, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, bad + finOpenai + DONE);
});

test("#2248 chat parse-fail negative control: unparseable clean frame produces no audit warn", async () => {
    const bad = `data: {"foo": \n\n`;
    const { out, rawForwardWarns } = await runChat([bad, finOpenai, DONE], "openai");
    assert.equal(rawForwardWarns, 0);
    assert.equal(out, bad + finOpenai + DONE);
});

const completedResponses = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed" } })}\n\n`;

test("#2248 responses unrecognized-type exit: vendor event with residue is audited verbatim", async () => {
    const ev = `data: ${JSON.stringify({ type: "response.vendor_debug_event", detail: RESIDUE })}\n\n`;
    const { out, rawForwardWarns } = await runResponses([ev, completedResponses]);
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, ev + completedResponses);
});

test("#2248 responses argument-stream exclusion: custom_tool_call_input.delta is NOT audited (#1039)", async () => {
    const ev = `data: ${JSON.stringify({ type: "response.custom_tool_call_input.delta", item_id: "ci1", output_index: 0, delta: RESIDUE })}\n\n`;
    const { out, rawForwardWarns } = await runResponses([ev, completedResponses]);
    assert.equal(rawForwardWarns, 0, "argument bytes never flagged");
    assert.equal(out, ev + completedResponses);
});

test("#2248 responses parse-fail: unparseable frame with residue is audited and forwarded verbatim", async () => {
    const bad = `data: {"type":"response.output_text.delta","delta":"${RESIDUE}"\n\n`;
    const { out, rawForwardWarns } = await runResponses([bad, completedResponses]);
    assert.equal(rawForwardWarns, 1);
    assert.equal(out, bad + completedResponses);
});
