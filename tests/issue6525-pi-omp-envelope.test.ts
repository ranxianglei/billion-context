/** #6525 (发): pi/omp full-resend msgid envelope — the LANE-INDEPENDENT send
 *  path. The incremental lane already stamps `msgIds` on the deltas it diverts
 *  (anthropic wire only); this is the envelope (`biliMsgIds`) on EVERY
 *  full-resend body — core-aligned via the kernel wireIndex proof, any
 *  mismatch bails to no field (byte-identical to today). Tests:
 *    A. coreAlignEnvelopeIds — the core-alignment proof itself
 *    B. _bodyProxyVisibleForTest — the #1403 gate (blind tunnel: never stamp)
 *    C. _resolveEnvelopeIdsForFullResendForTest — resolver (walker + proof)
 *    D. _stampMsgIdEnvelopeForTest — the stamp (base + biliMsgIds, guards)
 *  No new msgid VALIDATOR is introduced here (the parity-matrix discipline):
 *  pairing reuses the lane walkers; the server re-validates at pin time. */
import assert from "node:assert/strict";
import test from "node:test";
import { coreAlignEnvelopeIds } from "../src/agent/pi-msgids.ts";
import {
    _bodyProxyVisibleForTest,
    _resolveEnvelopeIdsForFullResendForTest,
    _stampMsgIdEnvelopeForTest,
} from "../src/agent/pi.ts";

// ---------------------------------------------------------------------------
// A. coreAlignEnvelopeIds
// ---------------------------------------------------------------------------

/** The 1:1 openai conversation: lead system hoist + a plain tool round.
 *  Kernel projection (verified against acp-kernel/wire): user→1 core,
 *  assistant(content null, one tool_call)→1 core, tool→1 core,
 *  assistant text→1 core. Every element lands on exactly one core. */
const OAI_WIRE_1TO1 = [
    { role: "system", content: "you are a test" },
    { role: "user", content: "q" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "assistant", content: "done" },
];
const OAI_ALIGNED_1TO1 = ["bili-ps-0", "u1", "a2", "t3", "a4"];

test("coreAlignEnvelopeIds: openai 1:1 with lead system → core ids (lead dropped)", () => {
    const parsed = { messages: OAI_WIRE_1TO1, model: "m" };
    assert.deepEqual(
        coreAlignEnvelopeIds("openai", OAI_ALIGNED_1TO1, OAI_WIRE_1TO1, parsed),
        ["u1", "a2", "t3", "a4"],
    );
});

