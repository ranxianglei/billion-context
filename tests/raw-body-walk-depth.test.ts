import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";
import { measuredBreakdownClause } from "../src/server.ts";

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
    assert.equal(bd.total, bd.messages + bd.system + bd.tools + bd.input + bd.other);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("non-object top-level bodies land whole in the other bucket", () => {
    const bd = estimateRawBodyBreakdown("plain string body");
    assert.deepEqual(bd, { total: t("plain string body"), messages: 0, tools: 0, system: 0, input: 0, other: t("plain string body"), encryptedContent: 0 });
    assert.equal(estimateRawBodyTokens("plain string body"), t("plain string body"));
});

// #6876: the Responses lane carries the conversation in a top-level `input`
// field (not `messages`) and replays `encrypted_content` reasoning/compaction
// state blobs inside it. The measured-body fuse previously bucketed all of it
// into the opaque `other`, so a refused 1.07M-token Responses body read
// "other ~1,045,895" with no way to see the conversation vs. the encrypted
// reasoning mass. `input` is now a named bucket and `encryptedContent` reports
// the `encrypted_content` leaves inside it (a subset of `input`).
test("raw-body breakdown names the Responses input bucket and its encrypted_content sub-mass (#6876)", () => {
    const enc = "enc-reasoning-blob-".repeat(2_000); // ~2,000 chars of encrypted reasoning state
    const body = {
        model: "gpt-6.1-sol",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
            { type: "reasoning", summary: [], encrypted_content: enc },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
            { type: "compaction", encrypted_content: "compaction-blob-".repeat(500) },
        ],
        tools: [{ type: "function", name: "search", description: "find things" }],
    };
    const bd = estimateRawBodyBreakdown(body);
    // `input` is a named bucket: the conversation + reasoning + compaction mass.
    assert.ok(bd.input > 0, "Responses conversation lands in the input bucket");
    assert.equal(bd.messages, 0, "no messages[] field on the Responses wire");
    // `encryptedContent` is a subset of `input` (both reasoning + compaction blobs).
    const expectedEnc = t(enc) + t("compaction-blob-".repeat(500));
    assert.equal(bd.encryptedContent, expectedEnc, "encrypted_content leaves inside input are reported");
    assert.ok(bd.encryptedContent <= bd.input, "encryptedContent is a subset of input");
    // the total invariant holds with the new fifth bucket.
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.input + bd.other);
    assert.equal(bd.total, estimateRawBodyTokens(body), "total equals the plain meter exactly");
    // the structural leaves (type/role/content markers) ride input too.
    assert.ok(bd.input > bd.encryptedContent, "input includes non-encrypted structural leaves");
});

test("raw-body breakdown: encrypted_content outside input is NOT counted as encryptedContent (#6876)", () => {
    // `encrypted_content` is a Responses `input`-item field; a stray occurrence
    // under another top-level field must not inflate the input sub-mass.
    const body = {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        metadata: { encrypted_content: "stray-blob-".repeat(100) },
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.encryptedContent, 0, "encrypted_content outside input is not the input sub-mass");
    assert.ok(bd.other > 0, "the stray blob still counts toward other (total invariant)");
    assert.equal(bd.total, estimateRawBodyTokens(body), "total invariant holds");
});

test("measuredBreakdownClause names input (enc ~E) for Responses and stays four-bucket for Chat (#6876)", () => {
    const responses = { total: 1_068_060, messages: 0, tools: 22_165, system: 0, input: 1_045_895, other: 0, encryptedContent: 600_000 };
    const chat = { total: 500, messages: 400, tools: 50, system: 30, input: 0, other: 20, encryptedContent: 0 };
    assert.equal(
        measuredBreakdownClause(responses),
        "messages ~0 · tools[] ~22,165 · system ~0 · input ~1,045,895 (enc ~600,000) · other ~0",
    );
    assert.equal(
        measuredBreakdownClause(chat),
        "messages ~400 · tools[] ~50 · system ~30 · other ~20",
    );
});
