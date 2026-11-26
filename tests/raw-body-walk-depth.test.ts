import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens, PROMPT_BODY_KEYS } from "../src/preflight.ts";

// #6038: client-controlled request bodies may nest far beyond safe recursion
// depth; the raw-body token walks must survive them without changing any
// accounting (key inheritance, NON_TEXT_BODY_KEYS exclusion, top-level
// bucketing, total invariant).
const DEPTH = 20_000;
const t = (s: string): number => defaultCountTokens(s);

function deepObjectBody(): { body: Record<string, unknown>; counted: number } {
    const leaves: string[] = [];
    let node: Record<string, unknown> = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) },
        caption: "deep payload",
    };
    leaves.push("image", "base64", "image/png", "deep payload");
    for (let i = 0; i < DEPTH; i++) {
        leaves.push("wrapper");
        node = { kind: "wrapper", index: i, child: node };
    }
    leaves.push("user", "block");
    const body = { messages: [{ role: "user", content: [{ kind: "block", payload: node }] }] };
    return { body, counted: leaves.reduce((sum, s) => sum + t(s), 0) };
}

test("raw-body token estimate survives deeply nested object chains", () => {
    const { body, counted } = deepObjectBody();
    assert.equal(estimateRawBodyTokens(body), counted);
});

test("raw-body breakdown survives deep nesting and keeps the total invariant", () => {
    const { body, counted } = deepObjectBody();
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, counted);
    assert.equal(bd.tools, 0);
    assert.equal(bd.system, 0);
    assert.equal(bd.other, 0);
    assert.equal(bd.total, counted);
    assert.equal(bd.total, estimateRawBodyTokens(body));
});

test("raw-body walks keep key inheritance through deep array chains", () => {
    let inner: unknown = { url: "data:text/plain;base64,QUJD", text: "tail leaf" };
    for (let i = 0; i < DEPTH; i++) inner = [inner];
    const body = { messages: [inner] };
    assert.equal(estimateRawBodyTokens(body), t("tail leaf"));
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("tail leaf"));
    assert.equal(bd.total, t("tail leaf"));
});

test("shallow plumbing: exclusion set, key inheritance and bucket split stay intact", () => {
    const media = "QUJDREVGRw==";
    const body = {
        system: "system prompt text",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "hello message" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: media } },
                ],
            },
        ],
        tools: [{ name: "search", description: "find things fast" }],
        image_url: "data:image/png;base64," + media,
        metadata: { note: "structural note" },
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("text") + t("hello message") + t("image") + t("base64") + t("image/png"));
    assert.equal(bd.system, t("system prompt text"));
    assert.equal(bd.tools, t("search") + t("find things fast"));
    assert.equal(bd.other, t("structural note"));
    assert.equal(bd.total, bd.messages + bd.system + bd.tools + bd.other);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("non-object top-level bodies land whole in the other bucket", () => {
    const bd = estimateRawBodyBreakdown("plain string body");
    assert.deepEqual(bd, { total: t("plain string body"), messages: 0, tools: 0, system: 0, other: t("plain string body"), prompt: 0 });
    assert.equal(estimateRawBodyTokens("plain string body"), t("plain string body"));
});

// #7013: the wire-format's PROMPT mass is what a window-fit gate prices.
// Non-prompt fields (telemetry uploads, config scalars) ride the wire but
// consume NO window — they must sit in `other` (and `total`) but NOT in
// `prompt`. The fix keys off PROMPT_BODY_KEYS per wire format, never a
// hardcoded exclusion of one plugin's field in the window-fit pricing.
// (Top-level DSH transport fields `dsh_*` go further: excluded from `total`
// entirely by the NON_MODEL_TOP_LEVEL_KEYS rule — see
// raw-body-dsh-extensions.test.ts — so they never reach `other` either.)

