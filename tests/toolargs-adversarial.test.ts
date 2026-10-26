import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { coreToOpenai, coreToAnthropic, coreToResponses, coreToGoogle, openaiToCore, anthropicToCore, responsesToCore, googleToCore } from "acp-kernel/wire";
import { createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter, createGoogleAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter } from "../src/loop/index.ts";

// Adversarial byte-fidelity corpus for tool-call arguments (#1039 discipline).
//
// The invariant: arguments are user intent — every payload a host will EXECUTE
// or PERSIST must travel verbatim in EVERY direction on EVERY wire:
//
//   A. upstream SSE -> core       (adapter.parseStream; the loop's accumulated
//                                  view feeds the re-request rebuild)
//   B. core -> downstream emit    (adapter.emitToolCall; becomes the client's
//                                  persisted history)
//   C. core -> upstream rebuild   (adapter.buildRequest; the loop's re-request
//                                  body — #1960's class of hazard)
//   D. wire -> core (client echo) (kernel toCore on the rebuilt wire shape —
//                                  what the next request's history parser sees)
//
// Hazards crossed with the corpus:
//   - SSE byte chunking: whole / 1-byte / seeded RNG multi-chunk / a split at
//     EVERY byte offset (covers splits inside \\" escapes, inside multi-byte
//     UTF-8, across frame terminators, inside `data:` prefixes)
//   - upstream delta fragmentation: payload delivered as 1 or 3 fragments
//     (code-point-safe splits); responses covers BOTH of its real shapes —
//     delta accumulation (ACP tools) and done-carries-full passthrough
//     (client tools)
//   - hostile payloads: escapes, CJK, astral, literal \u sequences, tag-shaped
//     (#1039), SSE-frame-shaped, empty, whitespace, long, unparseable-but-
//     forwardable, duplicate keys
//
// Anthropic and Google carry PARSED objects on their wires (tool_use.input /
// functionCall.args), so for those directions the contract is canonical JSON
// equivalence; the string-carrying wires (chat, responses) are asserted
// byte-exact.

const LT = "\x3c";
const GT = "\x3e";
const TAG = `${LT}acp tokens="247" type="text"${GT}m00001${LT}/acp${GT}`;
const CLOSE_MARK = `${LT}/acp${GT}`;

const TOOL = "bash";
const ACP_TOOL = "compress";
const CALL_ID = "call_corpus_1";
const ITEM_ID = "fc_corpus_1";

// String.raw keeps the escape sequences as literal bytes — the whole point of
// the corpus. `json: true` marks payloads that must survive JSON parse (for
// the object-carrying wire assertions); the rest are forwarded as-is.
const PAYLOADS: Array<{ name: string; value: string; json: boolean }> = [
    { name: "quotes/escapes", value: String.raw`{"cmd":"echo \"quoted\" and \\\"escaped\\\" back"}`, json: true },
    { name: "crlf/tab escapes", value: String.raw`{"path":"/tmp/f","content":"line1\nline2\ttab\r\nwin"}`, json: true },
    { name: "cjk multibyte", value: `{"zh":"中文工具参数内容","jp":"日本語テストです"}`, json: true },
    { name: "astral 4-byte", value: `{"emoji":"🧬🪫astral"}`, json: true },
    { name: "literal backslash-u sequences", value: String.raw`{"esc":"\\u00e9 literal-\u00e9 mixed"}`, json: true },
    // tag bytes inside a VALID json string (the #1039 hazard: shape-based
    // filters cannot tell this from a render-tag echo).
    { name: "tag-shaped (#1039)", value: `{"note":${JSON.stringify(TAG)},"tail":${JSON.stringify(`ends ${CLOSE_MARK}`)}}`, json: true },
    // newline+escape soup inside the string (SSE frame look-alike): valid
    // JSON, but the wire frames must not mistake it for frame terminators.
    { name: "sse-frame-shaped", value: `{"fake":${JSON.stringify("data: {\"x\":1}\n\n[DONE]")}}`, json: true },
    { name: "empty string", value: `{"empty":""}`, json: true },
    { name: "bare empty args", value: "", json: false },
    { name: "whitespace-only", value: "   ", json: false },
    { name: "long 2KiB", value: `{"long":"${"A".repeat(2048)}"}`, json: true },
    { name: "unparseable truncated", value: String.raw`{"cmd":"truncated pa`, json: false },
    { name: "duplicate keys + nesting", value: `{"dup":1,"dup":2,"nested":{"a":[1,2,{"b":null}]}}`, json: true },
];

