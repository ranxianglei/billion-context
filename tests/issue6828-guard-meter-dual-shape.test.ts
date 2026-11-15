import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

// #6828: a dual-shape body carries the conversation under TWO top-level keys —
// the lane's native field (messages[] on openai/anthropic, input[] on
// responses) plus the other protocol's field (a Responses-native host such as
// dsh sends `input` alongside `messages`). The upstream bills only the native
// field; the #554 meter walks every string field, so it counted the
// conversation twice and the egress fuse false-tripped on the phantom total
// (1,815,699 measured vs ~380K billed, 4.77x). The meter must skip the foreign
// conversation fields for the lane's protocol, top level only.
const t = (s: string): number => defaultCountTokens(s);
const WINDOW = 1_048_576;

test("openai lane: a Responses-shaped `input` copy is not metered (#6828)", () => {
    const body = {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "compress", description: "fold" } }],
        system: "be helpful",
        input: [{ type: "message", role: "user", content: "the whole raw history, again" }],
        instructions: "do the thing",
    };
    const bd = estimateRawBodyBreakdown(body, "openai");
    // the walk counts every string leaf, roles/types included
    assert.equal(bd.messages, t("user") + t("hello"));
    assert.equal(bd.system, t("be helpful"));
    assert.equal(bd.tools, t("function") + t("compress") + t("fold"), "tools still counted");
    assert.equal(bd.other, t("deepseek-flash"), "other holds only the envelope strings, not input/instructions");
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.other);
    assert.equal(bd.total, estimateRawBodyTokens(body, "openai"), "total invariant holds with a protocol");
});

test("responses lane: stray `messages`/`system` copies are not metered (#6828)", () => {
    const body = {
        model: "deepseek-flash",
        input: [{ type: "message", role: "user", content: "the conversation" }],
        instructions: "be helpful",
        tools: [{ type: "function", function: { name: "compress", description: "fold" } }],
        messages: [{ role: "user", content: "the same conversation, openai-shaped" }],
        system: "be helpful, again",
    };
    const bd = estimateRawBodyBreakdown(body, "responses");
    assert.equal(bd.messages, 0, "foreign messages[] excluded on the responses lane");
    assert.equal(bd.system, 0, "foreign system excluded on the responses lane");
    assert.equal(bd.other, t("deepseek-flash") + t("message") + t("user") + t("the conversation") + t("be helpful"));
    assert.equal(bd.total, estimateRawBodyTokens(body, "responses"), "total invariant holds with a protocol");
});

test("no protocol: the meter keeps its fail-closed count-everything behavior (#6828)", () => {
    const body = {
        messages: [{ role: "user", content: "hello" }],
        input: [{ type: "message", role: "user", content: "the whole raw history, again" }],
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("hello"));
    assert.equal(bd.other, t("message") + t("user") + t("the whole raw history, again"), "without a protocol nothing is excluded");
    assert.equal(bd.total, estimateRawBodyTokens(body));
});

test("nested same-named keys stay counted: only the top level is skipped (#6828)", () => {
    const body = {
        messages: [{ role: "user", content: "hi", input: "nested input text" }],
        input: "foreign top-level copy",
    };
    const bd = estimateRawBodyBreakdown(body, "openai");
    assert.equal(bd.messages, t("user") + t("hi") + t("nested input text"), "a message's own `input` field is real content");
    assert.equal(bd.other, 0, "only the top-level `input` is skipped");
});

test("reporter scale: the #6828 fuse reading measures ~213K, not ~1.8M (#6828)", () => {
    // models the issue's fuse reading: messages ~126,254 · tools[] ~76,502 ·
    // system ~10,641 · other ~1,602,302 · total ~1,815,699 vs window 1,048,576,
    // while the upstream billed ~380,665 (inputTokens 249 + cacheRead 380,416).
    const cjk = (n: number): string => "测".repeat(n);
    const ascii = (n: number): string => "a".repeat(n);
    const perMsg = Math.floor(126_254 / 25);
    const messages = Array.from({ length: 25 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: cjk(perMsg),
    }));
    const tools = [
        { type: "function", function: { name: "compress", description: ascii(100_000), parameters: ascii(100_000) } },
        { type: "function", function: { name: "retrieve", description: ascii(106_008), parameters: "" } },
    ];
    const perItem = Math.floor(1_602_302 / 40);
    const input = Array.from({ length: 40 }, (_, i) => ({
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: cjk(perItem),
    }));
    const body = { model: "deepseek-flash", messages, tools, system: cjk(10_641), input };
    const unscoped = estimateRawBodyBreakdown(body);
    assert.ok(unscoped.total > WINDOW, `unscoped meter still sees the phantom total (${unscoped.total})`);
    assert.ok(Math.abs(unscoped.total / 380_665 - 4.77) < 0.05, `unscoped ratio reproduces the reported 4.77x (${(unscoped.total / 380_665).toFixed(2)}x)`);
    const bd = estimateRawBodyBreakdown(body, "openai");
    assert.ok(bd.total < WINDOW, `openai-lane meter fits the window (${bd.total} < ${WINDOW})`);
    assert.ok(Math.abs(bd.messages - 126_254) < 200, `messages bucket matches the report (${bd.messages})`);
    assert.ok(Math.abs(bd.tools - 76_502) < 200, `tools bucket matches the report (${bd.tools})`);
    assert.equal(bd.system, 10_641, "system bucket matches the report");
    assert.ok(bd.other < 100, `other is envelope-only, not the 1.6M copy (${bd.other})`);
});