test("#7013: openai prompt mass = messages + tools (system rides inside messages)", () => {
    const body = {
        system: "in-body system rides inside messages for openai",
        messages: [{ role: "user", content: "hello message" }],
        tools: [{ name: "search", description: "find things fast" }],
        dsh_session_log: { entries: ["telemetry one", "telemetry two"] },
        metadata: { note: "structural note" },
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    // messages bucket: "user" + "hello message"; tools bucket: "search" + "find things fast".
    const expectedPrompt = t("user") + t("hello message") + t("search") + t("find things fast");
    assert.equal(bd.prompt, expectedPrompt);
    // The non-prompt top-level system + metadata land in other/total but NOT prompt
    // (dsh_session_log is excluded from total by the dsh_* rule — see the block note).
    assert.equal(bd.prompt, bd.messages + bd.tools);
    assert.ok(bd.other > 0, "metadata is non-prompt mass (system lands in the system bucket)");
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.other);
    assert.ok(bd.total > bd.prompt, "total includes non-prompt mass the prompt mass excludes");
    assert.equal(bd.total, estimateRawBodyTokens(body), "total invariant holds with promptKeys");
});

test("#7013: anthropic prompt mass includes top-level system", () => {
    const body = {
        system: "top-level anthropic system",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "n", description: "d" }],
        metadata: "big telemetry blob",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.anthropic);
    assert.equal(bd.prompt, bd.messages + bd.tools + bd.system);
    assert.ok(bd.other > 0 && bd.total > bd.prompt);
});

test("#7013: google prompt mass = contents + systemInstruction + tools", () => {
    const body = {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        systemInstruction: "google system",
        tools: [{ name: "n", description: "d" }],
        metadata: "big telemetry blob",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.google);
    // google's prompt keys (contents/systemInstruction) land in the `other`
    // bucket (the split is on the openai/anthropic key names), so assert the
    // prompt mass against the direct leaf count, not the bucket sum.
    const expectedPrompt = t("user") + t("hello") + t("google system") + t("n") + t("d");
    assert.equal(bd.prompt, expectedPrompt);
    assert.ok(bd.other > 0 && bd.total > bd.prompt, "metadata is non-prompt mass");
});

test("#7013: responses prompt mass = input + instructions + tools", () => {
    const body = {
        input: [{ role: "user", content: "hello" }],
        instructions: "responses instructions",
        tools: [{ name: "n", description: "d" }],
        metadata: "big telemetry blob",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.responses);
    const expectedPrompt = t("user") + t("hello") + t("responses instructions") + t("n") + t("d");
    assert.equal(bd.prompt, expectedPrompt);
    assert.ok(bd.other > 0 && bd.total > bd.prompt, "metadata is non-prompt mass");
});

test("#7013: a giant dsh_session_log upload does not doom a fitting prompt", () => {
    // The issue's repro: ~100K-token prompt + an 8 MiB dsh_session_log upload.
    // Top-level dsh_* fields are excluded from `total` by the NON_MODEL_TOP_LEVEL_KEYS
    // rule (see raw-body-dsh-extensions.test.ts) and are never in the prompt mass, so
    // the window-fit gate (which prices prompt) sees only the fitting prompt.
    const promptText = "x".repeat(400_000); // ~100K tokens
    const telemetry = "t".repeat(8_000_000); // ~2M tokens of dsh_session_log upload
    const body = {
        messages: [{ role: "user", content: promptText }],
        dsh_session_log: telemetry,
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    assert.equal(bd.prompt, t("user") + t(promptText));
    assert.equal(bd.total, bd.prompt, "dsh_session_log contributes zero to total");
    assert.ok(bd.prompt < 200_000, "prompt mass stays within a realistic window");
});

test("#7013: a giant non-prompt telemetry upload does not inflate the prompt mass", () => {
    // The general mechanism (non-DSH non-prompt fields): the upload lands in
    // other/total but NOT in prompt, so the window-fit gate (which prices prompt)
    // does not 413 a fitting prompt on a large non-prompt upload.
    const promptText = "x".repeat(400_000); // ~100K tokens
    const telemetry = "t".repeat(8_000_000); // ~2M tokens of non-prompt upload
    const body = {
        messages: [{ role: "user", content: promptText }],
        telemetry_upload: telemetry,
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    assert.equal(bd.prompt, t("user") + t(promptText));
    assert.equal(bd.other, t(telemetry));
    assert.ok(bd.total > 2 * bd.prompt, "total dwarfs the prompt mass by the upload");
    // The window-fit gate compares bd.prompt (not bd.total) against the window,
    // so a fitting prompt no longer 413s on the upload.
    assert.ok(bd.prompt < 200_000, "prompt mass stays within a realistic window");
});
