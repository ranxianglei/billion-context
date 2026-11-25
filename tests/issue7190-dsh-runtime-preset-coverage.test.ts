import test from "node:test";
import assert from "node:assert/strict";
import {
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    compactionCoverageText,
    declareDshCompactionActive,
    disableRuntimePresetCompaction,
    dshCompactionGateTelemetry,
    installRuntimePresetCoverage,
    registerCompactionDisable,
} from "../src/agent/dsh-compaction-disable.ts";

// #7190: runtime-registered presets (a plugin calling ctx.agentPresets.register
// after boot) bypass every config layer — no loader row for the internal/config
// transform to reach. The register() wrap extends the SAME disable verdict to
// the birth point. Row-driven, both directions (#3617): rewrites when it should,
// leaves byte-identical when it should not.
// Source evidence (deepseek-harness @ 2e39e70, parity-verified vs rc.3):
// AgentPresetRegistry.register (packages/preset/agent-preset-registry/src/index.ts:96)
// EAGER-activates the definition through an in-memory PresetTree whose commit()
// is empty (mount.ts) — the nested rows never pass the loader's internal/config
// waterfall.

const BASIC = "@deepseek-ai/dsh-compaction-basic";
const COMPACT = "@deepseek-ai/dsh-command-compact";
const OTHER = "@deepseek-ai/dsh-llm-deepseek";

function presetDefinition(plugins: unknown[]): { id: string; name?: string; description?: string; order?: number; plugins: unknown[] } {
    return { id: "preset-runtime-x", name: "runtime x", description: "desc", order: 7, plugins };
}

test("#7190: active verdict — flat and group-nested compaction rows get disabled, siblings and metadata untouched", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const def = presetDefinition([
            { group: true, config: [{ name: BASIC }, { name: OTHER }] },
            { name: COMPACT },
            { name: "@deepseek-ai/dsh-llm-deepseek-account" },
        ]);
        const out = disableRuntimePresetCompaction(def) as typeof def;
        assert.equal((out.plugins[0] as { disabled?: boolean }).disabled, undefined);
        const inner = (out.plugins[0] as { config: Array<{ name?: string; disabled?: boolean }> }).config;
        assert.equal(inner[0].disabled, true);
        assert.equal(inner[1].disabled, undefined);
        assert.equal(inner[1].name, OTHER);
        assert.equal((out.plugins[1] as { disabled?: boolean }).disabled, true);
        assert.equal((out.plugins[2] as { disabled?: boolean }).disabled, undefined);
        assert.equal(out.id, "preset-runtime-x");
        assert.equal(out.name, "runtime x");
        assert.equal(out.description, "desc");
        assert.equal(out.order, 7);
        // pure: the input definition is never mutated
        assert.equal((def.plugins[0] as { config: Array<{ disabled?: boolean }> }).config[0].disabled, undefined);
        assert.equal((def.plugins[1] as { disabled?: boolean }).disabled, undefined);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: no compaction rows — the definition comes back BY IDENTITY (registry validation sees identical input)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const def = presetDefinition([{ name: OTHER }, { group: true, config: [{ name: OTHER }] }]);
        assert.equal(disableRuntimePresetCompaction(def), def);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: malformed definitions pass through by identity (null / non-object id / non-array plugins / number)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        assert.equal(disableRuntimePresetCompaction(null), null);
        assert.equal(disableRuntimePresetCompaction(42), 42);
        const noId = { plugins: [{ name: BASIC }] };
        assert.equal(disableRuntimePresetCompaction(noId), noId);
        const badId = { id: 5, plugins: [{ name: BASIC }] };
        assert.equal(disableRuntimePresetCompaction(badId), badId);
        const badPlugins = { id: "p", plugins: "nope" };
        assert.equal(disableRuntimePresetCompaction(badPlugins), badPlugins);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: verdict inactive — a definition WITH compaction rows passes through by identity (verdict is honored per call)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        // no declareDshCompactionActive(): bili-native never ran in this process
        const def = presetDefinition([{ name: BASIC }, { group: true, config: [{ name: COMPACT }] }]);
        assert.equal(disableRuntimePresetCompaction(def), def);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: install wraps register() and is idempotent — no double-wrap on re-apply", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const seen: unknown[] = [];
        const registry = {
            register: async (definition: unknown) => {
                seen.push(definition);
                return async () => {};
            },
        };
        installRuntimePresetCoverage({ agentPresets: registry });
        installRuntimePresetCoverage({ agentPresets: registry });
        assert.equal(registry.register.length, 1, "register was replaced exactly once");

        const withCompaction = presetDefinition([{ name: BASIC }]);
        const withoutCompaction = presetDefinition([{ name: OTHER }]);
        void registry.register?.(withCompaction);
        void registry.register?.(withoutCompaction);
        assert.equal(((seen[0] as typeof withCompaction).plugins[0] as { disabled?: boolean }).disabled, true);
        assert.equal(seen[1], withoutCompaction, "the untouched definition keeps its identity");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: the wrap forwards to the original register with the registry as `this`", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        let originalThis: unknown = "unset";
        let captured: unknown;
        const def = presetDefinition([{ name: OTHER }]);
        const registry = {
            register: function (this: unknown, definition: unknown) {
                originalThis = this;
                captured = definition;
                return Promise.resolve(async () => {});
            },
        };
        installRuntimePresetCoverage({ agentPresets: registry });
        const promise = registry.register?.(def);
        assert.ok(promise instanceof Promise);
        assert.equal(originalThis, registry, "the original sees the registry as its this");
        assert.equal(captured, def, "an untouched definition reaches the original by identity");
        void promise;
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: no registry / no register — install is a silent no-op (a host without the registry cannot runtime-register presets)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        installRuntimePresetCoverage({});
        installRuntimePresetCoverage({ agentPresets: { list: () => [] } });
        assert.equal(dshCompactionGateTelemetry()?.runtimeWrapped, undefined);
        assert.equal(compactionCoverageText(), "no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later)");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: ctx.get fallback — the registry is found by service name; a host without the service degrades silently", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const registry = { register: async (d: unknown) => d };
        installRuntimePresetCoverage({ get: (name) => (name === "agentPresets" ? registry : undefined) });
        assert.equal(dshCompactionGateTelemetry()?.runtimeWrapped, true);

        _resetDshCompactionGateTelemetryForTest();
        installRuntimePresetCoverage({ get: () => undefined });
        assert.equal(dshCompactionGateTelemetry()?.runtimeWrapped, undefined, "no service → nothing to wrap, no claim");

        _resetDshCompactionGateTelemetryForTest();
        installRuntimePresetCoverage({ get: () => null });
        assert.equal(dshCompactionGateTelemetry()?.runtimeWrapped, undefined);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: registerCompactionDisable installs the wrap alongside the load-time middleware", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const registry = { register: async (d: unknown) => d };
        let middlewareSeen = false;
        registerCompactionDisable({
            on: (event, _listener, _options) => { if (event === "internal/config") middlewareSeen = true; },
            reflect: { provide: () => {} },
            agentPresets: registry,
        });
        assert.equal(middlewareSeen, true);
        assert.equal(dshCompactionGateTelemetry()?.runtimeWrapped, true);
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});