test("coreAlignEnvelopeIds: openai assistant text+tool_call splits one element into two cores → bail", () => {
    const wire = [
        { role: "user", content: "q" },
        { role: "assistant", content: "talking", tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }] },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["u0", "a1"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: openai user [text, image] splits into two cores → bail", () => {
    const wire = [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "http://x/i.png" } }] },
        { role: "user", content: "b" },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["u0", "u1"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: openai two tool_calls on one assistant → bail", () => {
    const wire = [
        { role: "user", content: "q" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } },
                { id: "call_2", type: "function", function: { name: "t", arguments: "{}" } },
            ],
        },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["u0", "a1"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: a bili-ps- slot past the lead run (mid-body system) → bail", () => {
    const wire = [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "system", content: "mid" },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["bili-ps-0", "u1", "bili-ps-2"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: lead-only (everything hoisted) → nothing to align → bail", () => {
    assert.equal(coreAlignEnvelopeIds("openai", ["bili-ps-0"], [{ role: "system", content: "s" }], { messages: [{ role: "system", content: "s" }], model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: duplicate id in the aligned tail → bail (no mis-pin)", () => {
    const wire = [
        { role: "user", content: "q" },
        { role: "user", content: "r" },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["u1", "u1"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: aligned array not 1:1 with the wire element count → bail", () => {
    const wire = [
        { role: "user", content: "q" },
        { role: "user", content: "r" },
    ];
    assert.equal(coreAlignEnvelopeIds("openai", ["u1"], wire, { messages: wire, model: "m" }), undefined);
});

test("coreAlignEnvelopeIds: anthropic 1:1 (system is a separate field — no lead drop)", () => {
    const wire = [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "r" }] },
    ];
    const parsed = { system: "sys", messages: wire, model: "claude" };
    assert.deepEqual(
        coreAlignEnvelopeIds("anthropic", ["u0", "a1", "t2"], wire, parsed),
        ["u0", "a1", "t2"],
    );
});

test("coreAlignEnvelopeIds: non-array wire → bail without throwing", () => {
    assert.equal(coreAlignEnvelopeIds("openai", ["u0"], "garbage", { messages: "garbage", model: "m" }), undefined);
});

// ---------------------------------------------------------------------------
// B. bodyProxyVisible — the #1403 gate
// ---------------------------------------------------------------------------

test("bodyProxyVisible: a /bili/-wrapped baseUrl is proxy-visible", () => {
    const visible = _bodyProxyVisibleForTest({ model: { baseUrl: "http://127.0.0.1:9999/bili/https://upstream.example.com/v1" } }, "pi");
    assert.equal(visible, true);
});

test("bodyProxyVisible: a plain upstream baseUrl (blind tunnel) is NOT proxy-visible", () => {
    const saved = { proxy: process.env.BILLION_CONTEXT_PROXY, mitm: process.env.BILI_MITM_HOSTS };
    delete process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILI_MITM_HOSTS;
    try {
        const visible = _bodyProxyVisibleForTest({ model: { baseUrl: "https://api.upstream.example.com/v1" } }, "pi");
        assert.equal(visible, false);
    } finally {
        if (saved.proxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = saved.proxy;
        if (saved.mitm === undefined) delete process.env.BILI_MITM_HOSTS;
        else process.env.BILI_MITM_HOSTS = saved.mitm;
    }
});

// ---------------------------------------------------------------------------
// C. resolveEnvelopeIdsForFullResend
// ---------------------------------------------------------------------------

/** A pi branch that pairs 1:1 onto OAI_WIRE_1TO1 (the walker's lockstep
 *  contract): entry id is the host msgid the envelope must carry. */
function pairBranch() {
    return [
        { type: "message", id: "u1", message: { role: "user", content: "q" } },
        { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "t", arguments: {} }] } },
        { type: "message", id: "t3", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "result" }] } },
        { type: "message", id: "a4", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
}

const ctxWithBranch = (branch: unknown) => ({
    model: { baseUrl: "http://127.0.0.1:9999/bili/https://upstream.example.com/v1" },
    sessionManager: { getBranch: () => branch },
});

test("resolveEnvelopeIds: openai full-resend pairs the branch → core-aligned host ids", () => {
    const parsed = { messages: OAI_WIRE_1TO1, model: "m" };
    assert.deepEqual(_resolveEnvelopeIdsForFullResendForTest(parsed, ctxWithBranch(pairBranch())), ["u1", "a2", "t3", "a4"]);
});

test("resolveEnvelopeIds: a google wire (contents array) is out of scope → undefined", () => {
    const parsed = { contents: [{ role: "user", parts: [{ text: "hi" }] }], model: "gemini" };
    assert.equal(_resolveEnvelopeIdsForFullResendForTest(parsed, ctxWithBranch(pairBranch())), undefined);
});

test("resolveEnvelopeIds: no branch available → undefined (never guess)", () => {
    const parsed = { messages: OAI_WIRE_1TO1, model: "m" };
    assert.equal(_resolveEnvelopeIdsForFullResendForTest(parsed, { model: { baseUrl: "http://127.0.0.1:9999/bili/x" } }), undefined);
});

