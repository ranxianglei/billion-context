import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteResponsesSseStream, rewriteResponsesJsonResponse } from "../src/stream-responses.ts";
import type { RewriteCtx } from "../src/stream.ts.ts";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";

function makeCtx(): RewriteCtx {
    const session: Session = {
        id: "s1",
        state: createInitialState(),
        createdAt: Date.now(),
        requests: 0,
        blockContents: new Map(),
    };
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session,
        log: () => {},
        debug: false,
    } as unknown as RewriteCtx;
}

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function drain(stream: AsyncGenerator<Buffer>): Promise<string> {
    let out = "";
    for await (const chunk of stream) out += chunk.toString("utf8");
    return out;
}

/** Extract all output_text delta payloads from the SSE stream, concatenated. */
function collectDeltas(sseOut: string): string {
    const deltas: string[] = [];
    for (const block of sseOut.split("\n\n")) {
        const dl = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dl) continue;
        try {
            const obj = JSON.parse(dl.slice(5).trim());
            if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
                deltas.push(obj.delta);
            }
        } catch {
            /* skip */
        }
    }
    return deltas.join("");
}

test("stream: echoed <acp> tag in a single delta is stripped", async () => {
    const events = [
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: 'before <acp tokens="44" type="text">m00015</acp> after' }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    const out = await drain(rewriteResponsesSseStream(new Response(events.join("")).body!, makeCtx()));
    assert.equal(collectDeltas(out), "before  after");
});

test("stream: tag split across multiple deltas is stripped", async () => {
    const events = [
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hi <acp to" }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: 'kens="44" type="text">m00015</acp> bye' }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    const out = await drain(rewriteResponsesSseStream(new Response(events.join("")).body!, makeCtx()));
    assert.equal(collectDeltas(out), "hi  bye");
});

test("stream: partial open marker at delta boundary is held, then emitted if not a tag", async () => {
    const events = [
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "text <ac" }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "cept list" }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    const out = await drain(rewriteResponsesSseStream(new Response(events.join("")).body!, makeCtx()));
    assert.equal(collectDeltas(out), "text <accept list");
});

test("stream: <acp_compress> trigger markers are NOT stripped (different format)", async () => {
    const events = [
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "ok <acp_compress>{}</acp_compress> done" }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    const out = await drain(rewriteResponsesSseStream(new Response(events.join("")).body!, makeCtx()));
    // The text-protocol trigger passes through in function mode (it's only
    // intercepted when ACP_COMPRESS_PROTOCOL=text). The key assertion is that
    // the stripper does not treat it as an injected metadata tag.
    assert.ok(collectDeltas(out).includes("<acp_compress>"));
});

test("non-stream: echoed tags stripped from output_text even without compress", () => {
    const ctx = makeCtx();
    const body = {
        id: "resp_1",
        status: "completed",
        output: [
            {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: 'see <acp tokens="44" type="text">m00015</acp> here' }],
            },
        ],
    };
    const out = rewriteResponsesJsonResponse(body, ctx) as typeof body;
    assert.equal(out.output[0].content[0].text, "see  here");
});

test("non-stream: normal text with no tags is unchanged", () => {
    const ctx = makeCtx();
    const body = {
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello world" }] }],
    };
    const out = rewriteResponsesJsonResponse(body, ctx) as typeof body;
    assert.equal(out.output[0].content[0].text, "hello world");
});
