import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import {
    CODEX_FALLBACK_CONTEXT_WINDOW,
    _resetCodexTableForTest,
    _resetLocalCodexSourceForTest,
    _setCodexTableForTest,
    _setLocalCodexSourceForTest,
    codexAlignedWindow,
    codexWindowForModel,
    isCodexClient,
    localCodexPerceivedWindow,
    type CodexModelEntry,
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

test("isCodexClient: UA prefixes codex_cli_rs/ and codex_exec/", () => {
    assert.equal(isCodexClient({ "user-agent": CODEX_UA }), true);
    assert.equal(isCodexClient({ "user-agent": "codex_exec/0.147.0" }), true, "exec-mode UA");
    assert.equal(isCodexClient({ "user-agent": "codex_sdk_ts/0.153.4 (Ubuntu 24.4.0; x86_64) vt100 (codex_exec; 0.153.4)" }), true, "TS-SDK client (#645 real-device UA)");
    assert.equal(isCodexClient({ "user-agent": "node-fetch/3.1" }), false);
    assert.equal(isCodexClient({}), false);
    assert.equal(isCodexClient({ "user-agent": [CODEX_UA, "node-fetch/3.1"] }), true, "array headers (first entry)");
    assert.equal(isCodexClient({ "user-agent": ["node-fetch/3.1", CODEX_UA] }), false, "array headers use first entry");
    assert.equal(isCodexClient({ "user-agent": "Codex_CLI_RS/0.53.0" }), true, "case-insensitive (#1169)");
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
    try {
        _setCodexTableForTest([{ slug: "test-model", contextWindow: 12_345 }]);
        assert.equal(codexWindowForModel("test-model"), 12_345);
        assert.equal(codexWindowForModel("test-model-x"), 12_345);
        _resetCodexTableForTest();
        assert.equal(codexWindowForModel("gpt-5.5"), 272_000);
    } finally {
        _resetCodexTableForTest();
    }
});

// #1953: reset must restore the SHIPPED snapshot. gpt-daybreak-red-latest
// (372K) differs from the 272K fallback, so a broken reset cannot hide behind
// the fallback value (the old assertion above used gpt-5.5 = fallback: masked).
test("test hooks: reset restores the shipped snapshot, second reset idempotent (#1953)", () => {
    const model = "gpt-daybreak-red-latest";
    const before = codexWindowForModel(model);
    assert.equal(before, 372_000, "shipped window differs from the 272K fallback");
    try {
        _setCodexTableForTest([{ slug: "audit-model", contextWindow: 12_345 }]);
        assert.equal(codexWindowForModel("audit-model"), 12_345);
        _resetCodexTableForTest();
        assert.equal(codexWindowForModel(model), before, "reset must restore the shipped model snapshot");
        assert.equal(codexWindowForModel("audit-model"), CODEX_FALLBACK_CONTEXT_WINDOW, "replaced table gone after reset");
        _resetCodexTableForTest();
        assert.equal(codexWindowForModel(model), before, "second reset is idempotent");
    } finally {
        _resetCodexTableForTest();
    }
});

test("test hooks: caller mutation after set does not leak into the table (#1953)", () => {
    try {
        const entry: CodexModelEntry = { slug: "caller-model", contextWindow: 12_345 };
        _setCodexTableForTest([entry]);
        entry.contextWindow = 999;
        assert.equal(codexWindowForModel("caller-model"), 12_345, "table holds its own copies of entries");
    } finally {
        _resetCodexTableForTest();
    }
});

// #2593: a codex NEW model missing from the release-time bundled snapshot used
// to clamp to the 272K unknown-model fallback even though THIS codex perceives
// its real window — under-clamping long sessions into unnecessary preflight
// compaction / 502. For a LOCAL peer (loopback) the proxy now aligns to its own
// CODEX_HOME live cache/base-config; remote peers keep the bundled fallback.

const CODEX_LOCAL_UA = { "user-agent": CODEX_UA };

test("#2593 exact repro: live cache raises an unknown slug from 272K to its real window", () => {
    try {
        // min(config 1048576, max 872000) * 95% = 828400 — the issue's verified number
        _setLocalCodexSourceForTest({
            entries: [{ slug: "gpt-6.1-sol", contextWindow: 373_000, maxContextWindow: 872_000, effectiveContextWindowPercent: 95 }],
            configContextWindow: 1_048_576,
        });
        assert.equal(localCodexPerceivedWindow("gpt-6.1-sol"), 828_400);
        // LOCAL peer: bili 1.05M is capped at codex's real 828400, not the 272K floor
        assert.deepEqual(codexAlignedWindow(1_050_000, "gpt-6.1-sol", CODEX_LOCAL_UA, { localPeer: true }),
            { limit: 828_400, clamped: true });
        // REMOTE peer (no localPeer): same request still falls to the 272K fallback
        assert.deepEqual(codexAlignedWindow(1_050_000, "gpt-6.1-sol", CODEX_LOCAL_UA),
            { limit: 272_000, clamped: true }, "remote proxy must not read this host's cache");
        // non-codex client: never touched regardless of localPeer
        assert.deepEqual(codexAlignedWindow(1_050_000, "gpt-6.1-sol", { "user-agent": "node-fetch/3.1" }, { localPeer: true }),
            { limit: 1_050_000, clamped: false });
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 no base-config override: context_window × percent applies", () => {
    try {
        _setLocalCodexSourceForTest({ entries: [{ slug: "m-noovr", contextWindow: 373_000, effectiveContextWindowPercent: 95 }] });
        assert.equal(localCodexPerceivedWindow("m-noovr"), Math.floor(373_000 * 95 / 100));
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 override clamps DOWN to max_context_window (min semantics preserved)", () => {
    try {
        _setLocalCodexSourceForTest({
            entries: [{ slug: "m-clampdown", contextWindow: 272_000, maxContextWindow: 100_000 }],
            configContextWindow: 1_048_576,
        });
        assert.equal(localCodexPerceivedWindow("m-clampdown"), 100_000, "override above max clamps to max");
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 override RAISES perception up to max (below max), matching codex", () => {
    try {
        _setLocalCodexSourceForTest({
            entries: [{ slug: "m-raise", contextWindow: 100_000, maxContextWindow: 872_000 }],
            configContextWindow: 500_000,
        });
        assert.equal(localCodexPerceivedWindow("m-raise"), 500_000, "override below max applies directly");
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 override with entry lacking max_context_window applies fully", () => {
    try {
        _setLocalCodexSourceForTest({
            entries: [{ slug: "m-nomax", contextWindow: 100_000 }],
            configContextWindow: 700_000,
        });
        assert.equal(localCodexPerceivedWindow("m-nomax"), 700_000);
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 model absent from live cache falls back to the bundled snapshot", () => {
    try {
        _setLocalCodexSourceForTest({ entries: [{ slug: "other-model", contextWindow: 12_345 }] });
        assert.equal(localCodexPerceivedWindow("gpt-5.5"), undefined, "no local match → undefined");
        assert.deepEqual(codexAlignedWindow(400_000, "gpt-5.5", CODEX_LOCAL_UA, { localPeer: true }),
            { limit: 272_000, clamped: true }, "falls through to bundled gpt-5.5=272K");
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 null live source (no usable cache/config) keeps the bundled fallback", () => {
    try {
        _setLocalCodexSourceForTest(null);
        assert.equal(localCodexPerceivedWindow("gpt-6.1-sol"), undefined);
        assert.deepEqual(codexAlignedWindow(1_050_000, "gpt-6.1-sol", CODEX_LOCAL_UA, { localPeer: true }),
            { limit: 272_000, clamped: true });
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 live cache uses the same match discipline as the bundled table", () => {
    try {
        _setLocalCodexSourceForTest({ entries: [{ slug: "gpt-6.1", contextWindow: 500_000, effectiveContextWindowPercent: 90 }] });
        // namespaced-suffix retry (custom/gpt-6.1 → gpt-6.1)
        assert.equal(localCodexPerceivedWindow("custom/gpt-6.1"), Math.floor(500_000 * 90 / 100));
        _setLocalCodexSourceForTest({ entries: [{ slug: "gpt-6", contextWindow: 300_000 }, { slug: "gpt-6.1", contextWindow: 400_000 }] });
        // longest-prefix wins (gpt-6.1 over gpt-6)
        assert.equal(localCodexPerceivedWindow("gpt-6.1-sol"), 400_000);
        _setLocalCodexSourceForTest({ entries: [{ slug: "m-pct", contextWindow: 250_000 }] });
        // percent absent → 100%
        assert.equal(localCodexPerceivedWindow("m-pct"), 250_000);
    } finally {
        _resetLocalCodexSourceForTest();
    }
});

test("#2593 re-injection replaces the previous source; reset clears it", () => {
    try {
        _setLocalCodexSourceForTest({ entries: [{ slug: "m-a", contextWindow: 111_111 }] });
        assert.equal(localCodexPerceivedWindow("m-a"), 111_111);
        _setLocalCodexSourceForTest({ entries: [{ slug: "m-b", contextWindow: 222_222 }] });
        assert.equal(localCodexPerceivedWindow("m-b"), 222_222);
        assert.equal(localCodexPerceivedWindow("m-a"), undefined, "new injection replaces the old");
    } finally {
        _resetLocalCodexSourceForTest();
    }
});
