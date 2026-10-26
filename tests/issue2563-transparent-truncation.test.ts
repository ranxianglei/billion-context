import { test } from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, transparentTruncationApplies } from "../src/plugin.ts";

// #2563: plugin-lane mid-stream truncation must be HOST-OWNED for permitlist
// hosts (pi) instead of digested into bili's in-band error. Local repro proved
// the mechanism: bare pi classifies a truncated SSE ("stream ended before a
// terminal response event") as transient and re-issues the turn, while bili's
// #721 in-band wording ("ended before a completion event") fell outside pi's
// transient table — so every single cut surfaced as a hard turn failure. The
// fix passes permitlist hosts the raw cut (clean end, nothing synthesized);
// telemetry (log line + diag) is unchanged. Non-permitlist hosts keep the
// legacy in-band signal exactly as before.

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

function makeSession(metadata: Record<string, unknown>): Session {
    return {
        id: "sess-2563",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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
const caseBShape = () => [
    sse("response.created", { response: { id: "resp_1" } }),
    sse("response.in_progress", { response: { id: "resp_1" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
];

test("transparentTruncationApplies: evidence-permitlist gates on metadata.pluginAgent", () => {
    assert.equal(transparentTruncationApplies(makeSession({ pluginAgent: "pi" })), true);
    assert.equal(transparentTruncationApplies(makeSession({ pluginAgent: "dsh" })), false);
    assert.equal(transparentTruncationApplies(makeSession({ pluginAgent: "opencode" })), false);
    assert.equal(transparentTruncationApplies(undefined), false);
    assert.equal(transparentTruncationApplies(makeSession({})), false);
    assert.equal(transparentTruncationApplies(makeSession({ pluginAgent: 7 })), false);
});

test("responses pipe + pi session: clean EOF cut is passed through raw (no in-band frame)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(caseBShape()),
        makeRes(out),
        makeSession({ pluginAgent: "pi" }),
        (m) => logs.push(m),
    );
    const wire = out.join("");
    assert.ok(!wire.includes("upstream_stream_truncated"), "no in-band truncation frame for pi");
    assert.ok(!wire.includes("event: error"), "no synthetic error event");
    // what arrived is delivered verbatim, nothing appended after the last frame
    assert.ok(wire.includes('"type":"response.output_item.added"'));
    // telemetry unchanged: one grep-able line, now tagged as pass-through
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes("passing through raw"), line);
    assert.ok(line!.includes("classification=no-terminal-seen"));
    assert.ok(line!.includes("cause=eof"));
    assert.ok(line!.includes('"events":3'));
});

test("responses pipe + pi session: read-error cut is also passed through raw", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(caseBShape(), "error"),
        makeRes(out),
        makeSession({ pluginAgent: "pi" }),
        (m) => logs.push(m),
    );
    assert.ok(!out.join("").includes("upstream_stream_truncated"), "no in-band frame on read-error either");
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes("passing through raw"), line);
    assert.ok(line!.includes("cause=read-error"), line);
});

test("responses pipe + dsh session: legacy in-band frame preserved (permitlist is opt-in)", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(caseBShape()),
        makeRes(out),
        makeSession({ pluginAgent: "dsh" }),
    );
    const wire = out.join("");
    assert.ok(wire.includes("upstream_stream_truncated"), "dsh still gets the #721 in-band signal");
    assert.ok(wire.includes("event: error"));
});

test("responses pipe + session-less passthrough: legacy in-band frame preserved", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(caseBShape()), makeRes(out));
    assert.ok(out.join("").includes("upstream_stream_truncated"));
});

test("chat pipe (openai) + pi session: clean EOF cut passed through raw, no [DONE] synthesis", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const chunk = (fr: string | null, content?: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: fr === null ? (content !== undefined ? { content } : {}) : {}, finish_reason: fr }] })}\n\n`;
    await pipePluginChatWithStrip(
        streamOf([chunk(null, "hi")]),
        makeRes(out),
        "openai",
        makeSession({ pluginAgent: "pi" }),
        (m) => logs.push(m),
    );
    const wire = out.join("");
    assert.ok(!wire.includes("upstream_stream_truncated"));
    assert.ok(!wire.includes("[DONE]"), "unfinished cut: no synthesized terminator");
    assert.ok(wire.includes('"content":"hi"'), "arrived bytes delivered");
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line?.includes("passing through raw"), line);
});

test("chat pipe (openai) + pi session: finish reason already delivered → terminal byte still synthesized", async () => {
    const out: string[] = [];
    const chunk = (fr: string | null, content?: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: fr === null ? (content !== undefined ? { content } : {}) : {}, finish_reason: fr }] })}\n\n`;
    await pipePluginChatWithStrip(
        streamOf([chunk(null, "hi"), chunk("stop")]),
        makeRes(out),
        "openai",
        makeSession({ pluginAgent: "pi" }),
    );
    const wire = out.join("");
    assert.ok(!wire.includes("upstream_stream_truncated"));
    assert.ok(wire.includes("data: [DONE]"), "protocol completion is synthesis, not error hiding — stays for every host");
});

test("chat pipe (anthropic) + dsh session: legacy in-band frame preserved", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([`event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`]),
        makeRes(out),
        "anthropic",
        makeSession({ pluginAgent: "dsh" }),
    );
    assert.ok(out.join("").includes("upstream_stream_truncated"));
});