// ---- code-point-safe fragmentation (never splits a surrogate pair) ----
function cpFragments(p: string, parts: number): string[] {
    const cut = (k: number): number => {
        let i = Math.floor((p.length * k) / parts);
        while (i > 0 && i < p.length && (p.charCodeAt(i - 1) & 0xfc00) === 0xd800) i++;
        return i;
    };
    if (parts <= 1) return [p];
    const idx = Array.from({ length: parts - 1 }, (_, j) => cut(j + 1));
    const out: string[] = [];
    let prev = 0;
    for (const i of [...idx, p.length]) {
        out.push(p.slice(prev, i));
        prev = i;
    }
    return out;
}

// ---- upstream frame builders (realistic wire shapes) ----
const chatFrame = (delta: Record<string, unknown>, finish: string | null = null): string =>
    `data: ${JSON.stringify({ id: "chatcmpl-c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function chatUpstream(frags: string[]): string {
    let out = "";
    frags.forEach((f, i) => {
        out += chatFrame(i === 0
            ? { tool_calls: [{ index: 0, id: CALL_ID, type: "function", function: { name: TOOL, arguments: f } }] }
            : { tool_calls: [{ index: 0, function: { arguments: f } }] });
    });
    out += chatFrame({}, "tool_calls");
    out += "data: [DONE]\n\n";
    return out;
}

function anthropicUpstream(frags: string[]): string {
    let out = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_c", model: "m" } })}\n\n`;
    out += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: CALL_ID, name: TOOL, input: {} } })}\n\n`;
    for (const f of frags) {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: f } })}\n\n`;
    }
    out += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`;
    out += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`;
    out += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return out;
}

// Responses wire has two real argument paths:
//  - ACP tools (compress/...) accumulate `function_call_arguments.delta`
//    fragments; the done event may be empty.
//  - client tools relay passthrough: the full arguments ride on
//    `output_item.done`'s item (this is how OpenAI actually streams them).
function responsesUpstream(frags: string[], opts: { acpTool: boolean; doneCarriesFull: boolean }): string {
    const name = opts.acpTool ? ACP_TOOL : TOOL;
    let out = `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: ITEM_ID, call_id: CALL_ID, name, arguments: "" } })}\n\n`;
    const deltas = opts.acpTool || !opts.doneCarriesFull ? frags : [];
    for (const f of deltas) {
        out += `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: ITEM_ID, delta: f })}\n\n`;
    }
    const doneArgs = opts.doneCarriesFull ? frags.join("") : "";
    out += `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: ITEM_ID, arguments: doneArgs })}\n\n`;
    const doneItemArgs = opts.acpTool ? undefined : doneArgs;
    out += `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: ITEM_ID, call_id: CALL_ID, name, ...(doneItemArgs !== undefined ? { arguments: doneItemArgs } : {}) } })}\n\n`;
    out += `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_c" } })}\n\n`;
    return out;
}

function googleUpstreamArgs(args: unknown): string {
    return `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: TOOL, args } }] }, index: 0, finishReason: "STOP" }] })}\n\n`;
}

// ---- adapters ----
const openaiAdapter = (): CompressLoopAdapter => createOpenaiAdapter({ model: "m", messages: [], stream: true });
const anthropicAdapter = (): CompressLoopAdapter => createAnthropicAdapter({ model: "m", max_tokens: 64, messages: [], stream: true });
const responsesAdapter = (): CompressLoopAdapter => createResponsesAdapter();
const googleAdapter = (): CompressLoopAdapter => createGoogleAdapter({ contents: [] }, undefined, undefined, "gemini-test");

