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
