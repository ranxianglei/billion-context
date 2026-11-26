// Unit coverage for the commit-attribution gate's message check
// (scripts/check-commit-attribution.mjs): the marker line must be exactly
// `Attribution: human` or `Attribution: ai <provider>/<model-id>` — present
// anywhere in the message, CRLF-safe, and rejected when malformed or
// followed by trailing prose (the line is a machine-readable field).
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitHasAttribution, RULE_ANCHOR } from "../scripts/check-commit-attribution.mjs";

test("human marker is accepted, in subject or trailer position", () => {
    assert.equal(commitHasAttribution("fix: adjust spacing\n\nAttribution: human"), true);
    assert.equal(commitHasAttribution("Attribution: human"), true);
});

test("ai marker is accepted with provider/model-id, ids may contain dots and dashes", () => {
    assert.equal(commitHasAttribution("feat: wire it up\n\nAttribution: ai anthropic/claude-opus-4-5"), true);
    assert.equal(commitHasAttribution("fix: x\n\nAttribution: ai sglang-gpu0/qwen3.8-27b"), true);
});

test("missing marker fails", () => {
    assert.equal(commitHasAttribution("feat: wire it up\n\nFixes #123"), false);
    assert.equal(commitHasAttribution(""), false);
    assert.equal(commitHasAttribution(undefined), false);
});

test("malformed markers fail: trailing prose, bad shape, glued tokens", () => {
    assert.equal(commitHasAttribution("fix: x\n\nAttribution: human (really)"), false);
    assert.equal(commitHasAttribution("fix: x\n\nAttribution: ai anthropic"), false);
    assert.equal(commitHasAttribution("fix: x\n\nAttribution: ai/anthropic/claude"), false);
    assert.equal(commitHasAttribution("fix: x\n\nAttribution: agent human"), false);
    assert.equal(commitHasAttribution("fix: x\n\nxAttribution: human"), false);
});

test("CRLF line endings are accepted", () => {
    assert.equal(commitHasAttribution("fix: x\r\n\r\nAttribution: human\r\n"), true);
    assert.equal(commitHasAttribution("fix: x\r\n\r\nAttribution: ai anthropic/claude-opus-4-5\r\n"), true);
});

test("RULE_ANCHOR is the literal marker example used in AGENTS.md", () => {
    assert.equal(RULE_ANCHOR, "Attribution: ai <provider>/<model-id>");
});
