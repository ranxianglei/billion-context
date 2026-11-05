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
