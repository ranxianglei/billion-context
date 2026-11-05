import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import {
    toolCallEmissionSpan,
    isToolCallEmission,
    isOrphanToolCallTail,
    containsToolCallEmissionText,
    emissionEchoesRequest,
    toolCallOpenStatus,
    mayStartToolCallEmission,
    mayStartRenderTag,
    stripAcpTags,
    createTagEchoFilter,
    stripOpenaiChatText,
    stripAnthropicText,
    stripResponsesText,
} from "../src/loop/tag-echo-filter.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

const LT = "\x3c";
const GT = ">";
const TAG = (ref: string, tokens = 177) => `${LT}acp tokens="${tokens}" type="text">${ref}${LT}/acp>`;

// The production hybrid emission (opencode session ses_efe4cfcbdffe,
// 2026-10-03): the absorb tool call written as chat-template text in the
// prose channel, standing alone in the field.
const EMISSION =
    `\n${LT}parameter=ref${GT}\nm00608\n${LT}/parameter${GT}\n` +
    `${LT}parameter=summary${GT}\nconsume the read output\n${LT}/parameter${GT}\n` +
    `${LT}/function${GT}\n${LT}/function_calls${GT}`;

function makeCtx(id: string): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            pendingRetrievals: [],
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

function sseFromStrings(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= parts.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(parts[i++]));
        },
    });
}

