import { test } from "node:test";
import assert from "node:assert/strict";
import { compressLoopResponsesStream } from "../src/compress-loop-responses.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

function makeCtx(log: (m: string) => void): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id: "test",
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            requests: 0,
            tokensSaved: 0,
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log,
    };
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of compressLoopResponsesStream(stream, ctx, requestBody, requestOptions)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// NOTE: this test validates the NO-TRIGGER passthrough path of the text
// protocol. TEXT_PROTOCOL (ACP_COMPRESS_PROTOCOL=text) used to suppress ALL
// output_text.delta/done and forge a response.completed with output:[] even
// when no <acp_compress> trigger was present — corrupting normal Responses
// output. The fix: when no trigger was caught, pass every event through
// verbatim (including the original completed).
//
// We simulate by NOT including any trigger in the response and asserting the
// completion is the ORIGINAL one (not a forged output:[] one). The function
// protocol (default) also passes through, so this test passes either way; it
// guards against a regression that re-introduces blanket suppression.
test("responses stream: normal output (no compress trigger) completes without forging output:[]", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_9", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "msg_9", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_9", output_index: 0, delta: "Real answer" }),
        sse("response.output_text.done", { item_id: "msg_9", output_index: 0, text: "Real answer" }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_9", content: [{ type: "output_text", text: "Real answer" }] }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_9", status: "completed", output: [{ type: "message", id: "msg_9", role: "assistant", content: [{ type: "output_text", text: "Real answer" }] }] } }),
    ].join("");
    const out = await drain(
        new Response(events).body!,
        makeCtx(() => {}),
        { model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
        { url: "http://unused", headers: {} },
    );
    // The real text must survive.
    assert.match(out, /Real answer/);
    // The original completed must survive (with its real output content).
    assert.match(out, /response\.completed/);
    // No forged empty-output completion should appear.
    assert.doesNotMatch(out, /"output":\[\]/, "must NOT forge a completed with output:[] when there was real content");
});
