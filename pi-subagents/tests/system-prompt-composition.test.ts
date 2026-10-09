import { test } from "node:test";
import assert from "node:assert/strict";
import { injectSystemPromptAppendix } from "../src/compat.js";

// #2531 / billion-context-pi#630: injecting the delegate appendix by RETURNING a
// { systemPrompt } replacement forces the prompt on pi >= 0.87 (a returned
// systemPrompt maps to forceSystemPrompt, whose buildSystemPromptState returns
// ONLY the forced text and silently drops every other extension's structured
// appendSystemPrompt — load-order dependent). injectSystemPromptAppendix must
// compose through the appendable channel on that event shape and fall back to
// the byte-identical replacement on the older (<= 0.86) shape. Detection is by
// event shape (accessor vs data property on `systemPrompt`), so both shapes are
// pinned here directly rather than through a version number.

const BLOCK = "\nACP_DELEGATE NOTIFICATIONS\n";

function newerPiEvent(options: { appendSystemPrompt?: string }): { systemPromptOptions: { appendSystemPrompt?: string } } & { readonly systemPrompt: string } {
    return {
        get systemPrompt() { return "RENDERED BASE"; },
        systemPromptOptions: options,
    };
}

test("older pi (data-property systemPrompt): returns the byte-identical replacement", () => {
    const event = { systemPrompt: "HOST BASE" };
    assert.deepEqual(injectSystemPromptAppendix(event, BLOCK), { systemPrompt: `HOST BASE\n\n${BLOCK}` });
});

test("older pi (array systemPrompt): normalizes then appends", () => {
    const event = { systemPrompt: ["A", "B"] };
    assert.deepEqual(injectSystemPromptAppendix(event, BLOCK), { systemPrompt: `A\nB\n\n${BLOCK}` });
});

test("newer pi (getter systemPrompt): composes into appendSystemPrompt and forces nothing", () => {
    const options: { appendSystemPrompt?: string } = {};
    const result = injectSystemPromptAppendix(newerPiEvent(options), BLOCK);
    assert.equal(result, undefined, "no forced replacement returned");
    assert.equal(options.appendSystemPrompt, BLOCK, "appendix composed into appendSystemPrompt");
});

test("newer pi: idempotent per options object (no double-append)", () => {
    const options: { appendSystemPrompt?: string } = {};
    const event = newerPiEvent(options);
    injectSystemPromptAppendix(event, BLOCK);
    injectSystemPromptAppendix(event, BLOCK);
    assert.equal((options.appendSystemPrompt!.match(/ACP_DELEGATE NOTIFICATIONS/g) ?? []).length, 1, "appended exactly once");
});

test("newer pi: preserves a prior extension's append and appends ours after it (order-independent)", () => {
    const options: { appendSystemPrompt?: string } = { appendSystemPrompt: "HARNESS APPEND" };
    injectSystemPromptAppendix(newerPiEvent(options), BLOCK);
    assert.equal(options.appendSystemPrompt, `HARNESS APPEND\n\n${BLOCK}`, "prior append kept first, ours appended");
});

test("newer pi without systemPromptOptions: safe no-op (nothing forced, nothing appended)", () => {
    const event = { get systemPrompt() { return "RENDERED BASE"; } };
    const result = injectSystemPromptAppendix(event, BLOCK);
    assert.equal(result, undefined);
    assert.equal((event as { systemPromptOptions?: unknown }).systemPromptOptions, undefined, "event left untouched");
});
