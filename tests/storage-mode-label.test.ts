import assert from "node:assert";
import test from "node:test";

import { createInitialState } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import { storageStatusLabel } from "../src/persist.ts";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved = new Map<string, string | undefined>();
    for (const k of Object.keys(env)) saved.set(k, process.env[k]);
    try {
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        fn();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** Pins the config-file tier OFF (missing file → empty config) so the label
 *  matrix below tests the ENV tier alone — otherwise a developer machine
 *  with `storage.unified` in its billion-context.json leaks "full" into the
 *  legacy expectation and the suite goes red for no code reason. */
const HERMETIC_CONFIG = `/tmp/bili-mode-label-hermetic-${process.pid}.json`;

function withHermeticConfig(fn: () => void): void {
    withEnv({ BILI_CONFIG_FILE: HERMETIC_CONFIG }, fn);
}

test("storage mode label: env matrix matches the store's effective resolution", () => {
    withHermeticConfig(() => {
    withEnv({ BILI_STORAGE_UNIFIED: undefined, BILI_ENCRYPTION_KEY: undefined }, () => {
        // absent everywhere now resolves to the FULL default (#3818 flip of
        // the #2815 rollout) — the label must say so; explicit shadow stays
        // reachable in the rows below
        assert.equal(storageStatusLabel(), "storage: full (unified-first reads, dual-write)");
    });
    for (const v of ["1", "true", "shadow"]) {
        withEnv({ BILI_STORAGE_UNIFIED: v, BILI_ENCRYPTION_KEY: undefined }, () => {
            assert.equal(storageStatusLabel(), "storage: shadow (dual-write dry-run → index.db)", `BILI_STORAGE_UNIFIED=${v}`);
        });
    }
    withEnv({ BILI_STORAGE_UNIFIED: "full", BILI_ENCRYPTION_KEY: undefined }, () => {
        assert.equal(storageStatusLabel(), "storage: full (unified-first reads, dual-write)");
    });
    for (const v of ["full", "unified"]) {
        withEnv({ BILI_STORAGE_UNIFIED: v, BILI_ENCRYPTION_KEY: undefined }, () => {
            assert.equal(storageStatusLabel(), "storage: full (unified-first reads, dual-write)", `BILI_STORAGE_UNIFIED=${v}`);
        });
    }
    // encryption is a hard opt-out: the label must show the downgrade, never
    // claim the mode the sidecar refused to open in
    withEnv({ BILI_STORAGE_UNIFIED: "full", BILI_ENCRYPTION_KEY: "00".repeat(32) }, () => {
        assert.equal(storageStatusLabel(), "storage: full requested — blocked by BILI_ENCRYPTION_KEY, running legacy-only");
    });
    });
});

test("status panel: storage line renders under the version line", () => {
    const panel = buildStatusPanel({
        version: "billion-context@0.1.191 (deadbeef) · pack: default",
        storage: "storage: full (unified-first reads, dual-write)",
        tokenCount: 1234,
        systemPromptTokens: 0,
        nudge: undefined,
        modelContextLimit: 1_000_000,
        state: createInitialState(),
    });
    const lines = panel.split("\n");
    const vIdx = lines.findIndex((l) => l.includes("billion-context@0.1.191"));
    const sIdx = lines.findIndex((l) => l.includes("storage: full"));
    assert.ok(vIdx >= 0, "version line present");
    assert.ok(sIdx === vIdx + 1, "storage line directly under version");
    // omitted field hides the line entirely
    const bare = buildStatusPanel({ tokenCount: 1234, systemPromptTokens: 0, nudge: undefined, modelContextLimit: 1_000_000, state: createInitialState() });
    assert.ok(!bare.includes("storage:"), "no storage line when input omitted");
});
