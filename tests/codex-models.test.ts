import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import {
    CODEX_FALLBACK_CONTEXT_WINDOW,
    _resetCodexTableForTest,
    _setCodexTableForTest,
    codexAlignedWindow,
    codexWindowForModel,
    isCodexClient,
} from "../src/codex-models.ts";

// #321 PR-E1: codex carries its own window perception (bundled model table +
// 272K unknown-model fallback) and auto-compacts at 90% of it. bili must cap
// a codex client's effective window at that perception, or codex's native
// compaction fires first (the #292 misalignment).

const CODEX_UA = "codex_cli_rs/0.53.0 (linux 6.8.0; x86_64) cli";

test("snapshot integrity: every entry has a slug and a resolvable window", () => {
    assert.ok(codexWindowForModel("gpt-5.5") > 0);
    assert.equal(CODEX_FALLBACK_CONTEXT_WINDOW, 272_000);
});

test("in-table exact slug: context_window wins over max_context_window", () => {
    assert.equal(codexWindowForModel("gpt-5.5"), 272_000);
    assert.equal(codexWindowForModel("gpt-5.4"), 272_000, "gpt-5.4 max is 1M but codex resolves context_window=272K");
    assert.equal(codexWindowForModel("gpt-daybreak-red-latest"), 372_000);
});

test("longest-prefix match: model starting with a table slug inherits it", () => {
    assert.equal(codexWindowForModel("gpt-5.5-mini"), 272_000, "gpt-5.5-mini → gpt-5.5");
    assert.equal(codexWindowForModel("gpt-5.4-turbo"), 272_000, "gpt-5.4-turbo → gpt-5.4");
    assert.equal(codexWindowForModel("gpt-5.4-mini-x"), 272_000, "longest slug wins (gpt-5.4-mini over gpt-5.4)");
});

test("namespaced suffix retry: provider-like namespace stripped once", () => {
    assert.equal(codexWindowForModel("custom/gpt-5.5"), 272_000);
    assert.equal(codexWindowForModel("openai/gpt-5.4"), 272_000);
});

test("not in table: 272K fallback (codex's model_info_from_slug), NOT unlimited", () => {
    assert.equal(codexWindowForModel("qwen3.8-27b"), 272_000);
    assert.equal(codexWindowForModel("my-custom-model"), 272_000);
    assert.equal(codexWindowForModel("custom/gpt-5.3-codex"), 272_000, "suffix miss → fallback");
    assert.equal(codexWindowForModel("a/b/gpt-5.5"), 272_000, "double slash → no retry → fallback");
});

test("isCodexClient: UA prefix codex_cli_rs/ only", () => {
    assert.equal(isCodexClient({ "user-agent": CODEX_UA }), true);
    assert.equal(isCodexClient({ "user-agent": "node-fetch/3.1" }), false);
    assert.equal(isCodexClient({}), false);
    assert.equal(isCodexClient({ "user-agent": ["node-fetch/3.1", CODEX_UA] }), true, "array headers");
    assert.equal(isCodexClient({ "user-agent": "Codex_CLI_RS/0.53.0" }), false, "case-sensitive");
});

test("codexAlignedWindow: min() semantics per acceptance (in-table / not-in-table / user override)", () => {
    const codex = { "user-agent": CODEX_UA };
    const other = { "user-agent": "node-fetch/3.1" };
    // in-table: bili 400K (built-in table) → clamped to codex's 272K
    assert.deepEqual(codexAlignedWindow(400_000, "gpt-5.5", codex), { limit: 272_000, clamped: true });
    // not-in-table: bili 1M → clamped to the 272K fallback
    assert.deepEqual(codexAlignedWindow(1_000_000, "qwen3.8-27b", codex), { limit: 272_000, clamped: true });
    // bili below perception: untouched (min keeps bili's)
    assert.deepEqual(codexAlignedWindow(200_000, "gpt-5.5", codex), { limit: 200_000, clamped: false });
    // equal: untouched
    assert.deepEqual(codexAlignedWindow(272_000, "gpt-5.5", codex), { limit: 272_000, clamped: false });
    // non-codex client: never touched
    assert.deepEqual(codexAlignedWindow(400_000, "gpt-5.5", other), { limit: 400_000, clamped: false });
    // user override below perception (PR-D style -c model_context_window=100000): untouched
    assert.deepEqual(codexAlignedWindow(100_000, "gpt-5.5", codex), { limit: 100_000, clamped: false });
});

test("test hooks: table replacement + reset", () => {
    _setCodexTableForTest([{ slug: "test-model", contextWindow: 12_345 }]);
    assert.equal(codexWindowForModel("test-model"), 12_345);
    assert.equal(codexWindowForModel("test-model-x"), 12_345);
    _resetCodexTableForTest();
    assert.equal(codexWindowForModel("gpt-5.5"), 272_000);
});