// ---- stream plumbing (byte-preserving: chunks cross as raw bytes, never
// re-encoded through a JS string — a byte split inside multi-byte UTF-8 must
// reach the parser as the original bytes) ----
function streamOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(new Uint8Array(chunks[i++]!));
            } else {
                controller.close();
            }
        },
    });
}

async function toolArgsOf(adapter: CompressLoopAdapter, chunks: Buffer[]): Promise<string> {
    let args = "";
    for await (const ev of adapter.parseStream(streamOf(chunks), 1)) {
        if (ev.kind === "tool_call") args += (ev as { arguments: string }).arguments;
    }
    return args;
}

// ---- chunkings ----
function lcgChunks(b: Buffer, max: number, seed: number): Buffer[] {
    let s = seed >>> 0 || 1;
    const out: Buffer[] = [];
    for (let i = 0; i < b.length;) {
        const n = 1 + (s % max);
        s = (s * 1103515245 + 12345) >>> 0;
        out.push(b.subarray(i, Math.min(b.length, i + n)));
        i += n;
    }
    return out;
}

const CHUNKINGS: Array<[string, (b: Buffer) => Buffer[]]> = [
    ["whole", (b) => [b]],
    ["1-byte", (b) => Array.from({ length: b.length }, (_, i) => b.subarray(i, i + 1))],
    ["rng-17", (b) => lcgChunks(b, 17, 1)],
    ["rng-97", (b) => lcgChunks(b, 97, 2)],
];

// ---- downstream emit extraction ----
function sseDataFrames(buf: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
            const v = JSON.parse(line.slice(6));
            if (v && typeof v === "object") out.push(v as Record<string, unknown>);
        } catch { /* skip */ }
    }
    return out;
}

