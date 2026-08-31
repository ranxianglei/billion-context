import test from "node:test";
import assert from "node:assert/strict";
import type { OpenAIMessage } from "acp-kernel/wire";
import { mergeSystemMessages } from "../src/util.ts";

function msg(role: OpenAIMessage["role"], content: string): OpenAIMessage {
    return { role, content };
}

const SEP = "\n\n---\n\n";

test("mergeSystemMessages: no-op (same array) for an empty list", () => {
    const msgs: OpenAIMessage[] = [];
    assert.equal(mergeSystemMessages(msgs, []), msgs);
});

test("mergeSystemMessages: no-op (same array) when there is no system content at all", () => {
    const msgs = [msg("user", "u1"), msg("assistant", "a1")];
    assert.equal(mergeSystemMessages(msgs, []), msgs);
});

test("mergeSystemMessages: sysParts become the single leading system message when there are no block summaries", () => {
    const msgs = [msg("user", "u1"), msg("assistant", "a1")];
    const out = mergeSystemMessages(msgs, ["client-sys", "compress-prompt"]);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant"]);
    assert.equal(out[0]!.content, ["client-sys", "compress-prompt"].join(SEP));
});

test("mergeSystemMessages: a single mid-conversation system merges into the leading system, sysParts first", () => {
    const msgs = [
        msg("system", "client-sys"),
        msg("user", "u1"),
        msg("system", "summary-b3"),
        msg("user", "u2"),
    ];
    const out = mergeSystemMessages(msgs, ["compress-prompt"]);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "user"]);
    assert.equal(out[0]!.content, ["compress-prompt", "client-sys", "summary-b3"].join(SEP));
});

test("mergeSystemMessages: multiple systems (head + mid) merge into ONE leading message, sysParts first, summaries in anchor order", () => {
    const msgs = [
        msg("system", "client-sys"),
        msg("system", "b1"),
        msg("user", "u1"),
        msg("system", "b2"),
        msg("user", "u2"),
        msg("developer", "dev-mid"),
        msg("assistant", "a1"),
    ];
    const out = mergeSystemMessages(msgs, ["compress-prompt"]);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "user", "assistant"]);
    assert.equal(out[0]!.content, ["compress-prompt", "client-sys", "b1", "b2", "dev-mid"].join(SEP));
});

test("mergeSystemMessages: no leading system — mid systems become the merged leading message", () => {
    const msgs = [
        msg("user", "u1"),
        msg("system", "summary-b1"),
        msg("user", "u2"),
        msg("system", "summary-b2"),
    ];
    const out = mergeSystemMessages(msgs, []);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "user"]);
    assert.equal(out[0]!.content, ["summary-b1", "summary-b2"].join(SEP));
});

test("mergeSystemMessages: an all-system list collapses into one leading message", () => {
    const msgs = [
        msg("system", "s1"),
        msg("developer", "d1"),
        msg("system", "s2"),
    ];
    const out = mergeSystemMessages(msgs, []);
    assert.deepEqual(out.map((m) => m.role), ["system"]);
    assert.equal(out[0]!.content, ["s1", "d1", "s2"].join(SEP));
});

test("mergeSystemMessages: the issue #377 wire shape — 2+ system messages collapse to exactly ONE leading system", () => {
    const msgs = [
        msg("system", "sysprompt"),
        msg("system", "b1"),
        msg("system", "b2"),
        msg("user", "m00240"),
        msg("system", "b3"),
        msg("user", "m00329"),
    ];
    const out = mergeSystemMessages(msgs, ["client-sys"]);
    const systemCount = out.filter((m) => m.role === "system" || m.role === "developer").length;
    assert.equal(systemCount, 1, "exactly one system message (sglang requires index-0 only)");
    assert.equal(out[0]!.role, "system");
    assert.equal(out[0]!.content, ["client-sys", "sysprompt", "b1", "b2", "b3"].join(SEP));
    assert.deepEqual(out.slice(1).map((m) => m.role), ["user", "user"]);
});

test("mergeSystemMessages: non-string system content is JSON-stringified into the merged message", () => {
    const msgs: OpenAIMessage[] = [
        { role: "system", content: [{ type: "text", text: "part-a" }] },
        msg("user", "u1"),
    ];
    const out = mergeSystemMessages(msgs, []);
    assert.deepEqual(out.map((m) => m.role), ["system", "user"]);
    assert.equal(out[0]!.content, JSON.stringify([{ type: "text", text: "part-a" }]));
});
