// #3838: parseDshPatchEntries — the single source of truth for cordis.patch.yml
// entry enablement semantics, shared by the #2462 cost advisory and the #2861
// host-plugin notice. These tests pin the exact block-attribution contract both
// consumers rely on: a disabled flag belongs to its own entry's block only.
import test from "node:test";
import assert from "node:assert/strict";

import { parseDshPatchEntries } from "../src/dsh-channel.js";

test("parseDshPatchEntries: enabled and disabled entries parsed with block-scoped flags", () => {
    const text = [
        "# a comment",
        "- id: llm-pi-ai",
        "- id: auto-review",
        "  disabled: true",
        "- id: other",
        "  config:",
        "    x: 1",
        "",
    ].join("\n");
    assert.deepEqual(parseDshPatchEntries(text), [
        { id: "llm-pi-ai", disabled: false },
        { id: "auto-review", disabled: true },
        { id: "other", disabled: false },
    ]);
});

test("parseDshPatchEntries: surrounding quotes stripped, empty id dropped, trailing entry flushed", () => {
    const text = '- id: "auto-review"\n- id: \'\' \n';
    assert.deepEqual(parseDshPatchEntries(text), [{ id: "auto-review", disabled: false }]);
});

test("parseDshPatchEntries: only an INDENTED `disabled: true` inside the own block counts", () => {
    // column-0 flag belongs to no entry; false / non-word values do not match
    const text = ["disabled: true", "- id: a", "  disabled: false", "- id: b", "  disabled: truex"].join("\n");
    assert.deepEqual(parseDshPatchEntries(text), [
        { id: "a", disabled: false },
        { id: "b", disabled: false },
    ]);
});

test("parseDshPatchEntries: a non-id list item resets attribution — no leak across blocks", () => {
    const text = ["- insert:", "  - bare-entry", "  disabled: true", "- id: c"].join("\n");
    assert.deepEqual(parseDshPatchEntries(text), [{ id: "c", disabled: false }]);
});

test("parseDshPatchEntries: CRLF line endings", () => {
    const text = "- id: d\r\n  disabled: true\r\n";
    assert.deepEqual(parseDshPatchEntries(text), [{ id: "d", disabled: true }]);
});

test("parseDshPatchEntries: duplicate ids kept per occurrence", () => {
    const text = ["- id: e", "- id: e", "  disabled: true"].join("\n");
    assert.deepEqual(parseDshPatchEntries(text), [
        { id: "e", disabled: false },
        { id: "e", disabled: true },
    ]);
});

test("parseDshPatchEntries: `disabled` is read by value, not by the literal `true`", () => {
    // The patch layer accepts more than a lowercase boolean: YAML 1.1 spellings,
    // quoted forms, and dsh's `!!js` extension (a stock web-profile dump carries
    // four such rows today). A text scan that only matched `true` reported every
    // one of these as ENABLED, which turned into a wrong cost hint and a notice
    // the user could not dismiss.
    const text = [
        "- id: bool-lower",
        "  disabled: true",
        "- id: bool-title",
        "  disabled: True",
        "- id: yaml-short",
        "  disabled: on",
        "- id: quoted",
        '  disabled: "true"',
        "- id: js-const",
        "  disabled: !!js true",
        "- id: js-expr",
        "  disabled: !!js process.platform === 'win32'",
        "- id: commented",
        "  disabled: true # because it doubles the bill",
        "- id: still-on-false",
        "  disabled: false",
        "- id: still-on-false-title",
        "  disabled: False",
        "- id: not-a-boolean",
        "  disabled: truex",
    ].join("\n");
    const byId = new Map(parseDshPatchEntries(text).map((e) => [e.id, e.disabled]));
    assert.equal(byId.get("bool-lower"), true);
    assert.equal(byId.get("bool-title"), true, "YAML 1.1 `True`");
    assert.equal(byId.get("yaml-short"), true, "YAML 1.1 `on`");
    assert.equal(byId.get("quoted"), true, "a quoted boolean is still a declaration");
    assert.equal(byId.get("js-const"), true, "`!!js true` is off");
    assert.equal(byId.get("js-expr"), true, "an unevaluable expression counts as off (conservative)");
    assert.equal(byId.get("commented"), true, "a trailing comment does not hide the value");
    assert.equal(byId.get("still-on-false"), false);
    assert.equal(byId.get("still-on-false-title"), false);
    assert.equal(byId.get("not-a-boolean"), false, "`truex` is not a boolean");
});
