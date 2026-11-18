import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

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
    assert.deepEqual(bd, { total: t("plain string body"), messages: 0, tools: 0, system: 0, other: t("plain string body") });
    assert.equal(estimateRawBodyTokens("plain string body"), t("plain string body"));
});

// #7167: the foldable message channel is bucketed as `messages` for EVERY wire
// shape — chat `messages[]`, Responses `input`, Google `contents` — so the
// irreducible-dimension gate (which prices `total − messages`) cannot doom an
// over-window Responses/Google body before a fold could run. Regression for
// the CI break where `input`/`contents` mass landed in `other` and the gate
// 413'd bodies that were perfectly foldable.
test("foldable channel is the messages bucket on every wire shape (#7167)", () => {
    const filler = "m".repeat(1_000);
    // Responses API: the conversation rides `input`, not `messages`.
    const responses = { model: "gpt", stream: true, instructions: "sys", input: [{ role: "user", content: filler }] };
    const br = estimateRawBodyBreakdown(responses);
    assert.ok(br.messages >= t(filler), "Responses `input` mass lands in the messages bucket");
    assert.equal(br.messages + br.tools + br.system + br.other, br.total, "buckets stay exhaustive");
    assert.equal(br.total, estimateRawBodyTokens(responses), "total invariant holds for Responses");
    // Google wire: the conversation rides `contents`, not `messages`.
    const google = { model: "gemini", contents: [{ role: "user", parts: [{ text: filler }] }] };
    const bg = estimateRawBodyBreakdown(google);
    assert.ok(bg.messages >= t(filler), "Google `contents` mass lands in the messages bucket");
    assert.equal(bg.total, estimateRawBodyTokens(google), "total invariant holds for Google");
    // The irreducible price the gate pays (total − messages) excludes the
    // foldable channel on all three shapes.
    for (const [shape, bd] of [["responses", br], ["google", bg]] as const) {
        assert.ok(bd.total - bd.messages < t(filler), `${shape}: irreducible price excludes the foldable channel`);
    }
});
