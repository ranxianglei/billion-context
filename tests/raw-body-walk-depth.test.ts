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

// #7168: a client (the DeepSeek harness) rides its incremental session log on the
// model request under the top-level `dsh_session_log` field. The model never
// reads it, so a seeded session's full-log resend (capped at 8 MiB per turn) must
// NOT count toward the egress window — otherwise it dooms every turn and the 413
// freezes the client's own delivery watermark, deadlocking the session.
test("#7168: top-level dsh_session_log never counts toward the window (both walks)", () => {
    const logBlob = "e".repeat(200_000); // ~200 KB of log mass the model ignores
    const body = {
        messages: [{ role: "user", content: [{ type: "text", text: "small real turn" }] }],
        dsh_session_log: { version: 1, afterSeq: -1, throughSeq: 9999, events: [{ seq: 1, data: logBlob }] },
    };
    const bd = estimateRawBodyBreakdown(body);
    // Only the real messages[] mass is counted; the 200 KB log is invisible.
    assert.equal(bd.messages, t("user") + t("text") + t("small real turn"));
    assert.equal(bd.tools, 0);
    assert.equal(bd.system, 0);
    assert.equal(bd.other, 0);
    assert.equal(bd.total, bd.messages);
    // The documented total invariant still holds once the field is excluded.
    assert.equal(estimateRawBodyTokens(body), bd.total);
    // Sanity: had the blob been counted, it would dwarf the counted window mass.
    assert.ok(t(logBlob) > bd.total);
});

test("#7168: a nested dsh_session_log key is still counted (only top-level is exempt)", () => {
    const logBlob = "f".repeat(50_000);
    const body = {
        messages: [{ role: "user", content: [{ type: "text", text: "hi", dsh_session_log: logBlob }] }] as Record<string, unknown>[],
    };
    // The field inside a message block is model-visible text, so it counts.
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("text") + t("hi") + t(logBlob));
    assert.equal(estimateRawBodyTokens(body), bd.total);
});
