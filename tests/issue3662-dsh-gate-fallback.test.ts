// #3662: disabling or kill-switching bili-native used to remove the ONLY
// provider of biliBasicCompactionPolicy while the bundle patch kept gating all
// four web-profile presets on it — dsh then booted with every preset pending
// forever and session creation bricked (new + resume + preset list). The gate
// now lives in its own always-on entry; these tests pin both trigger paths
// (entry disabled / env kill-switch ⇒ absent verdict) and that the fallback is
// STOCK dsh compaction, not a third state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BILI_COMPACTION_DISABLE_SERVICE, declareDshCompactionActive, isDshCompactionActive, _resetDshCompactionVerdictForTest } from "../src/agent/dsh-compaction-disable.ts";
import * as gate from "../src/agent/dsh-compaction-gate.ts";
import { writeDshAcpPatch } from "../src/launcher.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE_INSERT = `- insert:\n    - id: bili-native\n      name: billion-context\n    - id: bili-compaction-gate\n      name: billion-context/dsh-compaction-gate\n`;

type GateHost = {
    on?: (event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
};
function mockGateHost() {
    const order: string[] = [];
    const provided: Array<{ name: string; value: unknown }> = [];
    let onOptions: { global?: boolean } | undefined;
    let mw: ((raw: unknown, next: () => unknown) => unknown) | undefined;
    const host: GateHost = {
        on: (event, listener, options) => {
            order.push(`on:${event}`);
            if (event === "internal/config") {
                onOptions = options;
                mw = listener;
            }
        },
        reflect: { provide: (name, value) => { order.push(`provide:${name}`); provided.push({ name, value }); } },
    };
    return {
        host,
        order,
        provided,
        middleware: () => mw,
        globalFlag: () => onOptions?.global === true,
    };
}
const PRESET_SELF = { entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } };
function presetPlugins(): Array<Record<string, unknown>> {
    return [
        { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
        { name: "@deepseek-ai/dsh-command-compact" },
        { name: "@deepseek-ai/dsh-other" },
    ];
}

test("#3662: the gate entry exposes its own minimal surface", () => {
    assert.equal(gate.name, "bili-compaction-gate");
    // no inject of its own: it must activate whenever the patch layer mounts it,
    // independently of bili-native's state
    assert.deepEqual(gate.inject, []);
    assert.equal(typeof gate.apply, "function");
});

test("#3662: verdict channel semantics (absent ⇒ stock)", () => {
    try {
        _resetDshCompactionVerdictForTest();
        assert.equal(isDshCompactionActive(), false, "absent declaration means bili-native never ran");
        declareDshCompactionActive();
        assert.equal(isDshCompactionActive(), true);
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#3662: bili-native absent (disabled / kill-switched) — service still provided, presets boot STOCK", () => {
    try {
        _resetDshCompactionVerdictForTest();
        assert.ok(!isDshCompactionActive());
        const m = mockGateHost();
        gate.apply(m.host);
        // the latch stays satisfiable even though bili-native never ran
        assert.deepEqual(m.provided.map((p) => p.name), [BILI_COMPACTION_DISABLE_SERVICE]);
        // transform registered BEFORE the service publishes (the #3354 ordering guarantee survives the split)
        const iOn = m.order.indexOf("on:internal/config");
        const iProvide = m.order.indexOf(`provide:${BILI_COMPACTION_DISABLE_SERVICE}`);
        assert.ok(iOn >= 0, "internal/config middleware must be registered");
        assert.ok(iProvide > iOn, "gate service must publish after the middleware registers");
        assert.ok(m.globalFlag(), "middleware must be global");
        // and without a verdict it leaves every row stock — this is what keeps
        // the four presets resolvable instead of pending forever
        const raw = m.middleware();
        assert.equal(typeof raw, "function");
        const mw = raw as (raw: unknown, next: () => unknown) => unknown;
        const plugins = presetPlugins();
        const cfg: Record<string, unknown> = { plugins, x: 1 };
        const out = mw.call(PRESET_SELF, null, () => cfg) as Record<string, unknown>;
        assert.equal(out, cfg, "absent verdict must pass the resolved config through verbatim");
        for (const row of plugins) assert.equal(row.disabled, undefined);
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#3662: normal boot (verdict active) — the gate entry disables the compaction rows", () => {
    try {
        _resetDshCompactionVerdictForTest();
        declareDshCompactionActive();
        const m = mockGateHost();
        gate.apply(m.host);
        assert.deepEqual(m.provided.map((p) => p.name), [BILI_COMPACTION_DISABLE_SERVICE]);
        const raw = m.middleware();
        assert.equal(typeof raw, "function");
        const mw = raw as (raw: unknown, next: () => unknown) => unknown;
        const plugins = presetPlugins();
        const cfg: Record<string, unknown> = { plugins, x: 1 };
        const out = mw.call(PRESET_SELF, null, () => cfg) as { plugins?: Array<Record<string, unknown>>; x?: number };
        assert.equal(out.x, 1);
        assert.deepEqual(out.plugins?.[0]?.config, { auto: true });
        assert.equal(out.plugins?.[0]?.disabled, true);
        assert.equal(out.plugins?.[1]?.disabled, true);
        assert.equal(out.plugins?.[2]?.disabled, undefined);
        // #4147: non-agent-preset entries pass through verbatim ONLY when
        // they nest no compaction rows — a custom preset nesting them is
        // rewritten (structural match), unrelated config keeps identity.
        const otherCfg: Record<string, unknown> = { plugins: [{ name: "@deepseek-ai/dsh-other" }] };
        assert.equal(mw.call({ entry: { options: { name: "something-else" } } }, null, () => otherCfg), otherCfg);
        const customCfg: Record<string, unknown> = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        const customOut = mw.call({ entry: { options: { name: "preset-general" } } }, null, () => customCfg) as { plugins?: Array<Record<string, unknown>> };
        assert.equal(customOut.plugins?.[0]?.disabled, true);
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#3662: both patch carriers mount the gate entry alongside bili-native", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3662-carrier-"));
    try {
        const bundle = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
        assert.ok(bundle.includes(GATE_INSERT), "bundle patch must insert the always-on gate entry after bili-native");
        for (const id of ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]) {
            assert.ok(bundle.includes(`- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`));
        }
        // launcher overlay, bare lane (shim resolves the subpath export)
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "writeDshAcpPatch must produce the overlay file");
        const overlay = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
        assert.ok(overlay.includes(GATE_INSERT));
        // launcher overlay, URL lane (no shim): the gate rides the same dist root
        const file2 = writeDshAcpPatch(home, "file:///does/not/matter/agent/dsh-native.js");
        assert.ok(file2);
        const overlay2 = fs.readFileSync(file2, "utf8").replaceAll("\r\n", "\n");
        assert.match(overlay2, /^ {4}- id: bili-compaction-gate\n {6}name: file:\/\/.+dsh-compaction-gate\.js$/m);
        assert.ok(overlay2.includes(`- id: preset-standard\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`));
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});