test("#7190: telemetry — runtime entries dedup on max rows; the coverage text states the wrap state, not a false gap", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        // rewrite twice under one id with different row counts (max wins), and a second id
        disableRuntimePresetCompaction(presetDefinition([{ name: BASIC }]));
        const bigger = { id: "preset-runtime-x", plugins: [{ name: BASIC }, { group: true, config: [{ name: COMPACT }] }] };
        disableRuntimePresetCompaction(bigger);
        disableRuntimePresetCompaction({ id: "preset-runtime-y", plugins: [{ name: COMPACT }] });
        const telemetry = dshCompactionGateTelemetry();
        assert.equal(telemetry?.runtimeWrapped, undefined, "the pure function does not claim the wrap itself");
        assert.deepEqual(telemetry?.runtime, [
            { entry: "preset-runtime-x", rows: 2 },
            { entry: "preset-runtime-y", rows: 1 },
        ]);

        const registry = { register: async (d: unknown) => d };
        installRuntimePresetCoverage({ agentPresets: registry });
        assert.equal(compactionCoverageText(), "no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later); 2 runtime preset registrations rewritten (preset-runtime-x\u00d72, preset-runtime-y\u00d71)");

        _resetDshCompactionGateTelemetryForTest();
        installRuntimePresetCoverage({ agentPresets: { register: async (d: unknown) => d } });
        assert.equal(
            compactionCoverageText(),
            "no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later); register() covered \u2014 no runtime preset registrations so far",
        );

        // singular form — fresh registry so the wrap mark does not carry over
        _resetDshCompactionGateTelemetryForTest();
        disableRuntimePresetCompaction(presetDefinition([{ name: BASIC }]));
        installRuntimePresetCoverage({ agentPresets: { register: async (d: unknown) => d } });
        assert.equal(
            compactionCoverageText(),
            "no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later); 1 runtime preset registration rewritten (preset-runtime-x\u00d71)",
        );
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});
