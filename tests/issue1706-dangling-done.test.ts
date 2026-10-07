import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";
import type http from "node:http";

// #1706: an upstream that emits its final `data: [DONE]` without the
// terminating blank line (and omits finish_reason) used to be reported as a
// truncated turn even though the completion marker arrived. Those streams are
// now recognized as complete at EOF; genuine cuts must STILL be reported.

const TRUNC_MSG = "upstream stream ended before a completion event; this turn may be incomplete";

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
    } as unknown as http.ServerResponse;
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

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

async function run(events: string[]): Promise<{ out: string; logs: string[] }> {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), (m) => logs.push(m));
    return { out: out.join(""), logs };
}

test("#1706: final [DONE] missing only its terminating blank line is complete, not truncated", async () => {
    const { out, logs } = await run([
        chatChunk({ role: "assistant" }),
        chatChunk({ content: "hello" }),
        "data: [DONE]\n",
    ]);
    assert.ok(!out.includes("upstream_stream_truncated"), `no error frame, got: ${out}`);
    assert.ok(!logs.some((l) => l.includes("emitting in-band error")), `no truncation log, got: ${JSON.stringify(logs)}`);
    assert.ok(out.endsWith("data: [DONE]\n\n"), `forwarded terminated sentinel, got tail: ${JSON.stringify(out.slice(-40))}`);
});

test("#1706: bare [DONE] with no newlines at all is still the completion marker", async () => {
    const { out, logs } = await run([
        chatChunk({ role: "assistant" }),
        chatChunk({ content: "hello" }),
        "data: [DONE]",
    ]);
    assert.ok(!out.includes("upstream_stream_truncated"), `no error frame, got: ${out}`);
    assert.ok(!logs.some((l) => l.includes("emitting in-band error")));
    assert.ok(out.endsWith("data: [DONE]\n\n"), `terminated sentinel restored, got tail: ${JSON.stringify(out.slice(-40))}`);
});

test("#1706: [DONE] without the space after the colon is normalized like the in-stream form", async () => {
    const { out } = await run([
        chatChunk({ content: "hi" }),
        "data:[DONE]\n",
    ]);
    assert.ok(!out.includes("upstream_stream_truncated"), `no error frame, got: ${out}`);
    assert.ok(out.endsWith("data:[DONE]\n\n"), `sentinel forwarded verbatim + terminator, got tail: ${JSON.stringify(out.slice(-40))}`);
});

test("#1706 control: finish_reason delivered with no [DONE] at all stays on the silent-synthesis path", async () => {
    const { out, logs } = await run([
        chatChunk({ content: "done" }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]);
    assert.ok(!out.includes("upstream_stream_truncated"), `no error frame, got: ${out}`);
    assert.ok(logs.some((l) => l.includes("synthesizing missing terminal byte")), `synthesis log expected, got: ${JSON.stringify(logs)}`);
    assert.ok(out.endsWith("data: [DONE]\n\n"), `got tail: ${JSON.stringify(out.slice(-40))}`);
});

test("#1706 control: genuine mid-stream cut still emits the in-band truncation signal + forensics log", async () => {
    const sink: string[] = [];
    setLogCapture((_level, msg) => sink.push(msg));
    let result: { out: string; logs: string[] };
    try {
        result = await run([
            chatChunk({ role: "assistant" }),
            chatChunk({ content: "hel" }),
        ]);
    } finally {
        setLogCapture(null);
    }
    assert.ok(result.out.includes("upstream_stream_truncated"), `error frame expected, got: ${result.out}`);
    assert.ok(result.out.includes(TRUNC_MSG), `message expected, got: ${result.out}`);
    assert.ok(result.logs.some((l) => l.includes("emitting in-band error")), `got: ${JSON.stringify(result.logs)}`);
    assert.ok(result.out.endsWith("data: [DONE]\n\n"), `client still gets a terminal, got tail: ${JSON.stringify(result.out.slice(-40))}`);
    // #1706 forensics: bytes/elapsed/silence since last byte name the cutting hop's idle budget.
    const forensic = sink.filter((l) => l.includes("upstream stream ended without terminal (openai)"));
    assert.equal(forensic.length, 1, `one forensics line, got: ${JSON.stringify(forensic)}`);
    assert.match(forensic[0], /\d+B in \d+ms, last byte \d+ms ago — emitting in-band truncation signal \(#721\)/, forensic[0]);
});

test("#1706 control: upstream read failure still emits the signal and logs the error with forensics", async () => {
    const enc = new TextEncoder();
    const events = [chatChunk({ role: "assistant" })];
    let i = 0;
    const cutStream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                throw new Error("terminated");
            }
        },
    });
    const out: string[] = [];
    const logs: string[] = [];
    const sink: string[] = [];
    setLogCapture((_level, msg) => sink.push(msg));
    try {
        await pipePluginChatWithStrip(cutStream, makeRes(out), "openai", makeSession(), (m) => logs.push(m));
    } finally {
        setLogCapture(null);
    }
    const joined = out.join("");
    assert.ok(joined.includes("upstream_stream_truncated"), `error frame expected, got: ${joined}`);
    assert.ok(logs.some((l) => l.includes("emitting in-band error")), `got: ${JSON.stringify(logs)}`);
    const forensic = sink.filter((l) => l.includes("upstream stream read failed (openai): terminated;"));
    assert.equal(forensic.length, 1, `one forensics line, got: ${JSON.stringify(sink)}`);
    assert.match(forensic[0], /\d+B in \d+ms, last byte \d+ms ago — emitting in-band truncation signal \(#721\)/, forensic[0]);
});

test("#1706 control: a dangling block carrying more than one data line is NOT recognized as [DONE]", async () => {
    const { out } = await run([
        chatChunk({ content: "x" }),
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: null }] })}`,
        "\ndata: [DONE]",
    ]);
    assert.ok(out.includes("upstream_stream_truncated"), `conservative error frame expected, got: ${out}`);
});

test("#1706 control: a sentinel cut mid-token is NOT recognized as [DONE]", async () => {
    const { out } = await run([
        chatChunk({ content: "x" }),
        "data: [DO\n",
    ]);
    assert.ok(out.includes("upstream_stream_truncated"), `partial sentinel must stay on the truncation path, got: ${out}`);
});

test("#1706 control: properly terminated [DONE] remains clean", async () => {
    const { out, logs } = await run([
        chatChunk({ content: "ok" }),
        "data: [DONE]\n\n",
    ]);
    assert.ok(!out.includes("upstream_stream_truncated"), `got: ${out}`);
    assert.ok(!logs.some((l) => l.includes("truncated")), `got: ${JSON.stringify(logs)}`);
});
