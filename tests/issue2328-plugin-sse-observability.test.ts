import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, type PluginPipeDiag } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #2328: plugin-lane stream-termination observability — Q1 raw-SSE capture
// (dumpSse tee), Q2 termination metadata in the truncation error frame,
// Q4 classification of why the terminal was never seen. Harness mirrors
// tests/issue2171-zero-byte-truncation-retry.test.ts.

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

function respEvent(type: string, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ type, ...extra })}\n\n`;
}

function chatChunk(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";
const TRUNC_SENTINEL = "upstream_stream_truncated";

async function runChat(frames: string[], diag?: PluginPipeDiag): Promise<{ body: string; logs: string[] }> {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf(frames), makeRes(out), "openai", makeSession(),
        (m) => logs.push(m), undefined, undefined, undefined, undefined, diag,
    );
    return { body: out.join(""), logs };
}

async function runResponses(frames: string[], diag?: PluginPipeDiag): Promise<{ body: string; logs: string[] }> {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(frames), makeRes(out), makeSession(),
        (m) => logs.push(m), undefined, undefined, undefined, undefined, diag,
    );
    return { body: out.join(""), logs };
}

function capturingDump(): { diag: PluginPipeDiag; name: () => string; bytes: () => string; done: Promise<void> } {
    let name = "";
    let text = "";
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const diag: PluginPipeDiag = {
        dumpSse: (n, stream) => {
            name = n;
            const reader = stream.getReader();
            const parts: Uint8Array[] = [];
            void (async () => {
                for (;;) {
                    const r = await reader.read();
                    if (r.done) break;
                    if (r.value) parts.push(r.value);
                }
                text = new TextDecoder().decode(Buffer.concat(parts));
                resolveDone();
            })();
        },
    };
    return { diag, name: () => name, bytes: () => text, done };
}

interface TruncParsed {
    code?: unknown;
    diagnostics?: Record<string, unknown>;
    error?: { code?: unknown; diagnostics?: Record<string, unknown> };
}

function truncFrame(body: string): TruncParsed {
    const line = body.split("\n").find((l) => l.startsWith("data: ") && l.includes(TRUNC_SENTINEL));
    assert.ok(line, `truncation frame present in body:\n${body}`);
    return JSON.parse(line!.slice(line!.indexOf("{"))) as TruncParsed;
}

test("Q1: chat pipe tees the raw upstream SSE to the dump callback (#2328)", async () => {
    const cap = capturingDump();
    const { body } = await runChat([chatChunk({ role: "assistant", content: "hi" }), DONE], cap.diag);
    await cap.done;
    assert.ok(cap.name().endsWith("-testsess-plugin-chat-raw.sse"), `dump filename got: ${cap.name()}`);
    assert.ok(cap.bytes().includes('"content":"hi"'), "dump captured the raw upstream bytes");
    assert.ok(body.includes("[DONE]"), "parse branch still delivered the turn");
});

test("Q1: responses pipe tees the raw upstream SSE to the dump callback (#2328)", async () => {
    const cap = capturingDump();
    await runResponses([respEvent("response.created"), respEvent("response.completed")], cap.diag);
    await cap.done;
    assert.ok(cap.name().endsWith("-testsess-plugin-responses-raw.sse"), `dump filename got: ${cap.name()}`);
    assert.ok(cap.bytes().includes('"response.completed"'), "dump captured the raw upstream bytes");
});

test("Q1: without a dumpSse callback the pipe consumes the stream as before (#2328)", async () => {
    const { body } = await runResponses([respEvent("response.created"), respEvent("response.completed")]);
    assert.ok(!body.includes(TRUNC_SENTINEL), "clean stream stays clean");
});

test("Q2: responses truncation frame carries termination metadata (#2328)", async () => {
    const diag: PluginPipeDiag = { upstreamStatus: 502, upstreamContentType: "text/event-stream" };
    const { body, logs } = await runResponses(
        [respEvent("response.created"), respEvent("response.output_text.delta", { delta: "hello" })],
        diag,
    );
    const d = truncFrame(body).diagnostics!;
    assert.equal(d.upstreamStatus, 502);
    assert.equal(d.upstreamContentType, "text/event-stream");
    assert.equal(d.sawTerminal, false);
    assert.equal(d.classification, "missing-terminal");
    assert.ok((d.chunksReceived as number) >= 1, "chunk count present");
    assert.ok((d.bytesReceived as number) > 0, "byte count present");
    assert.equal(d.unparsedFrames, 0);
    assert.equal(typeof d.retryNote, "string", "retry disposition present");
    assert.ok(logs.some((l) => l.includes("class=missing-terminal")), "classification logged");
});

test("Q2: chat(openai) truncation frame nests diagnostics under error (#2328)", async () => {
    const diag: PluginPipeDiag = { upstreamStatus: 500, upstreamContentType: "text/event-stream" };
    const { body } = await runChat([chatChunk({ role: "assistant", content: "partial" })], diag);
    const p = truncFrame(body);
    assert.equal(p.error?.code, TRUNC_SENTINEL);
    const d = p.error!.diagnostics!;
    assert.equal(d.upstreamStatus, 500);
    assert.equal(d.classification, "missing-terminal");
});

test("Q4: unparseable frame classifies as unrecognized-terminal (#2328)", async () => {
    const { body } = await runResponses([respEvent("response.created"), "data: {broken json\n\n"]);
    const d = truncFrame(body).diagnostics!;
    assert.equal(d.classification, "unrecognized-terminal");
    assert.equal(d.unparsedFrames, 1);
    assert.equal(d.sawTerminal, false);
});

test("Q4: dangling partial frame classifies as incomplete-trailing-event (#2328)", async () => {
    // Deliberately unterminated (no trailing blank line) so it survives in buf at EOF.
    const { body } = await runResponses([
        respEvent("response.created"),
        'data: {"type":"response.output_text.delta","delta":"hi"}',
    ]);
    const d = truncFrame(body).diagnostics!;
    assert.equal(d.classification, "incomplete-trailing-event");
    assert.ok((d.residualBufferLen as number) > 0, "residual buffer length present");
    assert.equal(d.unparsedFrames, 0);
});

test("Q4: clean EOF with no terminal classifies as missing-terminal (#2328)", async () => {
    const { body } = await runResponses([respEvent("response.created"), respEvent("response.output_text.delta", { delta: "hello" })]);
    const d = truncFrame(body).diagnostics!;
    assert.equal(d.classification, "missing-terminal");
    assert.equal(d.unparsedFrames, 0);
    assert.equal(d.residualBufferLen, 0);
});

test("Q2/Q4: classification is always-on; upstream status only when diag provides it (#2328)", async () => {
    const { body } = await runResponses([respEvent("response.created")]);
    const d = truncFrame(body).diagnostics!;
    assert.equal(d.classification, "missing-terminal");
    assert.equal(d.upstreamStatus, undefined);
    assert.equal(d.upstreamContentType, undefined);
});
