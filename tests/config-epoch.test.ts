import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, createInitialState, type Config } from "acp-kernel";
import { effectiveConfig, storeEffectiveConfig, type Session } from "../src/session.js";
import { externalSummaryEnabled } from "../src/external-summary-surface.js";

// #3430: the effectiveConfig stamp is only valid while the config SOURCE it was
// resolved from is still the live one. These tests pin the stale-stamp guard:
// same source → stamp wins (unchanged merge semantics); edited file / foreign
// lane → the stamp is refused and the live file tier is re-resolved onto the
// fallback, so a retired setting (the October externalSummary incident: a
// user-disabled summary chain kept executing off one old stamp) can never ride
// a stale snapshot again.

function makeSession(): Session {
    return { id: "cfg-epoch-s1", metadata: {}, stats: {}, state: createInitialState() } as unknown as Session;
}

function pinnedConfigFile(dir: string): string {
    return path.join(dir, "billion-context.json");
}

test("config epoch: same-source stamp still wins (merge semantics unchanged)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-epoch-same-"));
    const file = pinnedConfigFile(dir);
    writeFileSync(file, JSON.stringify({ compress: { modelContextLimit: 200_000 } }));
    process.env.BILI_CONFIG_FILE = file;
    try {
        const session = makeSession();
        const stamped = defaultConfig(200_000);
        stamped.modelContextLimit = 123_456; // a request-cascade override worth keeping
        storeEffectiveConfig(session, stamped);
        const read = effectiveConfig(session, defaultConfig(200_000));
        assert.equal(read.modelContextLimit, 123_456, "live stamp must win over the fallback");
    } finally {
        delete process.env.BILI_CONFIG_FILE;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("config epoch: edited file refuses the stamp and re-resolves the live compress tier", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-epoch-edit-"));
    const file = pinnedConfigFile(dir);
    writeFileSync(file, JSON.stringify({ compress: { modelContextLimit: 200_000 } }));
    process.env.BILI_CONFIG_FILE = file;
    try {
        const session = makeSession();
        const stamped = defaultConfig(200_000);
        stamped.modelContextLimit = 123_456;
        storeEffectiveConfig(session, stamped);
        // The user edits the file AFTER the stamp: new window, new knob.
        writeFileSync(file, JSON.stringify({ compress: { modelContextLimit: 777_000, nudgeGrowthTokens: 512 } }));
        const read = effectiveConfig(session, defaultConfig(200_000));
        assert.notEqual(read.modelContextLimit, 123_456, "a stamp from a replaced source must not win");
        assert.equal(read.modelContextLimit, 777_000, "the live file's compress tier is re-resolved onto the fallback");
    } finally {
        delete process.env.BILI_CONFIG_FILE;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("config epoch: a retired externalSummary chain cannot ride a stale stamp (the October incident)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-epoch-ext-"));
    const file = pinnedConfigFile(dir);
    writeFileSync(file, JSON.stringify({ compress: { externalSummary: { enabled: true, targets: [{ baseUrl: "https://sum.example", apiKeyEnv: "env:NOPE", model: "m" }] } } }));
    process.env.BILI_CONFIG_FILE = file;
    try {
        const session = makeSession();
        const stamped = defaultConfig(200_000) as Config & { externalSummary?: { enabled: boolean } };
        stamped.externalSummary = { enabled: true };
        storeEffectiveConfig(session, stamped);
        assert.equal(externalSummaryEnabled(effectiveConfig(session, defaultConfig(200_000))), true, "precondition: chain on while the file still declares it");
        // The user deletes the chain from the file, but the session never sees
        // another wire request on this instance.
        writeFileSync(file, JSON.stringify({ compress: {} }));
        const read = effectiveConfig(session, defaultConfig(200_000));
        assert.equal(externalSummaryEnabled(read), false, "stale stamp refused — the deleted chain stays deleted");
    } finally {
        delete process.env.BILI_CONFIG_FILE;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("config epoch: byte-identical files at different paths are the same source (cross-lane stamps validate)", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "bili-epoch-laneA-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "bili-epoch-laneB-"));
    const fileA = pinnedConfigFile(dirA);
    const fileB = pinnedConfigFile(dirB);
    const content = JSON.stringify({ compress: { modelContextLimit: 200_000 } });
    writeFileSync(fileA, content);
    writeFileSync(fileB, content); // byte-identical, DIFFERENT path
    process.env.BILI_CONFIG_FILE = fileA;
    try {
        const session = makeSession();
        const stamped = defaultConfig(200_000);
        stamped.modelContextLimit = 123_456;
        storeEffectiveConfig(session, stamped);
        // A second instance resolving the SAME bytes under a different lane
        // path: identical file tier → the stamp is still a valid resolution.
        process.env.BILI_CONFIG_FILE = fileB;
        const read = effectiveConfig(session, defaultConfig(200_000));
        assert.equal(read.modelContextLimit, 123_456, "content identity, not path identity — same bytes validate");
        // But once either file diverges, the stamp goes stale.
        writeFileSync(fileB, JSON.stringify({ compress: { modelContextLimit: 200_001 } }));
        assert.notEqual(effectiveConfig(session, defaultConfig(200_000)).modelContextLimit, 123_456, "diverged content refuses the stamp");
    } finally {
        delete process.env.BILI_CONFIG_FILE;
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
    }
});

test("config epoch: stamps without an epoch keep the legacy behavior (stamp wins)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-epoch-legacy-"));
    const file = pinnedConfigFile(dir);
    writeFileSync(file, JSON.stringify({ compress: { modelContextLimit: 200_000 } }));
    process.env.BILI_CONFIG_FILE = file;
    try {
        const session = makeSession();
        const legacy = defaultConfig(200_000);
        legacy.modelContextLimit = 123_456;
        // Pre-#3430 sessions persisted a snapshot with no epoch next to it.
        session.metadata["effectiveConfig"] = { ...legacy } as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ compress: { modelContextLimit: 777_000 } }));
        const read = effectiveConfig(session, defaultConfig(200_000));
        assert.equal(read.modelContextLimit, 123_456, "legacy stamps (no epoch) keep the documented merge semantics");
    } finally {
        delete process.env.BILI_CONFIG_FILE;
        rmSync(dir, { recursive: true, force: true });
    }
});