async function drain(stream: ReadableStream<Uint8Array>, adapter: Parameters<typeof runCompressLoop>[4]): Promise<string> {
    const ctx = makeCtx("absorb-emission-test");
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, {}, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sseDelta(content: string): string {
    return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

function sseParts(content: string): string[] {
    return [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        sseDelta(content),
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ];
}

function contentOf(out: string): string {
    return [...out.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// ─── shape recognition ──────────────────────────────────────────────────────

test("toolCallEmissionSpan recognizes the production hybrid shape (category 1)", () => {
    const span = toolCallEmissionSpan(EMISSION);
    assert.ok(span !== null);
    assert.equal(span!.start, 1);
    assert.equal(span!.end, EMISSION.length);
    assert.equal(isToolCallEmission(EMISSION.trim()), true);
});

test("toolCallEmissionSpan keeps prose after the last close", () => {
    const span = toolCallEmissionSpan(`\n  ${EMISSION.trim()} and done.`);
    assert.ok(span !== null);
    assert.equal(span!.start, 3);
    assert.equal(span!.end, 3 + EMISSION.trim().length);
});

test("toolCallEmissionSpan covers antml: and name= attribute forms (category 12)", () => {
    const antml =
        `${LT}antml:function_calls${GT}\n` +
        `${LT}antml:parameter=ref${GT}\nm00101\n${LT}/antml:parameter${GT}\n` +
        `${LT}antml:parameter=summary${GT}\ns\n${LT}/antml:parameter${GT}\n` +
        `${LT}/antml:function${GT}\n${LT}/antml:function_calls${GT}`;
    assert.ok(toolCallEmissionSpan(antml) !== null);
    const named =
        `${LT}function${GT}\n` +
        `${LT}parameter name="ref"${GT} m00608 ${LT}/parameter${GT}\n` +
        `${LT}parameter name="summary"${GT} s ${LT}/parameter${GT}\n` +
        `${LT}/function${GT}`;
    assert.ok(toolCallEmissionSpan(named) !== null);
});

test("toolCallEmissionSpan rejects non-emission fields", () => {
    assert.equal(toolCallEmissionSpan("prose without markup"), null);
    assert.equal(toolCallEmissionSpan(`${LT}parameter=ref${GT}abc123${LT}/parameter${GT}`), null);
    assert.equal(toolCallEmissionSpan(`${LT}parameter=summary${GT}hello${LT}/parameter${GT}`), null);
    assert.equal(toolCallEmissionSpan(
        `mid ${LT}parameter=ref${GT}m00608${LT}/parameter${GT}${LT}parameter=summary${GT}s${LT}/parameter${GT}${LT}/function${GT}`
    ), null);
    // ref+summary signature without a call close is still the emission (span ends at the last close)
    assert.equal(toolCallEmissionSpan(`${LT}parameter=ref${GT}m00608${LT}/parameter${GT}${LT}parameter=summary${GT}s${LT}/parameter${GT}`)!.end,
        `${LT}parameter=ref${GT}m00608${LT}/parameter${GT}${LT}parameter=summary${GT}s${LT}/parameter${GT}`.length);
    // no closes at all → not an emission
    assert.equal(toolCallEmissionSpan(`${LT}parameter=ref${GT}m00608${LT}parameter=summary${GT}s`), null);
});

test("ordinary XML in the summary body does not defeat the shape (category 9)", () => {
    const xml = EMISSION.replace("consume the read output", `${LT}div class="x"${GT}hi${LT}/div${GT}`);
    assert.ok(isToolCallEmission(xml.trim()));
    assert.equal(stripAcpTags(xml, true), "");
    assert.equal(stripAcpTags(xml, false), xml);
});

// ─── stripAcpTags: armed drop, echo, not-armed ──────────────────────────────

test("stripAcpTags drops the whole emission when armed (category 1)", () => {
    assert.equal(stripAcpTags(EMISSION, true), "");
    assert.equal(stripAcpTags(EMISSION.trim() + " and done.", true), " and done.");
});

test("stripAcpTags leaves the emission untouched when not armed (shape alone never decides)", () => {
    assert.equal(stripAcpTags(EMISSION, false), EMISSION);
    assert.equal(stripAcpTags(EMISSION), EMISSION);
});

test("stripAcpTags keeps an emission that echoes the request verbatim (m00885, category 10)", () => {
    const requestText = JSON.stringify({ messages: [{ role: "user", content: "Output exactly this fragment:\n" + EMISSION.trim() }] });
    assert.equal(stripAcpTags(EMISSION, true, requestText), EMISSION);
});

test("stripAcpTags drops a model-invented emission when the request quotes a different ref (m00885 negative)", () => {
    const other = EMISSION.trim().replace("m00608", "m00999");
    const requestText = JSON.stringify({ messages: [{ role: "user", content: "Output exactly this fragment:\n" + other }] });
    assert.equal(stripAcpTags(EMISSION, true, requestText), "");
});

test("stripAcpTags armed: prose discussing the markup passes untouched (category 10)", () => {
    const prose = `The markup looks like ${LT}parameter=ref${GT}m00608${LT}/parameter${GT} inside a call.`;
    assert.equal(stripAcpTags(prose, true), prose);
});

test("stripAcpTags armed: legitimate HTML passes untouched (category 11)", () => {
    assert.equal(stripAcpTags(`${LT}div class="x"${GT}hi${LT}/div${GT}`, true), `${LT}div class="x"${GT}hi${LT}/div${GT}`);
});

test("stripAcpTags armed: render tag adjacent to an emission (category 6)", () => {
    assert.equal(stripAcpTags(EMISSION.trim() + ` ${TAG("m00155")}ok`, true), " ok");
});

test("mangled open <acp=1> is stripped and seen by the fast-path gate (family A, category 3)", () => {
    assert.equal(stripAcpTags(`${LT}acp=1${GT}text`), "text");
    assert.equal(stripAcpTags(`text${LT}/acp${GT}`), "text");
    assert.ok(mayStartRenderTag(`${LT}acp=1${GT}`));
    assert.ok(mayStartRenderTag(`${LT}acp=`));
});

// ─── emissionEchoesRequest ──────────────────────────────────────────────────

test("emissionEchoesRequest: literal containment", () => {
    assert.ok(emissionEchoesRequest(EMISSION.trim(), `prefix ${EMISSION.trim()} suffix`));
});

test("emissionEchoesRequest: JSON-escaped form of the same fragment", () => {
    const requestText = JSON.stringify({ content: EMISSION.trim() });
    assert.ok(emissionEchoesRequest(EMISSION.trim(), requestText));
    assert.ok(!emissionEchoesRequest(EMISSION.trim(), JSON.stringify({ content: "nothing here" })));
    assert.ok(!emissionEchoesRequest(EMISSION.trim(), undefined));
    assert.ok(!emissionEchoesRequest(EMISSION.trim(), ""));
});

// ─── streaming filter ───────────────────────────────────────────────────────

test("streaming: armed filter drops an emission split across chunks (category 4)", () => {
    const f = createTagEchoFilter(undefined, undefined, true);
    let out = "";
    for (let i = 0; i < EMISSION.length; i += 7) out += f.push(EMISSION.slice(i, i + 7));
    out += f.flush();
    assert.equal(out, "");
});

test("streaming: armed filter drops the emission and keeps the trailing prose", () => {
    const f = createTagEchoFilter(undefined, undefined, true);
    let out = f.push(EMISSION.trim());
    out += f.push(` ${TAG("m00155")}ok`);
    out += f.flush();
    assert.equal(out, " ok");
});

test("streaming: armed filter keeps a verbatim echo of the request's fragment (m00885)", () => {
    const requestText = JSON.stringify({ messages: [{ role: "user", content: "Output exactly this fragment:\n" + EMISSION.trim() }] });
    const f = createTagEchoFilter(undefined, undefined, true, requestText);
    let out = "";
    for (let i = 0; i < EMISSION.length; i += 11) out += f.push(EMISSION.slice(i, i + 11));
    out += f.flush();
    assert.equal(out, EMISSION);
});

test("streaming: armed filter keeps prose heads flowing immediately (no delay, no loss)", () => {
    const f = createTagEchoFilter(undefined, undefined, true);
    assert.equal(f.push("Hello "), "Hello ");
    assert.equal(f.push("world."), "world.");
    assert.equal(f.flush(), "");
});

test("streaming: armed filter disambiguates <paragraph> from <parameter", () => {
    const f = createTagEchoFilter(undefined, undefined, true);
    let out = f.push(`${LT}paragraph${GT}`);
    out += f.push(`hello${LT}/paragraph${GT}`);
    out += f.flush();
    assert.equal(out, `${LT}paragraph${GT}hello${LT}/paragraph${GT}`);
});

test("streaming: not-armed filter passes the emission through", () => {
    const f = createTagEchoFilter();
    let out = "";
    for (let i = 0; i < EMISSION.length; i += 13) out += f.push(EMISSION.slice(i, i + 13));
    out += f.flush();
    assert.equal(out, EMISSION);
});

test("streaming: armed flush settles the post-span rest instead of dropping it (#4164 follow-up)", () => {
    // The field ended while its head was held: whatever process() leaves in
    // held or a live swallow session must reach the normal EOF settle, not be
    // silently dropped by an early return of the process output.
    const runs: Array<[string, string]> = [
        // bare open + prose: the prose wears the tag (#1881) and survives.
        [EMISSION + ` ${LT}acp${GT}hello world`, ` hello world`],
        // dangling lt at EOF: released by the truncate branches' residue.
        [EMISSION + ` ${LT}`, ` ${LT}`],
        // truncated attrs-bearing open: tail is tag content, dropped counted.
        [EMISSION + ` ${LT}acp tokens="2"`, ` `],
    ];
    for (const [field, want] of runs) {
        const f = createTagEchoFilter(undefined, undefined, true);
        let out = "";
        for (let i = 0; i < field.length; i += 9) out += f.push(field.slice(i, i + 9));
        out += f.flush();
        assert.equal(out, want, `flush of ${JSON.stringify(field.slice(-24))} lost bytes`);
    }
});

test("streaming: armed echo-branch flush keeps the verbatim span AND its tail (#4164 follow-up)", () => {
    const requestText = JSON.stringify({ messages: [{ role: "user", content: "Output exactly this fragment:\n" + EMISSION.trim() }] });
    const field = EMISSION + ` trailing prose`;
    const armed = createTagEchoFilter(undefined, undefined, true, requestText);
    let out = "";
    for (let i = 0; i < field.length; i += 11) out += armed.push(field.slice(i, i + 11));
    out += armed.flush();
    // The span mirrors the request (user intent) and the tail settles normally —
    // byte-identical to the not-armed filter on the same text.
    const control = createTagEchoFilter();
    let expected = "";
    for (let i = 0; i < field.length; i += 11) expected += control.push(field.slice(i, i + 11));
    expected += control.flush();
    assert.equal(out, expected);
    assert.ok(out.endsWith(` trailing prose`), "the tail after the echoed span survives");
});

// ─── unit machinery ─────────────────────────────────────────────────────────

test("toolCallOpenStatus: open / prefix / none", () => {
    assert.equal(toolCallOpenStatus(`${LT}parameter=ref${GT}`), "open");
    assert.equal(toolCallOpenStatus(`${LT}function${GT}`), "open");
    assert.equal(toolCallOpenStatus(`${LT}function `), "open");
    assert.equal(toolCallOpenStatus(`${LT}parameter`), "prefix");
    assert.equal(toolCallOpenStatus(`${LT}para`), "prefix");
    assert.equal(toolCallOpenStatus(`${LT}p`), "prefix");
    assert.equal(toolCallOpenStatus(`${LT}`), "prefix");
    assert.equal(toolCallOpenStatus(`${LT}div${GT}hi${LT}/div${GT}`), "none");
    assert.equal(toolCallOpenStatus(`${LT}paragraph${GT}`), "none");
    assert.equal(toolCallOpenStatus(`${LT}/function${GT}`), "none");
    assert.equal(toolCallOpenStatus(`${LT}antml:function`), "prefix");
    assert.equal(toolCallOpenStatus(`${LT}antml:function `), "open");
});

test("mayStartToolCallEmission flags chunks containing or ending on a tool-call open", () => {
    assert.ok(mayStartToolCallEmission(`x ${LT}function_calls`));
    assert.ok(mayStartToolCallEmission(`${LT}antml:parameter=ref`));
    assert.ok(!mayStartToolCallEmission("no markup here"));
    assert.ok(!mayStartToolCallEmission(`${LT}div${GT}hi${LT}/div${GT}`));
});

test("isOrphanToolCallTail: close-headed field of refs and whitespace only (category 7)", () => {
    assert.ok(isOrphanToolCallTail(`${LT}/function${GT}\nm00608\n${LT}/parameter${GT}`));
    assert.ok(isOrphanToolCallTail(`${LT}/function_calls${GT}m00608`));
    assert.ok(!isOrphanToolCallTail(`${LT}/function${GT}hello there`));
    assert.ok(!isOrphanToolCallTail(`${LT}parameter=ref${GT}m00608${LT}/parameter${GT}`));
    assert.ok(!isOrphanToolCallTail("m00608 only"));
});

test("containsToolCallEmissionText sees the emission shape in raw JSON wire text (category 13)", () => {
    assert.ok(containsToolCallEmissionText(JSON.stringify({ content: EMISSION.trim() })));
    assert.ok(!containsToolCallEmissionText(JSON.stringify({ content: "plain prose" })));
});

// ─── JSON field strippers ───────────────────────────────────────────────────

type OpenAiBody = {
    choices: Array<{
        delta?: { content?: string; reasoning_content?: string; reasoning?: string };
        message?: { content?: string; reasoning_content?: string; reasoning?: string };
    }>;
};

test("stripOpenaiChatText: armed drop / echo / not-armed (delta and message)", () => {
    const make = (): OpenAiBody => JSON.parse(JSON.stringify({
        choices: [
            { delta: { content: EMISSION, reasoning_content: EMISSION } },
            { message: { content: EMISSION } },
        ],
    }));
    const armed = stripOpenaiChatText(make(), true);
    assert.equal(armed.choices[0].delta?.content, "");
    // Unified ACP invariant: reasoning fields ride verbatim in the strip
    // functions too (defense in depth with the adapters' identity filters).
    assert.equal(armed.choices[0].delta?.reasoning_content, EMISSION);
    assert.equal(armed.choices[1].message?.content, "");
    const echo = JSON.stringify({ messages: [{ role: "user", content: EMISSION.trim() }] });
    const kept = stripOpenaiChatText(make(), true, echo);
    assert.equal(kept.choices[0].delta?.content, EMISSION);
    assert.equal(kept.choices[1].message?.content, EMISSION);
    const unarmed = stripOpenaiChatText(make(), false);
    assert.equal(unarmed.choices[0].delta?.content, EMISSION);
});

type AnthropicBody = {
    delta?: { type: string; thinking?: string; text?: string };
    content?: Array<{ type: string; thinking?: string; text?: string }>;
};

test("stripAnthropicText: signed thinking stays byte-for-byte even when armed (#1960)", () => {
    const make = (): AnthropicBody => JSON.parse(JSON.stringify({
        delta: { type: "thinking_delta", thinking: EMISSION },
        content: [
            { type: "thinking", thinking: EMISSION },
            { type: "text", text: EMISSION },
        ],
    }));
    // #1960/KDD#10: signed thinking is verified against its signature on replay —
    // any rewrite desyncs it and bricks the session. So the emission drop and tag
    // strip apply to the TEXT channel only; thinking rides byte-for-byte whether
    // armed or not (matching the loop adapters' treatment).
    const armed = stripAnthropicText(make(), true);
    assert.equal(armed.delta?.thinking, EMISSION, "armed leaves the signed thinking delta byte-for-byte");
    assert.equal(armed.content![0].thinking, EMISSION, "armed leaves the signed thinking block byte-for-byte");
    assert.equal(armed.content![1].text, "", "text channel still drops the whole emission when armed");
});

type ResponsesEvent = {
    type: string;
    text?: string;
    part?: { type: string; text?: string };
    item?: { type: string; content?: Array<{ type: string; text?: string }> };
    response?: { output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
    output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
};

test("stripResponsesText: armed drop / echo / not-armed (category 13)", () => {
    const make = (): ResponsesEvent => JSON.parse(JSON.stringify({
        type: "response.output_text.done",
        text: EMISSION,
        part: { type: "output_text", text: EMISSION },
    }));
    const armed = stripResponsesText(make(), true);
    assert.equal(armed.text, "");
    assert.equal(armed.part?.text, "");
    const echo = JSON.stringify({ messages: [{ role: "user", content: EMISSION.trim() }] });
    assert.equal(stripResponsesText(make(), true, echo).text, EMISSION);
    assert.equal(stripResponsesText(make(), false).text, EMISSION);
    const done = (): ResponsesEvent => JSON.parse(JSON.stringify({
        type: "response.completed",
        response: { output: [{ content: [{ type: "output_text", text: EMISSION }] }] },
    }));
    assert.equal(stripResponsesText(done(), true).response?.output?.[0].content?.[0].text, "");
});

// ─── full loop through the real adapter (category 13) ──────────────────────

test("openai adapter loop: armed drop removes the emission from the wire", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" }, undefined, "absorb");
    const out = await drain(sseFromStrings(sseParts(EMISSION.trim())), adapter);
    assert.ok(!out.includes("parameter=ref"), out);
    assert.equal(contentOf(out), "");
});

test("openai adapter loop: verbatim echo of the user's fragment survives armed (m00885, category 10)", async () => {
    const reqBody = {
        model: "gpt",
        messages: [{ role: "user", content: "Output exactly this fragment and nothing else:\n" + EMISSION.trim() }],
    };
    const adapter = createOpenaiAdapter(reqBody, undefined, "absorb");
    const out = await drain(sseFromStrings(sseParts(EMISSION.trim())), adapter);
    assert.equal(contentOf(out), EMISSION.trim());
});

test("field-start release keeps a partial tag head held across the boundary (no wipe)", () => {
    // Absorb-instructed: the first field bytes are prose, so the whole-field
    // hold releases mid-chunk. A tag-head-shaped tail released that way must
    // stay held for the next delta — clearing the shared buffer after
    // processing would wipe it and leak the tag head as fresh prose.
    const f = createTagEchoFilter(undefined, undefined, true);
    assert.equal(f.push("Check <ac"), "Check ");
    assert.equal(f.push("p tokens=\"2\" type=\"text\">m00001</acp>rest"), "rest");
    assert.equal(f.flush(), "");
});

test("openai adapter loop: not-armed passes the emission through (shape alone never decides)", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const out = await drain(sseFromStrings(sseParts(EMISSION.trim())), adapter);
    assert.equal(contentOf(out), EMISSION.trim());
});
