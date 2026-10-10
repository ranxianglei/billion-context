import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { salvageCompressArgs } from "../src/plugin-compress-salvage.ts";
import { parseCompressArgs } from "acp-kernel";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";

// Incident shape A (#2580): `{"content": <bare line-form text …>` — unquoted
// value, real newlines, stray closing quote+brace. Built from pieces so the
// source stays greppable.
const INCIDENT_A = `{"content": m00001\u2013m00042 Identity report\nLine one of the summary.\nMore detail here.\n"}`;

function makeSession(): Session {
    return {
        id: "sess2580",
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

function dataLines(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const block of text.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const s = line.slice(5).replace(/^ /, "").trim();
        if (!s || s === "[DONE]") continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            continue;
        }
    }
    return out;
}

function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function asObj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function anthropicInput(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] !== "content_block_delta") continue;
        const d = asObj(ev["delta"]);
        if (d["type"] === "input_json_delta") out += asString(d["partial_json"]);
    }
    return out;
}

function anthropicText(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] !== "content_block_delta") continue;
        const d = asObj(ev["delta"]);
        if (d["type"] === "text_delta") out += asString(d["text"]);
    }
    return out;
}

function anthropicStream(toolName: string, argFragments: string[], opts: { prose?: string; stop?: boolean } = {}): string[] {
    const events: string[] = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 5 } } })}\n\n`,
    ];
    if (opts.prose !== undefined) {
        events.push(
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.prose } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        );
    }
    const toolIndex = opts.prose !== undefined ? 1 : 0;
    events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: "toolu_2580", name: toolName } })}\n\n`);
    for (const frag of argFragments) {
        events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: frag } })}\n\n`);
    }
    if (opts.stop !== false) {
        events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: toolIndex })}\n\n`);
    }
    events.push(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    );
    return events;
}

function splitFrags(s: string, n: number): string[] {
    const size = Math.max(1, Math.ceil(s.length / n));
    const out: string[] = [];
    for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
    return out;
}

test("#2580 salvage: valid strict JSON stays byte-identical (#1039 invariant)", () => {
    const valid = JSON.stringify({ content: [{ startId: "m00001", endId: "m00050", summary: "kept", topic: "Auth" }] });
    const r = salvageCompressArgs(valid, "call_x");
    assert.equal(r.action, "verbatim");
    assert.equal(r.out, valid, "valid JSON must be forwarded byte-identical");
});

test("#2580 salvage: lenient-ladder shape (trailing comma) canonicalizes to strict JSON", () => {
    const dirty = '{"content":[{"startId":"m00001","endId":"m00050","summary":"kept"},]}';
    const r = salvageCompressArgs(dirty, "call_y");
    assert.equal(r.action, "canonicalized");
    assert.ok(r.ranges >= 1);
    const reparsed = JSON.parse(r.out);
    assert.ok(Array.isArray(reparsed.content), "canonical form is the object-array surface");
    assert.equal(reparsed.content[0].startId, "m00001");
});

test("#2580 salvage: incident shape A (bare unquoted line-form value) wraps into strict JSON", () => {
    const r = salvageCompressArgs(INCIDENT_A, "call_z");
    assert.equal(r.action, "wrapped", `expected wrap, got ${r.action} kind=${r.kind ?? "-"}`);
    assert.ok(r.ranges >= 1, "wrapped candidate must acceptance-parse to at least one range");
    const obj = JSON.parse(r.out);
    assert.equal(typeof obj.content, "string");
    const kernel = parseCompressArgs(r.out, { callId: "call_z" });
    assert.equal(kernel.ranges.length, r.ranges);
    assert.equal(kernel.ranges[0].startRef, "m00001");
    assert.equal(kernel.ranges[0].endRef, "m00042");
    assert.ok(kernel.ranges[0].summary.includes("Line one of the summary."));
});

test("#2580 salvage: bare content value without any ref token is unrecoverable (bytes untouched)", () => {
    const bad = '{"content": hello world, no refs here';
    const r = salvageCompressArgs(bad, "call_w");
    assert.equal(r.action, "unrecoverable");
    assert.equal(r.out, bad);
});

test("#2580 salvage: non-object garbage and empty input are unrecoverable", () => {
    for (const bad of ["not json at all", ""]) {
        const r = salvageCompressArgs(bad, "call_g");
        assert.equal(r.action, "unrecoverable");
        assert.equal(r.out, bad);
    }
});

test("#2580 stream: incident shape A split across fragments arrives as ONE repaired strict-JSON payload", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf(anthropicStream("compress", splitFrags(INCIDENT_A, 3), { prose: "Compacting now " })), res, "anthropic", makeSession());
    const parsed = dataLines(out.join(""));
    const input = anthropicInput(parsed);
    assert.notEqual(input, "", "repaired payload must be emitted");
    const obj = JSON.parse(input); // throws if the host would still see invalid JSON
    assert.equal(typeof obj.content, "string");
    const kernel = parseCompressArgs(input, { callId: "toolu_2580" });
    assert.ok(kernel.ranges.length >= 1);
    assert.equal(kernel.ranges[0].startRef, "m00001");
    assert.equal(kernel.ranges[0].endRef, "m00042");
    assert.equal(anthropicText(parsed), "Compacting now ", "prose block untouched");
    const deltas = parsed.filter((e) => e["type"] === "content_block_delta" && asObj(e["delta"])["type"] === "input_json_delta");
    assert.equal(deltas.length, 1, "held fragments collapse into a single synthetic delta");
    const stopIdx = parsed.findIndex((e) => e["type"] === "content_block_stop" && e["index"] === 1);
    assert.ok(stopIdx >= 0, "block stop preserved");
    assert.ok(parsed.indexOf(deltas[0]) < stopIdx, "repaired delta precedes the block stop");
});

test("#2580 stream: VALID compress args stay byte-identical through the plugin lane (#1039 guard)", async () => {
    const valid = JSON.stringify({ content: [{ startId: "m00001", endId: "m00020", summary: "fine" }] });
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf(anthropicStream("compress", splitFrags(valid, 4))), res, "anthropic", makeSession());
    const input = anthropicInput(dataLines(out.join("")));
    assert.equal(input, valid, "valid compress args must be byte-identical to upstream");
});

test("#2580 stream: non-compress tools keep verbatim fragment streaming even with invalid JSON", async () => {
    const dirty = '{"cmd": echo "a\nb"';
    const frags = splitFrags(dirty, 3);
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf(anthropicStream("bash", frags)), res, "anthropic", makeSession());
    const input = anthropicInput(dataLines(out.join("")));
    assert.equal(input, dirty, "non-compress tool args are user intent — untouched (#1039)");
});

test("#2580 stream: truncated compress block (no content_block_stop) flushes repaired JSON at terminal", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    await pipePluginChatWithStrip(streamOf(anthropicStream("compress", splitFrags(INCIDENT_A, 2), { stop: false })), res, "anthropic", makeSession());
    const parsed = dataLines(out.join(""));
    const input = anthropicInput(parsed);
    const obj = JSON.parse(input); // host parse must succeed despite the truncation
    assert.equal(typeof obj.content, "string");
    const msgStop = parsed.findIndex((e) => e["type"] === "message_stop");
    assert.ok(msgStop >= 0);
    const delta = parsed.find((e) => e["type"] === "content_block_delta" && asObj(e["delta"])["type"] === "input_json_delta");
    assert.ok(delta, "synthetic delta present");
    assert.ok(parsed.indexOf(delta!) < msgStop, "flushed before message_stop");
});
