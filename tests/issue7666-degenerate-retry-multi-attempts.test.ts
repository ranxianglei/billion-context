import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";

import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import {
    DEFAULT_DEGENERATE_RETRY_NUDGES,
    DEGENERATE_RETRY_NUDGE,
    injectContinuationNudge,
    makeContinuationRefetch,
} from "../src/degenerate-retry.ts";
import type { Session } from "../src/session.ts";

// #7666: the degenerate-terminal retry budget is now configurable per the
// three compress levels (compress.degenerateRetry.{maxAttempts,nudges}).
// maxAttempts 0 = off, 1 = the pre-#7666 behavior (default), up to 5; attempt
// i sends nudges[i] (cycling). The budget is independent of the #2171
// truncation re-issue (a turn may spend one of each). These tests pin the
// config contract, the nudge rotation, and both pipe lanes' budget behavior.

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

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function chatStop(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

/** A turn whose ONLY text is an echoed render tag: emptied by the filter, so
 *  the degenerate gate fires. */
function echoOnlyTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }), chatStop(), DONE];
}

/** The "still empty" retry shape: a role-only stream that completes bare. */
function emptyRetryTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function responsesEchoOnlyTurn(): string[] {
    return [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "message" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, text: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "message" }] } }),
    ];
}

function responsesDeltas(raw: string): string {
    return [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// ---------------------------------------------------------------------------
// Config parsing (parseCompressSettings)
// ---------------------------------------------------------------------------

test("parse: degenerateRetry maxAttempts accepts 0..5 (0 = off is meaningful)", () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
        assert.equal(parseCompressSettings({ degenerateRetry: { maxAttempts: n } })?.degenerateRetry?.maxAttempts, n, `maxAttempts=${n}`);
    }
});

test("parse: degenerateRetry maxAttempts out of range or non-integer rejects the whole compress block", () => {
    for (const bad of [-1, 6, 1.5, "3", true, null]) {
        assert.equal(parseCompressSettings({ minCompressRangeChars: 1000, degenerateRetry: { maxAttempts: bad } }), undefined, `maxAttempts=${String(bad)} must sink the block (#1909)`);
    }
});

test("parse: degenerateRetry nudges accepts 1..8 non-empty strings and trims them", () => {
    const ok = parseCompressSettings({ degenerateRetry: { nudges: [" a ", "b"] } })?.degenerateRetry?.nudges;
    assert.deepEqual(ok, ["a", "b"]);
    const many = Array.from({ length: 8 }, (_, i) => `n${i}`);
    assert.deepEqual(parseCompressSettings({ degenerateRetry: { nudges: many } })?.degenerateRetry?.nudges, many, "eight nudges fit");
});

test("parse: degenerateRetry nudges empty/oversized/malformed rejects the block", () => {
    for (const bad of [[], Array.from({ length: 9 }, (_, i) => `n${i}`), ["ok", ""], ["ok", "   "], ["ok", 7], "a plain string"]) {
        assert.equal(parseCompressSettings({ degenerateRetry: { nudges: bad as unknown as string[] } }), undefined, `nudges=${JSON.stringify(bad)} must sink the block`);
    }
});

test("parse: a bad nudges entry rejects the whole degenerateRetry even with a good maxAttempts", () => {
    assert.equal(parseCompressSettings({ degenerateRetry: { maxAttempts: 2, nudges: ["fine", ""] } })?.degenerateRetry, undefined);
});

test("parse: empty degenerateRetry object leaves the field unset", () => {
    const out = parseCompressSettings({ degenerateRetry: {} });
    assert.ok(out, "an empty object is valid and does not sink the block");
    assert.equal(out?.degenerateRetry, undefined);
});

// ---------------------------------------------------------------------------
// Three-level merge (mergeCompress)
// ---------------------------------------------------------------------------

test("merge: degenerateRetry sub-fields merge across levels like absorb (deepest defined wins)", () => {
    const merged = mergeCompress(
        { degenerateRetry: { maxAttempts: 3 } },
        { degenerateRetry: { nudges: ["provider line"] } },
        undefined,
    );
    assert.equal(merged.degenerateRetry?.maxAttempts, 3, "a model-silent field falls back to the provider/global level");
    assert.deepEqual(merged.degenerateRetry?.nudges, ["provider line"]);
});

