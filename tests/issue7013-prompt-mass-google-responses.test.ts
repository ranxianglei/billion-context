// #7013 follow-up: the measured-doom clause must not call a wire format's
// PROMPT fields "non-prompt, excluded from the window budget".
//
// #7092 prices the window-fit gates off `breakdown.prompt` (PROMPT_BODY_KEYS),
// but `breakdown.other` is still bucketed by the ANTHROPIC key names
// (messages / tools / system / everything-else). For google and responses the
// prompt fields live in that "everything-else" bucket (`contents`, `input`,
// `systemInstruction`, `instructions`), so a 413 whose triggering dimension is
// `prompt` renders a clause that says "other ~1,200,008 (non-prompt, excluded
// from the window budget; top field: contents …)" while `contents` is exactly
// what blew the window — self-contradictory for the operator reading it.
//
// The fix carries the prompt mass inside `other` explicitly (`otherPrompt`) so
// the clause can say "of which N counts toward the window, M is excluded".
// These assertions pin both the new labeling and the anthropic/openai shape
// (where `other` really is non-prompt and the old wording must survive).
import assert from "node:assert/strict";
import test from "node:test";

import { estimateRawBodyBreakdown, PROMPT_BODY_KEYS } from "../src/preflight.ts";
import { measuredBreakdownClause, measuredOutbound } from "../src/server.ts";

const L = (n: number, ch: string) => ch.repeat(n);

// defaultCountTokens: ASCII run of 4 chars = 1 token, so multiples of 4 are exact.
const tokens = (asciiLen: number) => asciiLen / 4;

test("#7013: google — contents/systemInstruction ride 'other' but are prompt mass", () => {
    const body = {
        contents: [{ parts: [{ text: L(4_000, "C") }] }],
        systemInstruction: { parts: [{ text: L(400, "S") }] },
        tools: [],
        dsh_session_log: L(400_000, "L"),
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.google);
    assert.equal(bd.prompt, tokens(4_400), "google prompt mass = contents + systemInstruction");
    assert.equal(bd.other, tokens(4_400) + tokens(400_000), "the bucket shape stays anthropic-named");
    assert.equal(bd.otherPrompt, tokens(4_400), "prompt mass inside 'other' must be reported, not implied");
    assert.equal(bd.total, bd.prompt + tokens(400_000), "total = prompt + non-prompt transport");
});

test("#7013: google — a 413 whose dim is the PROMPT must not label it excluded", () => {
    // contents alone blows the 1,048,576 bar; dsh_session_log is pure transport.
    const body = {
        contents: [{ parts: [{ text: L(4_800_000, "C") }] }],
        systemInstruction: { parts: [{ text: "ssss" }] },
        dsh_session_log: L(400_000, "L"),
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.google);
    assert.ok(bd.prompt > 1_048_576, `contents alone must exceed the window, got prompt=${bd.prompt}`);
    const clause = measuredBreakdownClause(bd);
    assert.match(clause, /top field: contents/, `the clause must name the field carrying the mass, got: ${clause}`);
    assert.match(clause, /prompt mass ~[\d,]+ counted toward the window/, `the prompt part of 'other' is counted, not excluded, got: ${clause}`);
    assert.match(clause, /[\d,]+ excluded as non-prompt/, `the transport part is what gets excluded, got: ${clause}`);
    assert.doesNotMatch(clause, /\(non-prompt, excluded from the window budget; top field: contents/, "the contradictory wording must be gone for a prompt-bearing field");
});

test("#7013: responses — input/instructions ride 'other' but are prompt mass", () => {
    const body = {
        input: L(40_000, "I"),
        instructions: L(400, "N"),
        dsh_session_log: L(4_000, "L"),
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.responses);
    assert.equal(bd.prompt, tokens(40_400), "responses prompt mass = input + instructions");
    assert.equal(bd.otherPrompt, tokens(40_400), "input + instructions both sit in other and are prompt mass");
    const clause = measuredBreakdownClause(bd);
    assert.match(clause, /top field: input/);
    assert.match(clause, /prompt mass ~[\d,]+ counted toward the window/, `got: ${clause}`);
});

test("#7013: anthropic — dsh_session_log stays non-prompt and keeps the old wording", () => {
    const body = {
        messages: [{ role: "user", content: "hello" }],
        system: "sys",
        dsh_session_log: L(8_000_000, "L"),
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.anthropic);
    assert.equal(bd.otherPrompt, 0, "nothing in 'other' is prompt mass for anthropic");
    const clause = measuredBreakdownClause(bd);
    assert.match(clause, /other ~[\d,]+ \(non-prompt, excluded from the window budget; top field: dsh_session_log ~[\d,]+ tokens ≈[\d,]+ B\)/, `got: ${clause}`);
});

test("#7013: openai — same non-prompt shape as anthropic", () => {
    const body = {
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        dsh_session_log: L(4_000, "L"),
    };
    const bd = estimateRawBodyBreakdown(body, PROMPT_BODY_KEYS.openai);
    assert.equal(bd.otherPrompt, 0);
    assert.match(measuredBreakdownClause(bd), /\(non-prompt, excluded from the window budget; top field: dsh_session_log/);
});

test("#7013: measuredOutbound prices prompt mass for every protocol", () => {
    const cases = [
        { protocol: "google" as const, body: { contents: [{ parts: [{ text: L(4_000, "C") }] }], dsh_session_log: L(4_000, "L") } },
        { protocol: "responses" as const, body: { input: L(4_000, "I"), dsh_session_log: L(4_000, "L") } },
        { protocol: "anthropic" as const, body: { messages: [{ content: L(4_000, "M") }], dsh_session_log: L(4_000, "L") } },
        { protocol: "openai" as const, body: { messages: [{ content: L(4_000, "M") }], dsh_session_log: L(4_000, "L") } },
    ];
    for (const c of cases) {
        const wire = JSON.stringify(c.body);
        const m = measuredOutbound({ body: wire, protocol: c.protocol });
        assert.ok(m, `measuredOutbound must parse a ${c.protocol} body`);
        assert.equal(m.tokens, m.breakdown.prompt, `${c.protocol}: the gate prices prompt mass`);
        assert.equal(m.tokens, tokens(4_000), `${c.protocol}: the transport upload must not inflate the gate`);
        assert.equal(m.breakdown.otherPrompt > 0, c.protocol === "google" || c.protocol === "responses", `${c.protocol}: prompt-in-other attribution`);
    }
});

