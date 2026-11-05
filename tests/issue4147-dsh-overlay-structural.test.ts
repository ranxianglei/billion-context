import test from "node:test";
import assert from "node:assert/strict";
import {
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    declareDshCompactionActive,
    dshCompactionGateTelemetry,
    registerCompactionDisable,
} from "../src/agent/dsh-compaction-disable.ts";

// #4147: the #3354 load-time overlay matches STRUCTURALLY — any entry whose
// resolved config.plugins nests compaction-basic/command-compact rows gets
// them disabled, custom presets included; the pre-#4147 entry-name filter
// left exactly those armed and a landed dsh checkpoint destroyed the
// compression substrate. #3962: every rewrite is recorded on the shared
// globalThis telemetry channel so the durable boot note can state actual
// coverage (patch-row misses are otherwise loader-log-only).

type Mw = (raw: unknown, next: () => unknown) => unknown;

function middleware(): Mw {
    let mw: Mw | undefined;
    registerCompactionDisable({
        on: (_event, listener) => { mw = listener as Mw; },
        reflect: {},
    });
    assert.equal(typeof mw, "function");
    return mw as Mw;
}

test("#4147: custom preset entries nesting compaction rows are rewritten (group recursion included)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const mw = middleware();
        // the #4147 reporter's shape: a profile-local preset entry, NOT the
        // factory agent-preset package, nesting its own compaction rows
        const cfg = {
            plugins: [
                { name: "@deepseek-ai/dsh-other" },
                { group: true, config: [{ name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } }] },
                { name: "@deepseek-ai/dsh-command-compact" },
            ],
        };
        const out = mw.call({ entry: { options: { name: "preset-general" } } }, null, () => cfg) as { plugins: Array<Record<string, unknown>> };
        assert.equal(out.plugins[0].disabled, undefined, "unrelated sibling row untouched");
        const group = out.plugins[1] as { config: Array<Record<string, unknown>> };
        assert.equal(group.config[0].disabled, true, "nested group row disabled");
        assert.deepEqual(group.config[0].config, { auto: true }, "row config preserved verbatim");
        assert.equal(out.plugins[2].disabled, true, "top-level command-compact row disabled");
        const t = dshCompactionGateTelemetry();
        assert.ok(t, "telemetry recorded");
        assert.deepEqual(t!.covered, [{ entry: "preset-general", rows: 2 }]);
        assert.equal(t!.sawFactoryPreset, false, "a custom preset is not the factory entry");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#4147 negative: no compaction rows → resolved config object identity kept, no telemetry entry", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const mw = middleware();
        const unrelated = { plugins: [{ name: "@deepseek-ai/dsh-tool-result-pruner" }] };
        assert.equal(mw.call({ entry: { options: { name: "preset-shipin" } } }, null, () => unrelated), unrelated);
        const noPlugins = { other: 1 };
        assert.equal(mw.call({ entry: { options: { name: "preset-shipin" } } }, null, () => noPlugins), noPlugins);
        assert.equal(dshCompactionGateTelemetry(), null, "no rewrite, no coverage record");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#4147/#3662 negative: absent verdict → stock passthrough records nothing", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        const mw = middleware();
        const cfg = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        const out = mw.call({ entry: { options: { name: "preset-general" } } }, null, () => cfg) as { plugins: Array<Record<string, unknown>> };
        assert.equal(out, cfg, "verbatim passthrough");
        assert.equal((cfg.plugins as Array<Record<string, unknown>>)[0].disabled, undefined);
        assert.equal(dshCompactionGateTelemetry(), null, "stock passthrough leaves no coverage record");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#3962: telemetry dedups per entry, keeps the max row count, flags the factory preset, survives reset", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const mw = middleware();
        const one = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        mw.call({ entry: { options: { name: "preset-general" } } }, null, () => one);
        const two = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }, { name: "@deepseek-ai/dsh-command-compact" }] };
        mw.call({ entry: { options: { name: "preset-general" } } }, null, () => two);
        const factory = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        mw.call({ entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } }, null, () => factory);
        const unnamed = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        mw.call(undefined, null, () => unnamed);
        const t = dshCompactionGateTelemetry()!;
        assert.deepEqual(t.covered.find((c) => c.entry === "preset-general"), { entry: "preset-general", rows: 2 }, "dedup keeps the max count");
        assert.equal(t.covered.some((c) => c.entry === "unnamed-entry"), true, "missing entry name still recorded");
        assert.equal(t.sawFactoryPreset, true);
        _resetDshCompactionGateTelemetryForTest();
        assert.equal(dshCompactionGateTelemetry(), null);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#3962: long entry names (URLs) are truncated for the durable note", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const mw = middleware();
        const longName = "file:///".padEnd(200, "x");
        const cfg = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        mw.call({ entry: { options: { name: longName } } }, null, () => cfg);
        const t = dshCompactionGateTelemetry()!;
        assert.equal(t.covered[0].entry.length, 120);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});