const chatEmitArgs = (buf: string): string => {
    let args = "";
    for (const ev of sseDataFrames(buf)) {
        const ch = (ev["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
        const tcs = ((ch?.["delta"] as Record<string, unknown> | undefined)?.["tool_calls"]) as Array<Record<string, unknown>> | undefined;
        for (const tc of tcs ?? []) {
            const fn = tc["function"] as Record<string, unknown> | undefined;
            if (typeof fn?.["arguments"] === "string") args += fn["arguments"];
        }
    }
    return args;
};

const anthropicEmitArgs = (buf: string): string => {
    let args = "";
    for (const ev of sseDataFrames(buf)) {
        if (ev["type"] === "content_block_delta") {
            const d = ev["delta"] as Record<string, unknown> | undefined;
            if (d?.["type"] === "input_json_delta" && typeof d["partial_json"] === "string") args += d["partial_json"];
        }
    }
    return args;
};

const responsesEmitArgs = (buf: string): string => {
    let delta = "";
    let done: string | undefined;
    for (const ev of sseDataFrames(buf)) {
        if (ev["type"] === "response.function_call_arguments.delta" && typeof ev["delta"] === "string") delta += ev["delta"];
        if (ev["type"] === "response.function_call_arguments.done" && typeof ev["arguments"] === "string") done = ev["arguments"];
    }
    return done ?? delta;
};

const googleEmitArgs = (buf: string): unknown => {
    for (const ev of sseDataFrames(buf)) {
        const part = ((ev["candidates"] as Array<Record<string, unknown>> | undefined)?.[0]?.["content"] as Record<string, unknown> | undefined)?.["parts"] as Array<Record<string, unknown>> | undefined;
        const fc = part?.[0]?.["functionCall"] as Record<string, unknown> | undefined;
        if (fc) return fc["args"];
    }
    return undefined;
};

const coreToolMsg = (args: string): CoreMessage[] =>
    [{ id: "h_corpus_tc", role: "assistant", contentType: "tool-call", toolName: TOOL, toolCallId: CALL_ID, text: args }] as unknown as CoreMessage[];

const jsonEquiv = (raw: string): unknown => JSON.parse(raw);

// Direction A: upstream parse — byte-exact on chat/anthropic/responses,
// byte-exact passthrough for google string args.
for (const p of PAYLOADS) {
    for (const frags of [cpFragments(p.value, 1), cpFragments(p.value, 3)]) {
        const cases: Array<[string, Buffer]> = [
            ["chat", Buffer.from(chatUpstream(frags), "utf8")],
            ["anthropic", Buffer.from(anthropicUpstream(frags), "utf8")],
            ["responses-acp-delta", Buffer.from(responsesUpstream(frags, { acpTool: true, doneCarriesFull: false }), "utf8")],
            ["responses-client-full", Buffer.from(responsesUpstream(frags, { acpTool: false, doneCarriesFull: true }), "utf8")],
            ["google-string-args", Buffer.from(googleUpstreamArgs(frags.join("")), "utf8")],
        ];
        for (const [wire, raw] of cases) {
            for (const [cname, chunk] of CHUNKINGS) {
                test(`A ${wire} parse verbatim: ${p.name} [frags=${frags.length}, ${cname}]`, async () => {
                    const args = await toolArgsOf(
                        wire.startsWith("responses") ? responsesAdapter()
                        : wire === "chat" ? openaiAdapter()
                        : wire === "anthropic" ? anthropicAdapter()
                        : googleAdapter(),
                        chunk(raw),
                    );
                    if (wire === "google-string-args") {
                        assert.equal(args, p.value, "google string args passthrough");
                    } else {
                        assert.equal(args, p.value, `${wire} args mutated`);
                    }
                });
            }
        }
    }
}

// Direction A2: google object-args frame — canonical stringification with the
// payload content preserved.
{
    const obj = { zh: "中文", nested: { b: [1, null] } };
    const raw = Buffer.from(googleUpstreamArgs(obj), "utf8");
    test("A google parse: object args canonicalized, content preserved", async () => {
        const args = await toolArgsOf(googleAdapter(), [raw]);
        assert.deepEqual(JSON.parse(args), obj);
    });
}

// Direction A4: a split at EVERY byte offset of the args region — the hazard
// class fixed-frame tests miss: splits inside escapes, inside multi-byte
// UTF-8, across frame terminators, mid-`data:`-prefix.
for (const p of PAYLOADS) {
    if (p.value.length > 200) continue;
    const raw = Buffer.from(chatUpstream([p.value]), "utf8");
    test(`A4 chat every-byte-offset splits: ${p.name}`, async () => {
        for (let i = 1; i < raw.length; i++) {
            const args = await toolArgsOf(openaiAdapter(), [raw.subarray(0, i), raw.subarray(i)]);
            assert.equal(args, p.value, `split at byte ${i} mutated args`);
        }
    });
}

// Direction B: core -> downstream emit — byte-exact on chat/anthropic/responses,
// canonical object on google.
for (const p of PAYLOADS) {
    for (const wire of ["chat", "anthropic", "responses", "google"] as const) {
        test(`B ${wire} emit verbatim: ${p.name}`, () => {
            const adapter = wire === "chat" ? openaiAdapter()
                : wire === "anthropic" ? anthropicAdapter()
                : wire === "responses" ? responsesAdapter()
                : googleAdapter();
            const buf = adapter.emitToolCall({ name: TOOL, callId: CALL_ID, arguments: p.value }).toString("utf8");
            if (wire === "google") {
                if (p.json) assert.deepEqual(googleEmitArgs(buf), jsonEquiv(p.value));
                else assert.deepEqual(googleEmitArgs(buf), {}, "google degrades unparseable args to {} (documented)");
            } else if (wire === "anthropic") {
                assert.equal(anthropicEmitArgs(buf), p.value, "anthropic partial_json carries the raw string byte-exact");
                if (p.json) assert.deepEqual(JSON.parse(anthropicEmitArgs(buf)), jsonEquiv(p.value));
            } else {
                const got = wire === "chat" ? chatEmitArgs(buf) : responsesEmitArgs(buf);
                assert.equal(got, p.value);
            }
        });
    }
}

// Direction C: core -> upstream rebuild — byte-exact on string wires;
// canonical object on anthropic/google (their wires carry parsed JSON).
for (const p of PAYLOADS) {
    const msgs = coreToolMsg(p.value);
    test(`C chat rebuild verbatim: ${p.name}`, () => {
        const body = openaiAdapter().buildRequest(msgs, "sys", { model: "m", messages: [], stream: true });
        const sent = (body["messages"] as Array<Record<string, unknown>>).flatMap((m) => (m["tool_calls"] as Array<Record<string, unknown>> | undefined) ?? []);
        assert.equal(sent.length, 1);
        assert.equal(((sent[0]!["function"] as Record<string, unknown>)["arguments"]), p.value);
    });
    test(`C responses rebuild verbatim: ${p.name}`, () => {
        const body = responsesAdapter().buildRequest(msgs, "sys", { model: "m", input: [], stream: true });
        const items = (body["input"] as Array<Record<string, unknown>>).filter((i) => i["type"] === "function_call");
        assert.equal(items.length, 1);
        assert.equal(items[0]!["arguments"], p.value);
    });
    if (p.json) {
        test(`C anthropic rebuild canonical: ${p.name}`, () => {
            const body = anthropicAdapter().buildRequest(msgs, "sys", { model: "m", max_tokens: 64, messages: [], stream: true });
            const uses = (body["messages"] as Array<Record<string, unknown>>).flatMap((m) => (m["content"] as Array<Record<string, unknown>> | undefined) ?? []).filter((c) => c["type"] === "tool_use");
            assert.equal(uses.length, 1);
            assert.deepEqual(uses[0]!["input"], jsonEquiv(p.value));
        });
        test(`C google rebuild canonical: ${p.name}`, () => {
            const body = googleAdapter().buildRequest(msgs, "sys", { contents: [] });
            const parts = (body["contents"] as Array<Record<string, unknown>>).flatMap((c) => (c["parts"] as Array<Record<string, unknown>> | undefined) ?? []);
            const fcs = parts.filter((x) => x["functionCall"] !== undefined).map((x) => x["functionCall"] as Record<string, unknown>);
            assert.equal(fcs.length, 1);
            assert.deepEqual(fcs[0]!["args"], jsonEquiv(p.value));
        });
    }
}

// Direction D: the client echoes the rebuilt wire back — the kernel toCore
// parsers must recover the exact same core text (string wires byte-exact,
// object wires canonical). This is the path the NEXT request's history
// takes; a mutation here compounds every turn.
for (const p of PAYLOADS) {
    test(`D chat wire round-trip: ${p.name}`, () => {
        const msgs = coreToOpenai(coreToolMsg(p.value)) as unknown as Array<Record<string, unknown>>;
        const body = { model: "m", messages: msgs };
        const flat = openaiToCore(body as never);
        const tc = flat.msgs.find((m) => m.contentType === "tool-call");
        assert.ok(tc, "tool-call core message recovered");
        assert.equal(tc!.text, p.value);
    });
    if (p.json) {
        test(`D anthropic wire round-trip: ${p.name}`, () => {
            const msgs = coreToAnthropic(coreToolMsg(p.value)) as unknown as Array<Record<string, unknown>>;
            const body = { model: "m", max_tokens: 64, messages: msgs };
            const flat = anthropicToCore(body as never);
            const tc = flat.msgs.find((m) => m.contentType === "tool-call");
            assert.ok(tc, "tool-call core message recovered");
            assert.equal(typeof tc!.text, "string");
            assert.deepEqual(JSON.parse(tc!.text as string), jsonEquiv(p.value));
        });
        test(`D responses wire round-trip: ${p.name}`, () => {
            const items = coreToResponses(coreToolMsg(p.value)) as unknown as Array<Record<string, unknown>>;
            const body = { model: "m", input: items };
            const flat = responsesToCore(body as never);
            const tc = flat.msgs.find((m) => m.contentType === "tool-call");
            assert.ok(tc, "tool-call core message recovered");
            assert.equal(tc!.text, p.value);
        });
        test(`D google wire round-trip: ${p.name}`, () => {
            const contents = coreToGoogle(coreToolMsg(p.value)) as unknown as Array<Record<string, unknown>>;
            const body = { contents };
            const flat = googleToCore(body as never);
            const tc = flat.msgs.find((m) => m.contentType === "tool-call");
            assert.ok(tc, "tool-call core message recovered");
            assert.equal(typeof tc!.text, "string");
            assert.deepEqual(JSON.parse(tc!.text as string), jsonEquiv(p.value));
        });
    }
}
