import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens, PROMPT_BODY_KEYS } from "../src/preflight.ts";
import { measuredBreakdownClause } from "../src/server.ts";
import type { WireProtocol } from "../src/util.ts";

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
    assert.deepEqual(bd, { total: t("plain string body"), messages: 0, tools: 0, system: 0, other: t("plain string body"), prompt: 0, otherTop: [] });
    assert.equal(estimateRawBodyTokens("plain string body"), t("plain string body"));
});

// #6844: the `other` bucket is a catch-all — the 413 breakdown must attribute
// it to the TOP-LEVEL field carrying the mass, so the operator sees which
// host-attached field is metered without manual arithmetic.

test("#6844: otherTop attributes the other bucket to its top-level fields, descending", () => {
    const extra = "E".repeat(50_000);
    const body = {
        messages: [{ role: "user", content: "hello message" }],
        model: "deepseek-flash",
        custom_extension: extra,
        metadata: { note: "note x" },
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.deepEqual(bd.otherTop, [
        { field: "custom_extension", tokens: t(extra), bytes: Buffer.byteLength(extra, "utf8") },
        { field: "model", tokens: t("deepseek-flash"), bytes: Buffer.byteLength("deepseek-flash", "utf8") },
        { field: "metadata", tokens: t("note x"), bytes: Buffer.byteLength("note x", "utf8") },
    ], "per-field attribution, largest first");
    assert.equal(bd.otherTop.reduce((sum, e) => sum + e.tokens, 0), bd.other, "otherTop sums to the other bucket");
});

test("#6844: otherTop inherits the top-level field through nesting", () => {
    const nested = "N".repeat(1000);
    const body = {
        messages: [{ role: "user", content: "hi" }],
        custom_extension: { entries: [{ seq: 1, text: nested }] },
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.anthropic);
    assert.deepEqual(bd.otherTop, [{ field: "custom_extension", tokens: t(nested), bytes: Buffer.byteLength(nested, "utf8") }], "only the string leaf counts, attributed to the top-level field");
    assert.equal(bd.other, bd.otherTop[0]!.tokens);
});

test("#7090: otherTop bytes are UTF-8 byte length (multi-byte aware), not code-unit count", () => {
    // "会话日志" is 4 CJK chars = 12 UTF-8 bytes; value.length would say 4.
    const cjk = "会话日志";
    const bd = estimateRawBodyBreakdown({ messages: [{ role: "user", content: "hi" }], custom_extension: cjk });
    assert.deepEqual(bd.otherTop, [{ field: "custom_extension", tokens: t(cjk), bytes: 12 }], "bytes must count UTF-8 bytes, not JS code units");
    assert.equal(bd.otherTop[0]!.bytes, Buffer.byteLength(cjk, "utf8"));
});

test("#6844: empty other stays empty; messages/tools/system fields never appear in otherTop", () => {
    assert.deepEqual(estimateRawBodyBreakdown({ messages: [{ role: "user", content: "hi" }] }).otherTop, []);
    const bd = estimateRawBodyBreakdown({
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "n", description: "d" }],
        system: "s",
        model: "m",
    });
    assert.deepEqual(bd.otherTop, [{ field: "model", tokens: t("m"), bytes: Buffer.byteLength("m", "utf8") }], "only the other-bucket field is attributed");
});

test("#6844: measuredBreakdownClause names the field dominating other", () => {
    const extra = "E".repeat(50_000);
    const bd = estimateRawBodyBreakdown({
        messages: [{ role: "user", content: "hello" }],
        custom_extension: extra,
    });
    const clause = measuredBreakdownClause(bd);
    assert.match(clause, /other ~[\d,]+ \(non-prompt, excluded from the window budget; top field: custom_extension ~[\d,]+ tokens ≈[\d,]+ B\)/, `the clause must name the dominating field with its byte size, got: ${clause}`);
    assert.match(clause, /^messages ~[\d,]+ · tools\[\] ~[\d,]+ · system ~[\d,]+ · other /, "the four-bucket shape is unchanged");
});

