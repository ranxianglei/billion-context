// #5534: strict-JSON upstreams (infernix-serve) JSON-parse EVERY history
// tool_calls[*].function.arguments and reject the whole request on the first
// unparseable payload (500 parse_error.101). bili's emergency-truncate latch
// replays clipped text keyed by REF alone (kernel/src/compress.ts
// emergencyTruncateNode); when a cold-load ledger restamp
// (src/persist.ts maybeRestampToLedger) renumbers refs under a surviving
// latch entry, the clip lands on whatever message now holds the number —
// including an assistant tool-call core whose `text` IS the arguments JSON.
// The egress guards (src/util.ts hardenOpenaiToolCallArguments /
// hardenResponsesFunctionCallArguments) replace already-invalid payloads with
// a valid placeholder so strict-JSON upstreams accept the request. Gate
// discipline (#3617): every guard row below is asserted in BOTH directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import { coreToOpenai, coreToResponses } from "acp-kernel/wire";
import { NON_JSON_TOOL_ARGS_PLACEHOLDER, hardenOpenaiToolCallArguments, hardenResponsesFunctionCallArguments } from "../src/util.js";

const logs: string[] = [];
const log = (level: string, msg: string) => { logs.push(`${level}: ${msg}`); };
const resetLogs = () => { logs.length = 0; };

const CHECKPOINT_PROSE = "This is an automatically generated checkpoint summarizing the conversation so far.";
const TAG_PREFIXED = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e stale clipped bytes";

test("chat guard: non-JSON arguments prose is replaced with the valid placeholder", () => {
    resetLogs();
    const input = [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: CHECKPOINT_PROSE } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const out = hardenOpenaiToolCallArguments(input, log, "sess-a");
    assert.notEqual(out, input, "touched array is replaced");
    const fn = out[1]!.tool_calls![0]!.function!;
    assert.equal(fn.arguments, NON_JSON_TOOL_ARGS_PLACEHOLDER);
    JSON.parse(fn.arguments);
    assert.equal(fn.name, "bash");
    assert.equal(out[1]!.tool_calls![0]!.id, "call_1");
    assert.equal(out[1]!.content, null, "content untouched");
    assert.deepEqual(out[0], input[0], "user message untouched");
    assert.ok(logs.some((l) => l.includes("[wire-guard]") && l.includes("sess-a") && l.includes("bash")), "warn logged with session + tool name");
});

test("chat guard: tag-prefixed (incident 2 signature) arguments are repaired", () => {
    resetLogs();
    const input = [
        { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: TAG_PREFIXED } }] },
    ];
    const out = hardenOpenaiToolCallArguments(input, log, "sess-b");
    assert.equal(out[0]!.tool_calls![0]!.function!.arguments, NON_JSON_TOOL_ARGS_PLACEHOLDER);
});

test("chat guard: mixed tool_calls — only the invalid payload is touched", () => {
    resetLogs();
    const input = [
        { role: "assistant", tool_calls: [
            { id: "call_a", type: "function", function: { name: "bash", arguments: CHECKPOINT_PROSE } },
            { id: "call_b", type: "function", function: { name: "read", arguments: "{\"path\":\"x\"}" } },
        ] },
    ];
    const out = hardenOpenaiToolCallArguments(input, log, "sess-c");
    assert.equal(out[0]!.tool_calls![0]!.function!.arguments, NON_JSON_TOOL_ARGS_PLACEHOLDER);
    assert.equal(out[0]!.tool_calls![1]!.function!.arguments, "{\"path\":\"x\"}", "valid sibling byte-exact");
});

test("chat guard negative rows: every valid shape passes byte-exact (same array returned)", () => {
    const rows: Array<{ label: string; args: unknown }> = [
        { label: "object", args: "{}" },
        { label: "nested", args: "{\"a\":[1,2,{\"b\":null}]}" },
        { label: "json null literal", args: "null" },
        { label: "json number", args: "42" },
        { label: "json string", args: "\"hello\"" },
        { label: "empty string", args: "" },
        { label: "undefined", args: undefined },
        { label: "object-typed", args: { already: "parsed" } },
    ];
    for (const r of rows) {
        const input = [{ role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: r.args } }] }];
        const out = hardenOpenaiToolCallArguments(input, log, "sess-neg");
        assert.equal(out, input, `${r.label}: untouched input returns the same array`);
    }
    // Non-assistant roles and missing tool_calls are never scanned.
    const misc = [
        { role: "user", content: CHECKPOINT_PROSE },
        { role: "tool", tool_call_id: "c", content: CHECKPOINT_PROSE },
        { role: "assistant", content: CHECKPOINT_PROSE },
        { role: "assistant", tool_calls: "not-an-array" },
    ];
    assert.equal(hardenOpenaiToolCallArguments(misc, log, "sess-neg2"), misc, "non-tool-call shapes untouched");
});

test("responses guard: dirty function_call.arguments is replaced; custom_tool_call.input stays free-form", () => {
    resetLogs();
    const input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "fc_1", name: "bash", arguments: CHECKPOINT_PROSE },
        { type: "custom_tool_call", call_id: "ct_1", name: "snippet", input: CHECKPOINT_PROSE },
        { type: "function_call", call_id: "fc_2", name: "read", arguments: "{\"path\":\"y\"}" },
    ];
    const out = hardenResponsesFunctionCallArguments(input, log, "sess-r");
    assert.notEqual(out, input);
    assert.equal((out[1] as { arguments?: string }).arguments, NON_JSON_TOOL_ARGS_PLACEHOLDER);
    JSON.parse((out[1] as { arguments?: string }).arguments!);
    assert.equal((out[1] as { name: string }).name, "bash", "name preserved");
    assert.equal((out[2] as { input?: string }).input, CHECKPOINT_PROSE, "custom_tool_call.input free-form — untouched");
    assert.equal((out[3] as { arguments?: string }).arguments, "{\"path\":\"y\"}", "valid function_call byte-exact");
    assert.deepEqual(out[0], input[0], "message item untouched");
    assert.ok(logs.some((l) => l.includes("[wire-guard]") && l.includes("sess-r")), "warn logged");
});

