// #7111: the four Web presets used to be gated on the gate service through an
// entry-level inject. cordis has no optional dependency, no timeout and no
// fallback, so ANY missing gate service left all four presets pending forever
// (agent-presets/not-found on session create) while the host kept booting and
// serving its UI. The gate is now fail-open: the always-on entry reconciles the
// presets that were already mounted instead of letting them wait on it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gate from "../src/agent/dsh-compaction-gate.ts";
import {
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    declareDshCompactionActive,
    reconcileLoadedPresets,
    type CompactionDisableHost,
} from "../src/agent/dsh-compaction-disable.ts";
import { writeDshAcpPatch } from "../src/launcher.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE_SERVICE = "biliBasicCompactionPolicy";

function presetEntry() {
    const updates: Array<{ plugins: Array<{ config?: Array<{ name?: string; disabled?: boolean }> }> }> = [];
    return {
        updates,
        entry: {
            options: {
                id: "preset-standard",
                name: "@deepseek-ai/dsh-agent-preset",
                config: {
                    id: "standard",
                    plugins: [
                        {
                            id: "compaction",
                            group: true,
                            config: [{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" }],
                        },
                    ],
                },
            },
            update: (options: { config: unknown }) => { updates.push(options.config as never) },
        },
    };
}

test("#7111: neither carrier gates the presets on the gate service any more", () => {
    const bundle = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
    assert.ok(!bundle.includes(`inject: [${GATE_SERVICE}]`), "bundle yml must not gate the presets");
    assert.ok(bundle.includes("- id: bili-compaction-gate"), "the always-on gate entry must stay mounted");

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7111-"));
    try {
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "overlay must be written");
        const overlay = fs.readFileSync(file!, "utf8").replaceAll("\r\n", "\n");
        assert.ok(!overlay.includes(`inject: [${GATE_SERVICE}]`), "launcher overlay must not gate the presets");
        assert.ok(overlay.includes("- id: bili-compaction-gate"), "the overlay must still mount the gate entry");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});

test("#7111: a preset that was already mounted is re-submitted with its compaction row disabled", () => {
    _resetDshCompactionVerdictForTest();
    declareDshCompactionActive();
    try {
        const { entry, updates } = presetEntry();
        assert.equal(reconcileLoadedPresets([entry]), 1);
        assert.equal(updates.length, 1);
        const row = updates[0]!.plugins[0]!.config![0]!;
        assert.equal(row.disabled, true, "the nested compaction row must be stood down");
        const inputRow = entry.options.config.plugins[0]!.config![0] as { disabled?: boolean };
        assert.equal(inputRow.disabled, undefined, "input stays untouched");
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#7111: entries without a nested compaction row, without update, or non-objects are left alone", () => {
    const plain = { options: { id: "llm-deepseek", config: { retryPolicy: {} } }, update: () => { throw new Error("must not run") } };
    const frozen = { options: { config: { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] } } };
    assert.equal(reconcileLoadedPresets([plain, frozen, null, undefined, 42]), 0);
});

test("#7111: the gate entry reconciles through the optional loader and still provides the service", () => {
    _resetDshCompactionVerdictForTest();
    _resetDshCompactionGateTelemetryForTest();
    declareDshCompactionActive();
    try {
        const { entry, updates } = presetEntry();
        const provided: string[] = [];
        let scan: ((inner: { loader?: { entries?: () => Iterable<unknown> } }) => void) | undefined;
        gate.apply({
            on: () => {},
            reflect: { provide: (name: string) => { provided.push(name) } },
            inject: (_deps: string[], callback: (inner: { loader?: { entries?: () => Iterable<unknown> } }) => void) => {
                scan = callback;
            },
        } as unknown as CompactionDisableHost);

        assert.deepEqual(provided, [GATE_SERVICE], "the service is published without waiting for the loader");
        scan?.({ loader: { entries: () => [entry] } });
        assert.equal(updates.length, 1, "an already-mounted preset must be reconciled");
        scan?.({ loader: undefined });
        assert.equal(updates.length, 1, "a missing loader must not throw or reconcile again");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});