test("#6844: measuredBreakdownClause stays bare when other is empty", () => {
    const bd = estimateRawBodyBreakdown({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(
        measuredBreakdownClause(bd),
        `messages ~${bd.messages.toLocaleString("en-US")} · tools[] ~0 · system ~0 · other ~0 (non-prompt, excluded from the window budget)`,
        "no top-field suffix when other has nothing to attribute",
    );
});

// #7013: the wire-format's PROMPT mass is what a window-fit gate prices.
// Non-prompt fields (telemetry uploads like DSH's dsh_session_log, config
// scalars) ride the wire but consume NO window — they must sit in `other`
// (and `total`) but NOT in `prompt`. The fix keys off PROMPT_BODY_KEYS per
// wire format, never a hardcoded exclusion of one plugin's field.

test("#7013: openai prompt mass = messages + tools + top-level system (aligned with estimateWireOverhead)", () => {
    const body = {
        system: "top-level system field on the openai wire",
        messages: [{ role: "user", content: "hello message" }],
        tools: [{ name: "search", description: "find things fast" }],
        dsh_session_log: { entries: ["telemetry one", "telemetry two"] },
        metadata: { note: "structural note" },
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    // messages bucket: "user" + "hello message"; tools bucket: "search" + "find things fast"; system bucket: "top-level system field on the openai wire".
    const expectedPrompt = t("user") + t("hello message") + t("search") + t("find things fast") + t("top-level system field on the openai wire");
    assert.equal(bd.prompt, expectedPrompt);
    // The non-prompt dsh_session_log + metadata land in other/total but NOT prompt.
    assert.equal(bd.prompt, bd.messages + bd.tools + bd.system);
    assert.ok(bd.other > 0, "dsh_session_log + metadata are non-prompt mass");
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.other);
    assert.ok(bd.total > bd.prompt, "total includes non-prompt mass the prompt mass excludes");
    assert.equal(bd.total, estimateRawBodyTokens(body), "total invariant holds with promptKeys");
});

test("#7013: anthropic prompt mass includes top-level system", () => {
    const body = {
        system: "top-level anthropic system",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "n", description: "d" }],
        custom_extension: "big telemetry blob",
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
        custom_extension: "big telemetry blob",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.google);
    // #7090: google's prompt keys land in their named buckets (contents→messages,
    // systemInstruction→system), so the prompt mass equals the named-bucket sum.
    const expectedPrompt = t("user") + t("hello") + t("google system") + t("n") + t("d");
    assert.equal(bd.prompt, expectedPrompt);
    assert.equal(bd.prompt, bd.messages + bd.tools + bd.system, "prompt mass = named buckets on the google lane");
    assert.ok(bd.other > 0 && bd.total > bd.prompt, "custom_extension is non-prompt mass");
});

test("#7013: responses prompt mass = input + instructions + tools", () => {
    const body = {
        input: [{ role: "user", content: "hello" }],
        instructions: "responses instructions",
        tools: [{ name: "n", description: "d" }],
        custom_extension: "big telemetry blob",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.responses);
    const expectedPrompt = t("user") + t("hello") + t("responses instructions") + t("n") + t("d");
    assert.equal(bd.prompt, expectedPrompt);
    assert.equal(bd.prompt, bd.messages + bd.tools + bd.system, "prompt mass = named buckets on the responses lane");
    assert.ok(bd.other > 0 && bd.total > bd.prompt, "custom_extension is non-prompt mass");
});

// #7090: the responses lane's `input` (the main prompt content) must land in a
// NAMED bucket, not the `other` catch-all — otherwise the 413 clause's
// "non-prompt, excluded" note mislabels prompt mass as non-prompt. Same for
// google's `contents` / `systemInstruction`. This is the display-side half of
// the #7013 fix: the gate already prices `prompt` correctly; this keeps the
// diagnostic split honest on every lane.

