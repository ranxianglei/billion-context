import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #6034 (option E): the plugin's answer ledger armed its markup flag on ANY
// dropped tag (onTagDrop was one-shot, so the first drop owned the flag). A
// complete refs-only echo unit — the model citing its own render tag,
// `<acp tokens="102" type="text" time="...">m00258</acp>` — dies WHOLE: it
// leaves no interior behind. Arming on it miscounted the turn's 108-char real
// answer as markup, the answer gate read the turn as degenerate, retried,
// hit the same echo again, and emitted the in-band #870 error — killing a
// healthy turn twice on 300K+ tokens of full-price refetch. The verdict now
// rides a separate always-delivered callback (the one-shot notice only
// reaches the first drop, which is precisely the case that must be
// overruled): only a session-start open and a close releasing its prose body
// leave interior; whole-dead units and content releases do not.
// Directions: T1/T2 (pure echo + real prose => no retry) are the fix;
// T3/T4 (no answer at all => still retry) are the kept controls (#3617).

const ECHO = `\x3cacp tokens="102" type="text" time="2026-11-23 09:44:20"\x3em00258\x3c/acp\x3e`;
const ECHO_OPEN = `\x3cacp tokens="102" type="text" time="2026-11-23 09:44:20"\x3e`;
const PROSE = "The migration finished without errors — all 1,204 rows copied, checksums verified, and the old bucket archived as requested.";

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
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

function chatFinish(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

test("filter: a cross-chunk refs-only echo never arms the frame — the whole-dead close leaves nothing either (#6034)", () => {
    const verdicts: boolean[] = [];
    const f = createTagEchoFilter(undefined, undefined, false, undefined, (v) => verdicts.push(v));
    const a = f.push(ECHO_OPEN);
    const b = f.push(`m00258\x3c/acp\x3e`);
    const c = f.push(PROSE);
    assert.equal(a, "", "the open holds");
    assert.equal(b, "", "the refs-only unit dies whole — nothing released");
    assert.equal(c, PROSE, "the prose after the echo flows to the client");
    assert.deepEqual(verdicts, [false, false], "an attrs-bearing opening is a complete tag quote — it arms nothing; the refs-only close leaves nothing either");
});

test("filter: a mangled close after a ref (unclosed echo) keeps the frame armed — the span died uncleanly (#6034 vs the unclosed-echo retry tests)", () => {
    const verdicts: boolean[] = [];
    const f = createTagEchoFilter(undefined, undefined, false, undefined, (v) => verdicts.push(v));
    // The production shape from plugin-empty-turn-retry: the model opens a
    // render tag, writes a ref inside, then fails to close it (`</cp>` is the
    // mangled close). The unit dies atomically, but the mangled close is the
    // resolution event — whatever the frame still releases after it is suspect.
    f.push("\x3cacp tokens=\"247\" type=\"text\"\x3e");
    const released = f.push(` m00693</cp>${" ".repeat(80)}`);
    assert.ok(released.length > 0, "the residue after the mangled close flows to the client");
    assert.deepEqual(verdicts, [false, true], "the mangled-close resolution arms the frame; the opening itself does not");
});

test("filter: a closed span with a prose body leaves interior (markup), both in-frame and across chunks (#6034 control)", () => {
    const verdicts: boolean[] = [];
    const f = createTagEchoFilter(undefined, undefined, false, undefined, (v) => verdicts.push(v));
    f.push(`<acp tokens="5" type="text">`.replace(/</g, "\x3c").replace(/>/g, "\x3e"));
    const released = f.push(`wrapped body\x3c/acp\x3e`);
    assert.equal(released, "wrapped body", "the body is released (only the close goes)");
    assert.deepEqual(verdicts, [false, true], "the body-releasing close leaves interior; the opening itself does not");
});

test("filter: a complete refs-only echo in one buffer is a whole-dead unit — no interior verdict (#6034)", () => {
    const verdicts: boolean[] = [];
    const f = createTagEchoFilter(undefined, undefined, false, undefined, (v) => verdicts.push(v));
    const released = f.push(`prefix prose ${ECHO}`);
    assert.equal(released, "prefix prose ", "only the echo unit dies");
    assert.deepEqual(verdicts, [false], "a complete unit never leaves interior");
});

test("chat pipe: real answer + pure refs-only echo in ONE frame is NOT degenerate — no retry (#6034 sample 2 shape)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), chatFinish("stop"), DONE]));
    };
    // The exact #6034 sample-2 wire: 108 chars of real content, then the
    // model's own render tag echoed back as a complete refs-only unit — in
    // ONE buffer, so the whole-dead drop and the answer release land in the
    // same frame (the frame the ledger counts).
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", content: PROSE + ECHO }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 0, "a turn that delivered a real answer must not be regenerated");
    assert.ok(body.includes(PROSE), "the delivered answer reaches the client");
    assert.ok(!logs.some((l) => l.includes("degenerate terminal turn")), "no degenerate verdict for a healthy turn");
});

test("chat pipe: refs-only echo split across chunks, close and answer in the last frame — no retry (#6034 chunking variant)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([chatChunk({ content: "dup" }), chatFinish("stop"), DONE]));
    };
    // The open is still held when the close lands with the answer in the
    // SAME frame: the session was armed on the open, so only the close's
    // whole-dead verdict (not the one-shot notice) can keep the answer.
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", content: ECHO_OPEN }),
        chatChunk({ content: `m00258\x3c/acp\x3e ${PROSE}` }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 0, "the close's whole-dead verdict must keep the same-frame answer");
    assert.ok(body.includes(PROSE), "the delivered answer reaches the client");
    assert.ok(!logs.some((l) => l.includes("degenerate terminal turn")), "no degenerate verdict for a healthy turn");
});

test("chat pipe: a pure refs-only echo turn still retries — the control direction (#6034 vs #732)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ content: "recovered answer" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    // Whole turn = the echoed tag, nothing else: still no answer, still retry.
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", content: ECHO_OPEN }),
        chatChunk({ content: `m00258\x3c/acp\x3e` }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "an answerless echo turn must retry exactly once");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});

test("chat pipe: a closed span with a prose body still reads as markup — retry kept (#2756 control)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let refetches = 0;
    const refetch = (): Promise<ReadableStream<Uint8Array> | null> => {
        refetches += 1;
        return Promise.resolve(streamOf([
            chatChunk({ content: "recovered answer" }),
            chatFinish("stop"),
            DONE,
        ]));
    };
    // Wrapped-turn imitation: the released body IS the tag's interior —
    // the host stalls on it, so the turn stays degenerate and retries.
    await pipePluginChatWithStrip(streamOf([
        chatChunk({ role: "assistant", content: `<acp tokens="5" type="text">`.replace(/</g, "\x3c").replace(/>/g, "\x3e") }),
        chatChunk({ content: `wrapped body that is not an answer\x3c/acp\x3e` }),
        chatFinish("stop"),
        DONE,
    ]), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, "http://up");
    const body = out.join("");
    assert.equal(refetches, 1, "tag interior is markup, not an answer — the retry must fire");
    assert.ok(body.includes("recovered answer"), "the retry's answer reaches the client");
    assert.ok(logs.some((l) => l.includes("#732/#821") || l.includes("degenerate")), "the retry is logged");
});
