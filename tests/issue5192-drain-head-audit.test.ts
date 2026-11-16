import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

const LT = "\x3c";
const OPEN = `${LT}acp `;
const CLOSE = `${LT}/acp>`;

interface Drop {
    snippet: string;
    duringDrain: boolean;
}

/** Records what the filter reports, keeping the drain flag verbatim so a
 *  missing second argument is observable rather than silently falsy. */
function recorder(): { drops: Drop[]; onDrop: (snippet: string, duringDrain?: boolean) => void } {
    const drops: Drop[] = [];
    return {
        drops,
        onDrop: (snippet: string, duringDrain?: boolean) => {
            drops.push({ snippet, duringDrain: duringDrain === true });
        },
    };
}

function tag(ref: string, tokens = 9): string {
    return `${OPEN}tokens="${tokens}" type="text">${ref}${CLOSE}`;
}

const HEAD = `${LT}acp tokens="12" type="text" time="2026-11-13 17:51:02"`;

test("#5192: a tag head discarded by flush() is reported as a drain drop", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    assert.equal(f.push(`前の文章。${HEAD}`), "前の文章。");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.snippet, HEAD);
    assert.equal(drops[0]!.duringDrain, true);
});

test("#5192: a completed tag strip is not reported as a drain drop", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    assert.equal(f.push(`前の文章。${tag("m00011")}後`), "前の文章。後");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.duringDrain, false);
});

test("#5192: a drain drop is reported even after an earlier strip claimed the one-shot notice", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    assert.equal(f.push(`前の文章。${tag("m00011")}中${HEAD}`), "前の文章。中");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 2, "the drain drop must not be swallowed by the one-shot notice");
    assert.equal(drops[1]!.snippet, HEAD);
    assert.equal(drops[1]!.duringDrain, true);
});

test("#5192: a truncated close tag discarded by flush() is also a drain drop", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    assert.equal(f.push(`前の文章。${LT}/acp`), "前の文章。");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.snippet, `${LT}/acp`);
    assert.equal(drops[0]!.duringDrain, true);
});

test("#5192: the one-shot notice for ordinary strips is unchanged", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    assert.equal(f.push(`前${tag("m00011", 1)}中${tag("m00012", 2)}後`), "前中後");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 1, "only the first ordinary strip is announced");
    assert.equal(drops[0]!.duringDrain, false);
});

test("#5192: a drain drop carries no closing bracket, so it is never mistakable for a full tag", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    f.push(`前の文章。${HEAD}`);
    f.flush();
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.snippet.includes(">"), false);
});

test("#5192: a swallowed tag tail discarded at EOF is reported as a drain drop", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    // A complete opening tag followed by content, but no close: the stream
    // died mid-tag. The opening tag is an ordinary strip; the swallowed tail
    // held at EOF is a drain drop (previously silent).
    assert.equal(f.push(`prose ${LT}acp tokens="12" type="text">m00582`), "prose ");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 2, "the drain drop must not be swallowed by the one-shot notice");
    assert.equal(drops[0]!.duringDrain, false, "the opening tag strip is an ordinary drop");
    assert.equal(drops[1]!.snippet, "m00582");
    assert.equal(drops[1]!.duringDrain, true, "the swallowed tail is a drain drop");
});

test("#5192: a swallowed tag tail drain drop is reported even after an earlier strip claimed the one-shot notice", () => {
    const { drops, onDrop } = recorder();
    const f = createTagEchoFilter(onDrop);
    // An earlier completed tag claims the one-shot strip notice; the swallowed
    // tail of a later unclosed tag is a drain drop (previously silent).
    assert.equal(f.push(`前${tag("m00011")}中${LT}acp tokens="12" type="text">m00582`), "前中");
    assert.equal(f.flush(), "");
    assert.equal(drops.length, 2, "the drain drop must not be swallowed by the one-shot notice");
    assert.equal(drops[1]!.snippet, "m00582");
    assert.equal(drops[1]!.duringDrain, true, "the swallowed tail is a drain drop");
});

function makeSession(): Session {
    return {
        id: "drainsess",
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

function chatChunk(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

test("#5192: the passthrough logs a held head dropped at stream end as a drain drop", async () => {
    const logs: string[] = [];
    setLogCapture((_level, msg) => { logs.push(msg); });
    try {
        const out: string[] = [];
        // The completed tag claims the one-shot strip notice; the head held at
        // EOF is the second drop of the response and used to leave no line.
        const events: string[] = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: `前の文章。${tag("m00042")}中` }),
            chatChunk({ content: `後${HEAD}` }),
            "data: [DONE]\n\n",
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession());

        const tagLines = logs.filter((l) => l.includes("[tag-echo]"));
        const stripLines = tagLines.filter((l) => l.includes("stripped model-emitted render tag"));
        const drainLines = tagLines.filter((l) => l.includes("held head dropped during drain"));
        assert.equal(stripLines.length, 1, `expected one strip line, got: ${tagLines.join(" | ")}`);
        assert.equal(drainLines.length, 1, `expected one drain line, got: ${tagLines.join(" | ")}`);
        assert.ok(drainLines[0]!.includes("2026-11-13 17:51:02"), "the drained head itself is named in the line");
        const text = out.join("");
        assert.ok(!text.includes("m00042"), "the completed tag never reaches the client");
        assert.ok(text.includes("前の文章。") && text.includes("中") && text.includes("後"), "prose around the tag survives");
    } finally {
        setLogCapture(null);
    }
});
