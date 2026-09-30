import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

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

const DONE = "data: [DONE]\n\n";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

interface Frame {
    obj: Record<string, unknown> | null;
    done: boolean;
}

function parseFrames(text: string): Frame[] {
    const frames: Frame[] = [];
    for (const block of text.split("\n\n")) {
        if (!block.trim()) continue;
        const payload = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (payload === "[DONE]") {
            frames.push({ obj: null, done: true });
            continue;
        }
        let obj: Record<string, unknown> | null = null;
        try {
            obj = JSON.parse(payload) as Record<string, unknown>;
        } catch {
            assert.fail(`non-JSON SSE payload leaked to client: ${payload}`);
        }
        frames.push({ obj, done: false });
    }
    return frames;
}

function firstChoice(f: Frame): Record<string, unknown> | undefined {
    if (!f.obj) return undefined;
    const choices = f.obj["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const c = choices[0];
    return c && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
}

function finishReason(f: Frame): string | undefined {
    if (!f.obj) return undefined;
    const choices = f.obj["choices"];
    if (!Array.isArray(choices)) return undefined;
    for (const c of choices) {
        if (c && typeof c === "object") {
            const fr = (c as Record<string, unknown>)["finish_reason"];
            if (typeof fr === "string") return fr;
        }
    }
    return undefined;
}

/** The OpenCode 2.0.18 consumer contract (#1546): once a frame has carried
 *  finish_reason, no LATER frame may carry a non-empty text delta. The finish
 *  frame itself may carry its own (final) content — only frames after it may
 *  not. */
function assertNoContentAfterFinish(text: string): void {
    let finished = false;
    for (const f of parseFrames(text)) {
        if (f.done) break;
        if (finished) {
            const c = firstChoice(f);
            const d = c?.["delta"];
            if (d && typeof d === "object") {
                for (const k of ["content", "reasoning_content", "reasoning"]) {
                    const v = (d as Record<string, unknown>)[k];
                    assert.equal(typeof v === "string" ? v : "", "", `no ${k} delta after finish_reason`);
                }
            }
        }
        if (finishReason(f) !== undefined) finished = true;
    }
}

function concatField(text: string, field: string): string {
    let out = "";
    for (const f of parseFrames(text)) {
        if (f.done) continue;
        const c = firstChoice(f);
        const d = c?.["delta"];
        if (d && typeof d === "object") {
            const v = (d as Record<string, unknown>)[field];
            if (typeof v === "string") out += v;
        }
    }
    return out;
}

test("#1546: empty-string content on the finish frame does not strand a held tail after finish", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([chunk({ content: "hello <" }), chunk({ content: "" }, "stop"), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
    );
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "content"), "hello <", "held '<' lands before/at finish, not after");
});

test("#1546: control — empty delta object on the finish frame still flushes the held tail first", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([chunk({ content: "hello <" }), chunk({}, "stop"), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
    );
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "content"), "hello <", "held '<' flushed ahead of the finish frame");
});

test("#1546: finish frame that itself buffers tag-start text keeps byte order and finishes last", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([chunk({ content: "hello <a" }, "stop"), DONE]), makeRes(out), "openai", makeSession());
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "content"), "hello <a", "released prefix precedes the resolved tail");
    assert.ok(!text.includes("<ahello"), "tail must not be reordered ahead of its own released prefix");
});

test("#1546: held reasoning_content tail is drained before the finish frame", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([chunk({ reasoning_content: "think <" }), chunk({ content: "" }, "stop"), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
    );
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "reasoning_content"), "think <", "held reasoning tail preserved before finish");
});

test("#1546: tool_calls terminal frame with empty content drains a held text tail without touching arguments", async () => {
    const args = '{"x":1}';
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([
            chunk({ content: "hi <" }),
            chunk({ content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: args } }] }, "tool_calls"),
            DONE,
        ]),
        makeRes(out),
        "openai",
        makeSession(),
    );
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "content"), "hi <", "held text tail drained before the tool_calls finish");
    const tcFrame = parseFrames(text).find((f) => {
        if (!f.obj) return false;
        const d = firstChoice(f)?.["delta"];
        return d !== undefined && typeof d === "object" && Array.isArray((d as Record<string, unknown>)["tool_calls"]);
    });
    assert.ok(tcFrame?.obj, "tool_calls terminal frame forwarded");
    const tcd = firstChoice(tcFrame!)!["delta"] as Record<string, unknown>;
    const fn = (tcd["tool_calls"] as Array<Record<string, unknown>>)[0]["function"] as Record<string, unknown>;
    assert.equal(fn["arguments"], args, "tool-call arguments forwarded byte-exact (#1039)");
});

