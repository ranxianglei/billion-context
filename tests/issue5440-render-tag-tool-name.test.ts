import { test } from "node:test";
import assert from "node:assert/strict";
import { isRenderTagToolName, ECHOED_TOOL_RESULT_TEXT } from "../src/loop/tag-echo-filter.ts";

// #5440: a model can echo a render tag into a tool call's NAME (attested:
// `acp tokens=`, args {}, deepseek via DSH). No host has such a tool, so
// forwarding it guarantees an UNKNOWN_TOOL failure and a full-context recovery
// step. The loop answers the call in-proxy with a canned result and re-requests
// (exactly like a proxy tool); the client never sees the bogus call. This test
// pins the NAME-channel predicate that drives the loop branch.

test("#5440: isRenderTagToolName matches echoed render-tag names", () => {
    const echoed = [
        "acp tokens=", // attested shape: name + attrs
        "acp", // bare name
        "ACP", // case drift (#1731)
        "\x3cacp tokens=\"2\" type=\"text\">m00001\x3c/acp>", // full tag as the name
        "acb", // attested 3-letter drift
        "accessp", // attested drift
        "acpi", // 4-letter insertion drift
        "  acp tokens=", // leading whitespace
    ];
    for (const name of echoed) {
        assert.equal(isRenderTagToolName(name), true, `should be an echo: ${JSON.stringify(name)}`);
    }
});

test("#5440: isRenderTagToolName does NOT match real tool names", () => {
    const real = [
        "acp_status", // underscore is not a tag boundary -> stops the match
        "bash",
        "read",
        "write",
        "grep",
        "caption", // contains core "cap" but the next char is a word char
        "acpfoo", // word char immediately after the name
        "acpx", // excluded drift (not in the vocabulary)
    ];
    for (const name of real) {
        assert.equal(isRenderTagToolName(name), false, `should NOT be an echo: ${JSON.stringify(name)}`);
    }
});

test("#5440: isRenderTagToolName is false for an empty name (the nameless path owns it)", () => {
    assert.equal(isRenderTagToolName(""), false);
});

test("#5440: ECHOED_TOOL_RESULT_TEXT is a canned non-executing continuation", () => {
    assert.ok(ECHOED_TOOL_RESULT_TEXT.length > 0);
    assert.match(ECHOED_TOOL_RESULT_TEXT, /nothing was executed/i);
});

