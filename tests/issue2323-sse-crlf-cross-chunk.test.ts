import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";
import { normalizeSseLineEndings, finalizeSseLineEndings } from "../src/sse-util.ts";

// #2323: a multi-line `data:` event whose CRLF terminator straddled two network
// chunks used to tear into two fragments that no longer parse, so the terminal
// was never recognized and the client got a false upstream_stream_truncated.
// Root cause: normalizeSseLineEndings was stateless and eagerly converted a
// trailing lone `\r`; the partner `\n` arriving in the next chunk produced a
// spurious blank line. The fix makes the normalizer streaming-stateful (hold
// back a trailing lone `\r`) and resolves it at true EOF via finalize.

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
            } else controller.close();
        },
    });
}

async function runPipe(inputChunks: string[]): Promise<{ truncated: boolean; body: string }> {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(inputChunks), makeRes(out), makeSession(), undefined, undefined, "http://up");
    const body = out.join("");
    return { truncated: body.includes("upstream_stream_truncated"), body };
}

test("normalizeSseLineEndings: mid-buffer terminators collapse to \\n", () => {
    assert.equal(normalizeSseLineEndings("a\r\nb"), "a\nb"); // CRLF pair
    assert.equal(normalizeSseLineEndings("a\rb"), "a\nb"); // standalone CR
    assert.equal(normalizeSseLineEndings("a\nb"), "a\nb"); // already LF
    assert.equal(normalizeSseLineEndings("a\r\r"), "a\n\r"); // first resolved, second held
});

test("normalizeSseLineEndings: a trailing lone \\r is held back, not normalized", () => {
    // Its partner byte may still arrive next chunk; normalizing now would be wrong.
    assert.equal(normalizeSseLineEndings("a\r"), "a\r");
    assert.equal(normalizeSseLineEndings("\r"), "\r");
    assert.equal(normalizeSseLineEndings("a\r\n"), "a\n"); // CRLF ending in \n is safe to resolve
});

test("normalizeSseLineEndings: the held \\r resolves correctly on the next chunk", () => {
    // The exact #2323 mechanism, at the util level: a CRLF split across calls.
    let buf = "";
    buf = normalizeSseLineEndings(buf + "event: x\r"); // -> holds the \r
    assert.equal(buf, "event: x\r");
    buf = normalizeSseLineEndings(buf + "\ndata: y\r\n\r\n"); // partner arrives
    assert.equal(buf, "event: x\ndata: y\n\n");
});

test("finalizeSseLineEndings: converts every terminator incl. a trailing lone \\r", () => {
    assert.equal(finalizeSseLineEndings("a\r"), "a\n");
    assert.equal(finalizeSseLineEndings("a\r\nb"), "a\nb");
    assert.equal(finalizeSseLineEndings("a\n"), "a\n");
    assert.equal(finalizeSseLineEndings(""), "");
});

// A complete Responses terminal event expressed as a multi-line data block (two
// `data:` lines join into one valid JSON object). This is the shape the issue hit.
const EVENT_LF = 'event: response.completed\ndata: {\ndata: "type": "response.completed"}\n\n';
const EVENT_CRLF = EVENT_LF.replace(/\n/g, "\r\n");
const EVENT_CR = EVENT_LF.replace(/\n/g, "\r");

test("pipe: LF terminal forwarded intact regardless of chunking (control)", async () => {
    const unsplit = await runPipe([EVENT_LF]);
    assert.equal(unsplit.truncated, false);
    assert.ok(unsplit.body.includes('"type": "response.completed"'));
    const split = await runPipe([EVENT_LF.slice(0, 5), EVENT_LF.slice(5)]);
    assert.equal(split.truncated, false);
    assert.equal(split.body, unsplit.body);
});

test("pipe: CRLF terminal straddling a chunk boundary is NOT torn (#2323)", async () => {
    const unsplit = await runPipe([EVENT_CRLF]);
    assert.equal(unsplit.truncated, false);
    // The issue's exact repro: the CRLF between the two `data:` lines split across chunks.
    const idx = EVENT_CRLF.indexOf("\r\n", 20);
    const split = await runPipe([EVENT_CRLF.slice(0, idx + 1), EVENT_CRLF.slice(idx + 1)]);
    assert.equal(split.truncated, false, "chunk boundary must not flip a complete terminal into truncation");
    assert.ok(split.body.includes('"type": "response.completed"'));
});

test("pipe: standalone-CR terminal (legal per SSE spec) survives unsplit and split", async () => {
    const unsplit = await runPipe([EVENT_CR]);
    assert.equal(unsplit.truncated, false);
    const split = await runPipe([EVENT_CR.slice(0, 6), EVENT_CR.slice(6)]);
    assert.equal(split.truncated, false, "a legal standalone-CR stream must not regress to truncation");
});

test("pipe: exhaustive CRLF chunk-boundary sweep — no split tears the event", async () => {
    const canonical = await runPipe([EVENT_LF]);
    assert.equal(canonical.truncated, false);
    for (let i = 1; i < EVENT_CRLF.length; i++) {
        const r = await runPipe([EVENT_CRLF.slice(0, i), EVENT_CRLF.slice(i)]);
        assert.equal(r.truncated, false, `CRLF split at ${i} must not truncate`);
        assert.equal(r.body, canonical.body, `CRLF split at ${i} must yield identical bytes`);
    }
});
