import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { dropWhitespaceResponsesMessages } from "../src/loop/adapter-responses.ts";

function msg(role: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: "message", role, content: [{ type: "output_text", text }], ...extra };
}

test("drops whitespace-only user/assistant message items, keeps everything else", () => {
    const input: unknown[] = [
        { type: "message", role: "developer", content: "system prompt" },
        { role: "user", content: "介绍" }, // omp omits the type field on user items
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "\n\n" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "\n" }] },
        { type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "real answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "  \n\t" }] },
    ];
    const dropped = dropWhitespaceResponsesMessages(input);
    assert.equal(dropped, 3);
    assert.equal(input.length, 6);
    assert.deepEqual(input.map((i) => (i as Record<string, unknown>).type), [
        "message",
        undefined,
        "function_call",
        "function_call_output",
        "reasoning",
        "message",
    ]);
    // the kept user item (no type field) survives with its content intact
    assert.equal((input[1] as Record<string, unknown>).content, "介绍");
});

test("keeps messages with any non-whitespace text, even mostly blank", () => {
    const tag = (tokens: string, ref: string): string => `\x3cacp tokens="${tokens}" type="text"\x3e${ref}\x3c/acp\x3e`;
    const input: unknown[] = [
        msg("assistant", "\n\nx"),
        msg("assistant", `\n\n${tag("1", "m00004")}\n\n`), // tag over nothing: replayed empty
        msg("assistant", `  ${tag("1", "m00005")}  `), // self-closing form
        msg("assistant", `${tag("377", "m00002")}\n\n\nreal body text`), // tag over content: keep
        { type: "message", role: "assistant", content: "  " },
    ];
    const dropped = dropWhitespaceResponsesMessages(input);
    assert.equal(dropped, 3);
    assert.equal(input.length, 2);
    const kept = (input[1] as { content: Array<{ text: string }> }).content[0].text;
    assert.match(kept, /real body text/);
});

test("string content counts; empty string drops, developer/system roles never drop", () => {
    const input: unknown[] = [
        { type: "message", role: "user", content: "" },
        { type: "message", role: "developer", content: "   " },
        { type: "message", role: "system", content: "" },
    ];
    const dropped = dropWhitespaceResponsesMessages(input);
    assert.equal(dropped, 1);
    assert.equal(input.length, 2);
    assert.equal((input[0] as Record<string, unknown>).role, "developer");
});

test("non-array input tolerated; message with non-text parts kept", () => {
    assert.equal(dropWhitespaceResponsesMessages(undefined), 0);
    assert.equal(dropWhitespaceResponsesMessages("full text"), 0);
    const input: unknown[] = [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: " " }, { type: "refusal", refusal: "no" }] },
    ];
    assert.equal(dropWhitespaceResponsesMessages(input), 0);
    assert.equal(input.length, 1);
});

test("dropWhitespaceResponsesMessages preserves items with malformed non-object content parts", () => {
    const input = [
        { role: "assistant", content: [{ type: "output_text", text: "\n\n" }, 42] },
        { role: "assistant", content: [{ type: "output_text", text: "real" }] },
    ];
    const dropped = dropWhitespaceResponsesMessages(input);
    assert.equal(dropped, 0, "malformed part makes emptiness unknowable — item preserved");
    assert.equal(input.length, 2, "nothing removed");
});