test("#1546: ordinary streams with no held tail are unchanged by the fix", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([chunk({ role: "assistant" }), chunk({ content: "plain answer" }), chunk({ content: "" }, "stop"), DONE]),
        makeRes(out),
        "openai",
        makeSession(),
    );
    const text = out.join("");
    assertNoContentAfterFinish(text);
    assert.equal(concatField(text, "content"), "plain answer", "prose passthrough intact");
    assert.ok(parseFrames(text).some((f) => f.done), "[DONE] still terminates the stream");
});

// ---- google wire (Gemini): candidates[*].content.parts[*].text, finishReason on the candidate ----

function gframe(parts: Array<Record<string, unknown>>, finishReason?: string): string {
    const candidate: Record<string, unknown> = { index: 0, content: { role: "model", parts } };
    if (finishReason) candidate["finishReason"] = finishReason;
    return `data: ${JSON.stringify({ modelVersion: "gemini-test", candidates: [candidate] })}\n\n`;
}

function gCandidates(f: Frame): Record<string, unknown>[] {
    if (!f.obj) return [];
    const c = f.obj["candidates"];
    return Array.isArray(c) ? (c as Record<string, unknown>[]) : [];
}

function gFinish(f: Frame): string | undefined {
    for (const c of gCandidates(f)) {
        const fr = c["finishReason"];
        if (typeof fr === "string") return fr;
    }
    return undefined;
}

function gTexts(f: Frame): string[] {
    const out: string[] = [];
    for (const c of gCandidates(f)) {
        const content = c["content"];
        if (!content || typeof content !== "object") continue;
        const parts = (content as Record<string, unknown>)["parts"];
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            if (p && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string") {
                out.push((p as Record<string, unknown>)["text"] as string);
            }
        }
    }
    return out;
}

/** Gemini twin of assertNoContentAfterFinish (#1546): once a candidate carries
 *  finishReason, no LATER frame may carry a non-empty text part. */
function assertNoGcontentAfterFinish(text: string): void {
    let finished = false;
    for (const f of parseFrames(text)) {
        if (f.done) break;
        if (finished) {
            for (const t of gTexts(f)) assert.equal(t, "", "no text part after finishReason");
        }
        if (gFinish(f) !== undefined) finished = true;
    }
}

function concatGtext(text: string): string {
    let out = "";
    for (const f of parseFrames(text)) {
        if (f.done) continue;
        for (const t of gTexts(f)) out += t;
    }
    return out;
}

test("#1546 google: empty-string text part on the finishReason frame does not strand a held tail", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([gframe([{ text: "hello <" }]), gframe([{ text: "" }], "STOP")]),
        makeRes(out),
        "google",
        makeSession(),
    );
    const text = out.join("");
    assertNoGcontentAfterFinish(text);
    assert.equal(concatGtext(text), "hello <", "held '<' lands before/at finish, not after");
});

test("#1546 google: control — finishReason frame with no parts still flushes the held tail first", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([gframe([{ text: "hello <" }]), gframe([], "STOP")]),
        makeRes(out),
        "google",
        makeSession(),
    );
    const text = out.join("");
    assertNoGcontentAfterFinish(text);
    assert.equal(concatGtext(text), "hello <", "held '<' flushed ahead of the finishReason frame");
});

test("#1546 google: finishReason frame carrying buffered tag-start text keeps byte order and finishes last", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(streamOf([gframe([{ text: "hello <a" }], "STOP")]), makeRes(out), "google", makeSession());
    const text = out.join("");
    assertNoGcontentAfterFinish(text);
    assert.equal(concatGtext(text), "hello <a", "released prefix precedes the resolved tail");
    assert.ok(!text.includes("<ahello"), "tail must not be reordered ahead of its own released prefix");
});

test("#1546 google: held thought-part tail is drained before the finishReason frame", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([gframe([{ thought: true, text: "think <" }]), gframe([], "STOP")]),
        makeRes(out),
        "google",
        makeSession(),
    );
    const text = out.join("");
    assertNoGcontentAfterFinish(text);
    assert.equal(concatGtext(text), "think <", "held thought tail preserved before finish");
});

test("#1546 google: ordinary streams with no held tail are unchanged by the fix", async () => {
    const out: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([gframe([{ text: "plain answer" }]), gframe([], "STOP")]),
        makeRes(out),
        "google",
        makeSession(),
    );
    const text = out.join("");
    assertNoGcontentAfterFinish(text);
    assert.equal(concatGtext(text), "plain answer", "prose passthrough intact");
    assert.ok(parseFrames(text).some((f) => gFinish(f) !== undefined), "finishReason still terminates the stream");
});