test("merge: model-level nudges override provider-level without discarding global maxAttempts", () => {
    const merged = mergeCompress(
        { degenerateRetry: { maxAttempts: 2 } },
        { degenerateRetry: { nudges: ["a"] } },
        { degenerateRetry: { nudges: ["b"] } },
    );
    assert.deepEqual(merged.degenerateRetry, { maxAttempts: 2, nudges: ["b"] });
});

test("merge: no level configured leaves degenerateRetry undefined", () => {
    assert.equal(mergeCompress(undefined, undefined, undefined).degenerateRetry, undefined);
    assert.equal(mergeCompress({ minCompressRangeChars: 1 }, undefined, undefined).degenerateRetry, undefined);
});

// ---------------------------------------------------------------------------
// Nudge injection + rotation
// ---------------------------------------------------------------------------

test("DEFAULT_DEGENERATE_RETRY_NUDGES: first entry is the historical sentence; entries are distinct and non-empty", () => {
    assert.equal(DEFAULT_DEGENERATE_RETRY_NUDGES[0], DEGENERATE_RETRY_NUDGE, "attempt 1 must keep sending the pre-#7666 sentence");
    assert.equal(DEFAULT_DEGENERATE_RETRY_NUDGES.length, 3);
    assert.equal(new Set(DEFAULT_DEGENERATE_RETRY_NUDGES).size, DEFAULT_DEGENERATE_RETRY_NUDGES.length, "no duplicates in the rotation");
});

test("injectContinuationNudge honors a custom sentence (openai user-tail merge + assistant-tail new turn)", () => {
    const userTail = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const merged = injectContinuationNudge("openai", userTail, "m", "my custom nudge line");
    assert.ok(merged !== null && merged.includes("my custom nudge line"), "custom sentence lands in the merged user turn");
    const assistantTail = JSON.stringify({ model: "m", messages: [{ role: "assistant", content: "..." }] });
    const appended = injectContinuationNudge("openai", assistantTail, "m", "my custom nudge line");
    assert.ok(appended !== null && appended.includes("my custom nudge line"), "assistant tail gets a fresh user turn with the custom sentence");
    // the default call keeps the historical sentence
    const defaulted = injectContinuationNudge("openai", userTail, "m");
    assert.ok(defaulted !== null && defaulted.includes(DEGENERATE_RETRY_NUDGE));
});

/** A local server that records every request body it receives. */
async function recordingServer(): Promise<{ url: string; bodies: () => string[]; close: () => Promise<void> }> {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on("data", (p) => parts.push(p));
        req.on("end", () => {
            seen.push(Buffer.concat(parts).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    return {
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        bodies: () => seen,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test("makeContinuationRefetch rotates the nudge per attempt (attempt i sends nudges[i], cycling)", async () => {
    const srv = await recordingServer();
    try {
        const refetch = makeContinuationRefetch({
            protocol: "openai",
            body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
            model: "m",
            upstreamUrl: srv.url,
            reqHeaders: {},
            signal: new AbortController().signal,
            log: () => {},
            label: "rotation-test",
            nudges: ["alpha-nudge", "beta-nudge", "gamma-nudge"],
        });
        for (let i = 0; i < 3; i += 1) {
            const out = await refetch();
            assert.ok(out, `attempt ${i + 1} yields its stream`);
        }
        const bodies = srv.bodies();
        assert.equal(bodies.length, 3, "three attempts hit the upstream three times");
        assert.ok(bodies[0].includes("alpha-nudge"), "attempt 1 sends nudges[0]");
        assert.ok(bodies[1].includes("beta-nudge"), "attempt 2 sends nudges[1]");
        assert.ok(bodies[2].includes("gamma-nudge"), "attempt 3 sends nudges[2]");
        for (const b of bodies) assert.ok(b.includes('"role":"user"') && b.includes("hi"), "the original request survives the nudge append");
    } finally {
        await srv.close();
    }
});

test("makeContinuationRefetch falls back to DEFAULT_DEGENERATE_RETRY_NUDGES when none configured", async () => {
    const srv = await recordingServer();
    try {
        const refetch = makeContinuationRefetch({
            protocol: "openai",
            body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
            model: "m",
            upstreamUrl: srv.url,
            reqHeaders: {},
            signal: new AbortController().signal,
            log: () => {},
            label: "default-rotation",
        });
        await refetch();
        await refetch();
        const bodies = srv.bodies();
        assert.ok(bodies[0].includes(DEFAULT_DEGENERATE_RETRY_NUDGES[0]), "attempt 1 defaults to the historical sentence");
        assert.ok(bodies[1].includes(DEFAULT_DEGENERATE_RETRY_NUDGES[1]), "attempt 2 defaults to the second built-in sentence");
    } finally {
        await srv.close();
    }
});

// ---------------------------------------------------------------------------
// Chat pipe: budget behavior
// ---------------------------------------------------------------------------

test("chat: with maxAttempts=2 the second retry's prose lands without #870", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(calls === 1 ? emptyRetryTurn() : proseTurn("finally the real answer")));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
    const text = out.join("");
    assert.equal(calls, 2, "the first retry is empty, the second is used");
    const deltas = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
    assert.equal(deltas, "finally the real answer", "the second retry's prose reaches the client");
    assert.ok(!text.includes('"code":"stream_error"'), "no #870: the budget had room");
});

test("chat: default budget stays 1 — an empty second attempt raises the historical singular #870", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(emptyRetryTurn()));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "the default budget is still one re-issue");
    assert.ok(text.includes('"code":"stream_error"'), "double degenerate still errors in-band");
    assert.ok(text.includes("the turn degenerated again after the continuation nudge"), "N=1 keeps the pre-#7666 sentence verbatim");
    assert.ok(!text.includes('"finish_reason":"stop"'), "the error shape does not fake a clean stop");
});