test("resolveEnvelopeIds: branch shorter than the wire (dropped message) → undefined", () => {
    const parsed = { messages: OAI_WIRE_1TO1, model: "m" };
    const short = pairBranch().slice(0, 3);
    assert.equal(_resolveEnvelopeIdsForFullResendForTest(parsed, ctxWithBranch(short)), undefined);
});

test("resolveEnvelopeIds: getBranch throwing is a bail, not a throw", () => {
    const parsed = { messages: OAI_WIRE_1TO1, model: "m" };
    const ctx = {
        model: { baseUrl: "http://127.0.0.1:9999/bili/x" },
        sessionManager: { getBranch: () => { throw new Error("manager gone"); } },
    };
    assert.equal(_resolveEnvelopeIdsForFullResendForTest(parsed, ctx), undefined);
});

// ---------------------------------------------------------------------------
// D. stampMsgIdEnvelope
// ---------------------------------------------------------------------------

test("stamp: pi visible + pairable → payload gets biliMsgIds, everything else intact", () => {
    const payload: Record<string, unknown> = { messages: OAI_WIRE_1TO1, model: "m", stream: true };
    const out = _stampMsgIdEnvelopeForTest({ payload }, ctxWithBranch(pairBranch()), "pi", undefined);
    assert.deepEqual(out, { messages: OAI_WIRE_1TO1, model: "m", stream: true, biliMsgIds: ["u1", "a2", "t3", "a4"] });
    assert.notEqual(out, payload); // spread copy — the original payload is not mutated
    assert.equal(payload.biliMsgIds, undefined);
});

test("stamp: blind tunnel (not proxy-visible) → undefined → byte-identical request", () => {
    const saved = { proxy: process.env.BILLION_CONTEXT_PROXY, mitm: process.env.BILI_MITM_HOSTS };
    delete process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILI_MITM_HOSTS;
    try {
        const payload = { messages: OAI_WIRE_1TO1, model: "m" };
        const ctx = { model: { baseUrl: "https://api.upstream.example.com/v1" }, sessionManager: { getBranch: () => pairBranch() } };
        assert.equal(_stampMsgIdEnvelopeForTest({ payload }, ctx, "pi", undefined), undefined);
    } finally {
        if (saved.proxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = saved.proxy;
        if (saved.mitm === undefined) delete process.env.BILI_MITM_HOSTS;
        else process.env.BILI_MITM_HOSTS = saved.mitm;
    }
});

test("stamp: omp pck object is the base — the envelope rides beside prompt_cache_key", () => {
    const pck = { messages: OAI_WIRE_1TO1, model: "m", prompt_cache_key: "session-x" };
    const out = _stampMsgIdEnvelopeForTest({ payload: { messages: OAI_WIRE_1TO1, model: "m" } }, ctxWithBranch(pairBranch()), "omp", pck);
    assert.deepEqual(out, { messages: OAI_WIRE_1TO1, model: "m", prompt_cache_key: "session-x", biliMsgIds: ["u1", "a2", "t3", "a4"] });
});

test("stamp: already-stamped payload is never re-stamped", () => {
    const payload = { messages: OAI_WIRE_1TO1, model: "m", biliMsgIds: ["existing"] };
    assert.equal(_stampMsgIdEnvelopeForTest({ payload }, ctxWithBranch(pairBranch()), "pi", undefined), undefined);
});

test("stamp: unpairable resolver result → undefined (the request ships as-is)", () => {
    const payload = { messages: OAI_WIRE_1TO1, model: "m" };
    assert.equal(_stampMsgIdEnvelopeForTest({ payload }, ctxWithBranch(pairBranch().slice(0, 2)), "pi", undefined), undefined);
});

test("stamp: non-object payload → undefined without throwing", () => {
    assert.equal(_stampMsgIdEnvelopeForTest({ payload: "garbage" }, ctxWithBranch(pairBranch()), "pi", undefined), undefined);
    assert.equal(_stampMsgIdEnvelopeForTest({}, ctxWithBranch(pairBranch()), "pi", undefined), undefined);
});
