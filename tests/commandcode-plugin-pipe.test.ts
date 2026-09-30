// #1295 review F9: coverage for the commandcode plugin pipe
// (pipePluginJsonlWithStrip), the commandcode branches of the three
// stream-error emitters, and settleToolCalls' duplicate-name raw-line replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ReadableStream } from "node:stream/web";
import { pipePluginJsonlWithStrip } from "../src/plugin.ts";
import { emitStreamError, emitUpstreamTruncation, emitPreflightError } from "../src/stream-error.ts";

const LT = "\x3c";
const TAG = (ref: string) => `${LT}acp tokens="2" type="text">${ref}${LT}/acp>`;

function makeCollector(): { res: http.ServerResponse; out(): string } {
    const chunks: Buffer[] = [];
    const res = {
        destroyed: false,
        writableEnded: false,
        write(chunk: string | Buffer) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
        },
        end() {
            return this;
        },
        once() {
            return this;
        },
        on() {
            return this;
        },
    } as unknown as http.ServerResponse;
    return { res, out: () => Buffer.concat(chunks).toString("utf8") };
}

function jsonlStream(lines: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(c) {
            for (const l of lines) c.enqueue(enc.encode(l + "\n"));
            c.close();
        },
    });
}

test("plugin JSONL pipe: prose tag-echo is stripped, everything else is byte-verbatim", async () => {
    const clean = "hello ";
    const dirty = JSON.stringify({ type: "text-delta", text: clean + TAG("m00001") });
    const usage = JSON.stringify({ type: "usage", inputTokens: 5 });
    const finish = JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 11, outputTokens: 7 } });
    const junk = "not json at all";
    const { res, out } = makeCollector();
    await pipePluginJsonlWithStrip(jsonlStream([dirty, usage, finish, junk]), res);
    const lines = out().split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 4, "four lines out for four in");
    const textEv = JSON.parse(lines[0]) as { type: string; text: string };
    assert.equal(textEv.type, "text-delta");
    assert.equal(textEv.text, clean, "render tag stripped from prose");
    assert.equal(lines[1], usage, "non-prose line passes byte-verbatim");
    assert.equal(lines[3], junk, "malformed JSON line passes byte-verbatim");
    assert.equal(lines[2], finish, "finish passes byte-verbatim");
});

test("plugin JSONL pipe: clean prose survives to a terminal finish; unresolvable tag fragment is dropped", async () => {
    // An unterminated tag prefix: the filter holds it back waiting for more
    // prose; at the terminal frame the unresolvable fragment is dropped (the
    // tag-echo filter's documented policy), clean prose + finish survive
    // byte-verbatim — partial prose is never silently lost.
    const tail = `partial ${LT}acp to`;
    const finish = JSON.stringify({ type: "finish", finishReason: "stop" });
    const { res, out } = makeCollector();
    await pipePluginJsonlWithStrip(jsonlStream([JSON.stringify({ type: "text-delta", text: tail }), finish]), res);
    const lines = out().split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "cleaned text-delta + finish");
    const textEv = JSON.parse(lines[0]) as { type: string; text: string };
    assert.equal(textEv.type, "text-delta");
    assert.equal(textEv.text, "partial ", "prose before the fragment preserved");
    assert.ok(!out().includes(`${LT}acp`), "unresolvable fragment dropped, never relayed");
    assert.equal(lines[1], finish, "finish passes byte-verbatim");
});

test("plugin JSONL pipe: read failure mid-stream synthesizes an in-band truncation event", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(JSON.stringify({ type: "text-delta", text: "partial output" }) + "\n"));
            // Error on a LATER tick: enqueue-then-error in the same tick makes
            // the very first read() reject and the queued chunk is discarded
            // by the stream spec — we need one delivered chunk first.
            setTimeout(() => c.error(new Error("socket reset")), 10);
        },
    });
    const { res, out } = makeCollector();
    await pipePluginJsonlWithStrip(stream, res);
    const out_ = out();
    assert.match(out_, /text-delta/, "pre-failure prose relayed");
    assert.match(out_, /type.*error|acp_proxy_error|truncat/, "in-band truncation/error signal emitted");
});

test("stream-error emitters: commandcode branches speak bare JSONL", () => {
    const a = makeCollector();
    emitStreamError(a.res, "commandcode", "boom");
    const aOut = a.out();
    assert.match(aOut, /"type":"error"/);
    assert.match(aOut, /boom/);
    assert.ok(!aOut.includes("data:"), "no SSE framing on the JSONL wire");

    const b = makeCollector();
    emitUpstreamTruncation(b.res, "commandcode", false, undefined);
    assert.match(b.out(), /"type"/, "truncation event is a JSONL line");

    const c = makeCollector();
    emitPreflightError(c.res, "commandcode", { message: "too big", retryable: false }, undefined);
    const cOut = c.out();
    assert.match(cOut, /too big/);
    assert.ok(!cOut.includes("event:"), "no SSE event framing");
});

// F9c: duplicate tool names must not corrupt settleToolCalls' verbatim replay.
// Drive the adapter directly with two same-name tool events + one real call.
test("adapter: duplicate tool names replay raw lines without cross-wiring", async () => {
    const { createCommandcodeAdapter } = await import("../src/loop/adapter-commandcode.ts");
    const adapter = createCommandcodeAdapter({ model: "m", messages: [], stream: true });
    const enc = new TextEncoder();
    const mk = (id: string, cmd: string) => JSON.stringify({ type: "tool-call", toolCallId: id, toolName: "shell", input: { command: cmd } });
    const lines = [
        JSON.stringify({ type: "text-delta", text: "running " }),
        mk("call-1", "ls"),
        mk("call-2", "pwd"),
        JSON.stringify({ type: "finish", finishReason: "tool_use" }),
    ];
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of adapter.parseStream(
        new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l + "\n")); c.close(); } }),
    )) {
        events.push(ev as Record<string, unknown>);
    }
    const calls = events.filter((e) => e.kind === "tool_call") as Array<{ name: string; callId: string; arguments: string; passthrough?: boolean }>;
    assert.equal(calls.length, 2, "both same-name calls emitted");
    assert.ok(calls.every((c) => c.passthrough === true), "real (non-proxy) calls replay verbatim");
    assert.deepEqual(calls.map((c) => c.callId), ["call-1", "call-2"], "ids preserved in order");
    const argsById = new Map(calls.map((c) => [c.callId, JSON.stringify(c.arguments)]));
    assert.match(argsById.get("call-1") ?? "", /ls/);
    assert.match(argsById.get("call-2") ?? "", /pwd/, "duplicate name did not cross-wire arguments");
});