test("chat: with maxAttempts=2 the exhausted error names the plural nudges", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(emptyRetryTurn()));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
    const text = out.join("");
    assert.equal(calls, 2, "both attempts were spent before the terminal");
    assert.ok(text.includes("the turn degenerated again after 2 continuation nudges"), `plural #870 wording, got: ${text.slice(0, 400)}`);
    assert.ok(text.includes('"code":"stream_error"'));
});

test("chat: maxAttempts=0 disables the degenerate retry (no re-issue, no #870)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 0);
    const text = out.join("");
    assert.equal(calls, 0, "the off switch must not re-issue (#5897's opt-out, now per-config)");
    assert.ok(!text.includes('"code":"stream_error"'), "off means the emptied turn passes through silently");
    assert.ok(!text.includes("m00155"), "the echoed tag never leaks either way");
});

// ---------------------------------------------------------------------------
// Responses pipe: budget behavior (this lane has no #870 — exhaustion passes
// the empty turn through)
// ---------------------------------------------------------------------------

test("responses: with maxAttempts=2 an empty first retry is retried a second time", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(
            streamOf(
                calls === 1
                    ? responsesEchoOnlyTurn()
                    : [
                          sse("response.created", { type: "response.created", response: { id: "resp_r", status: "in_progress" } }),
                          sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: "second retry prose" }),
                          sse("response.completed", { type: "response.completed", response: { id: "resp_r", status: "completed" } }),
                      ],
            ),
        );
    };
    await pipePluginResponsesWithStrip(streamOf(responsesEchoOnlyTurn()), makeRes(out), makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, 2);
    assert.equal(calls, 2, "the second attempt is spent");
    assert.equal(responsesDeltas(out.join("")).includes("second retry prose"), true, "the second retry's text lands");
    assert.ok(!out.join("").includes('"code":"stream_error"'), "the responses lane never raises #870");
});

test("responses: exhausted budget passes the empty turn through without error (lane semantics preserved)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesEchoOnlyTurn()));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesEchoOnlyTurn()), makeRes(out), makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, 2);
    const text = out.join("");
    assert.equal(calls, 2, "both attempts spent");
    assert.ok(!text.includes('"code":"stream_error"'), "no in-band error on this lane");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "exactly one completed terminal");
});

test("responses: maxAttempts=0 disables the retry", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesEchoOnlyTurn()));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesEchoOnlyTurn()), makeRes(out), makeSession(), undefined, refetch, undefined, undefined, undefined, undefined, undefined, undefined, 0);
    assert.equal(calls, 0, "off switch honored on the responses lane too");
});