test("responses guard negative rows: valid/empty payloads and other item types pass untouched", () => {
    const input = [
        { type: "function_call", call_id: "f1", name: "t", arguments: "{}" },
        { type: "function_call", call_id: "f2", name: "t", arguments: "" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: CHECKPOINT_PROSE }] },
    ];
    assert.equal(hardenResponsesFunctionCallArguments(input, log, "sess-rneg"), input, "all-valid input returns the same array");
});

// --- mechanism reproduction (host-level, built kernel) -----------------------

const WINDOW = 100_000;
const BIG = "alpha-beta ".repeat(4000);
const filler = (t: string) => `filler ${t} ` + "x".repeat(800);
const tiny = (t: string): CoreMessage[] => [
    { id: `raw-${t}`, role: "user", contentType: "text", text: "hi " + t + " " + filler(t) },
    { id: `raw-${t}-a`, role: "assistant", contentType: "text", text: "ok " + t },
];
const hist = (): CoreMessage[] => [
    ...tiny("warm"),
    { id: "raw-big", role: "user", contentType: "text", text: BIG },
    ...tiny("tail1"),
    ...tiny("tail2"),
    ...tiny("tail3"),
    ...tiny("tail4"),
];
const TOOL_CALL_CORE: CoreMessage = {
    id: "raw-toolcall",
    role: "assistant",
    contentType: "tool-call",
    toolName: "bash",
    toolCallId: "call_poi",
    text: "{\"command\":\"ls\"}",
};

/** Turn 1 clips the oversized text and latches it; then simulate the
 *  cold-load ledger restamp: the clipped message leaves the view and a NEW
 *  assistant tool-call core is bound to the OLD latched ref — exactly what
 *  restampRefsToLedger produces when the latch survives hydration while the
 *  ref map is renumbered (src/persist.ts maybeRestampToLedger). */
function poisonedTurn() {
    const core = createCore();
    const t1 = core.processTurn({ messages: hist(), state: createInitialState(), config: defaultConfig(WINDOW), tokenCount: 96_000, renderTags: "none" });
    const clip = t1.messages.find((m) => m.id === "raw-big")!.text!;
    assert.ok(clip.includes("[truncated for context space]"), "turn 1 clips the oversized text");
    const entry = t1.state.emergencyTruncateLatch?.find((e) => e.text === clip);
    assert.ok(entry, "clip is latched");
    const st = structuredClone(t1.state);
    const oldRef = entry!.ref;
    delete st.messageRefs.byRaw["raw-big"];
    delete st.messageRefs.byRef[oldRef];
    st.messageRefs.byRaw["raw-toolcall"] = oldRef;
    st.messageRefs.byRef[oldRef] = "raw-toolcall";
    const t2 = core.processTurn({
        messages: [...hist().filter((m) => m.id !== "raw-big"), TOOL_CALL_CORE],
        state: st,
        config: defaultConfig(WINDOW),
        tokenCount: 60_000,
        renderTags: "none",
    });
    return { t2, clip };
}

test("repro #5534 (known kernel defect pin): latch replay lands clip text on the renumbered tool-call core", () => {
    const { t2, clip } = poisonedTurn();
    const tc = t2.messages.find((m) => m.id === "raw-toolcall");
    assert.ok(tc, "tool-call core survives the turn");
    assert.equal(tc!.text, clip, "stale latch entry overwrites the tool-call core's text (= arguments JSON)");

    const wire = coreToOpenai(t2.messages);
    const dirty = wire.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls : [])).find((tc2) => tc2.function?.arguments === clip);
    assert.ok(dirty, "coreToOpenai faithfully emits the poisoned text as function.arguments");
    assert.throws(() => JSON.parse(dirty!.function!.arguments), "payload is not JSON — strict-JSON upstreams 500 on this");
});

test("egress guard repairs the poisoned chat wire end-to-end (outbound arguments always valid JSON)", () => {
    const { t2 } = poisonedTurn();
    const wire = coreToOpenai(t2.messages);
    const out = hardenOpenaiToolCallArguments(wire, log, "sess-e2e");
    for (const m of out) {
        for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
            const args = tc.function?.arguments;
            if (typeof args === "string" && args.length > 0) JSON.parse(args);
        }
    }
    const fixed = out.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls : [])).find((tc) => tc.function?.arguments === NON_JSON_TOOL_ARGS_PLACEHOLDER);
    assert.ok(fixed, "placeholder present where the poison was");
});

test("egress guard repairs the poisoned responses wire end-to-end", () => {
    const { t2, clip } = poisonedTurn();
    const items = coreToResponses(t2.messages);
    const dirty = items.find((it) => it.type === "function_call" && it.arguments === clip);
    assert.ok(dirty, "coreToResponses carries the poisoned text into function_call.arguments");
    const out = hardenResponsesFunctionCallArguments(items, log, "sess-e2e-r");
    for (const it of out) {
        if (it.type !== "function_call") continue;
        const args = it.arguments;
        if (typeof args === "string" && args.length > 0) JSON.parse(args);
    }
    assert.ok(out.some((it) => it.type === "function_call" && it.arguments === NON_JSON_TOOL_ARGS_PLACEHOLDER));
});