test("#7090: responses `input` lands in the messages bucket, not other", () => {
    const input = "I".repeat(100_000);
    const body = {
        model: "gpt",
        input: [{ role: "user", content: input }],
        tools: [{ name: "n", description: "d" }],
        stream: true,
        prompt_cache_key: "k",
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.responses);
    assert.equal(bd.messages, t("user") + t(input), "input mass is in the messages bucket");
    assert.equal(bd.tools, t("n") + t("d"));
    assert.equal(bd.system, 0);
    // Non-prompt keys (model/stream/prompt_cache_key) are the only `other` mass.
    assert.equal(bd.other, t("gpt") + t("k"));
    assert.equal(bd.prompt, bd.messages + bd.tools + bd.system, "prompt = named buckets");
    assert.equal(bd.prompt + bd.other, bd.total, "prompt + other = total");
    assert.ok(!bd.otherTop.some((e) => e.field === "input"), "input must NOT appear in the other-field attribution");
});

test("#7090: the prompt/named-bucket invariant holds on every lane", () => {
    const lanes: Array<[string, Record<string, unknown>, ReadonlySet<string>]> = [
        ["openai", { messages: [{ role: "user", content: "m" }], tools: [{ name: "n" }], model: "x" }, PROMPT_BODY_KEYS.openai],
        ["anthropic", { messages: [{ role: "user", content: "m" }], tools: [{ name: "n" }], system: "s", dsh_session_log: "t" }, PROMPT_BODY_KEYS.anthropic],
        ["google", { contents: [{ role: "user", parts: [{ text: "m" }] }], systemInstruction: "s", tools: [{ name: "n" }], dsh_session_log: "t" }, PROMPT_BODY_KEYS.google],
        ["responses", { input: [{ role: "user", content: "m" }], instructions: "s", tools: [{ name: "n" }], dsh_session_log: "t" }, PROMPT_BODY_KEYS.responses],
    ];
    for (const [name, body, keys] of lanes) {
        const bd = estimateRawBodyBreakdown(body, keys);
        assert.equal(bd.prompt, bd.messages + bd.tools + bd.system, `${name}: prompt = named buckets`);
        assert.equal(bd.prompt + bd.other, bd.total, `${name}: prompt + other = total`);
        assert.equal(bd.total, estimateRawBodyTokens(body), `${name}: total invariant holds`);
    }
});

test("#7013: a giant non-prompt upload does not inflate the prompt mass", () => {
    // The issue's repro: ~100K-token prompt + an 8 MiB non-prompt upload.
    // The prompt mass must stay at the prompt's size; only total grows.
    const promptText = "x".repeat(400_000); // ~100K tokens
    const telemetry = "t".repeat(8_000_000); // ~2M tokens of non-prompt upload
    const body = {
        messages: [{ role: "user", content: promptText }],
        custom_extension: telemetry,
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    assert.equal(bd.prompt, t("user") + t(promptText));
    assert.equal(bd.other, t(telemetry));
    assert.ok(bd.total > 2 * bd.prompt, "total dwarfs the prompt mass by the upload");
    // The window-fit gate compares bd.prompt (not bd.total) against the window,
    // so a fitting prompt no longer 413s on the upload.
    assert.ok(bd.prompt < 200_000, "prompt mass stays within a realistic window");
});

test("#7013: PROMPT_BODY_KEYS has a non-empty entry for every WireProtocol member", () => {
    // The Record<WireProtocol, …> type enforces existence at compile time; this
    // adds the runtime non-empty guard so a future protocol added with an empty
    // keys table (which would silently price 0 and OPEN the gate) fails here.
    const protocols: WireProtocol[] = ["anthropic", "openai", "responses", "google"];
    for (const p of protocols) {
        const keys = PROMPT_BODY_KEYS[p];
        assert.ok(keys, `PROMPT_BODY_KEYS must have an entry for ${p}`);
        assert.ok(keys.size > 0, `PROMPT_BODY_KEYS[${p}] must be non-empty`);
    }
});
