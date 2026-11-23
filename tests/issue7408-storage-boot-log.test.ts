/**
 * #7408 §3b — the full-mode storage boot line must state the ACTUAL
 * selection and writer state. The pre-#6480 wording ("legacy files keep
 * being written — unset the knob to roll back") survived the pure-sqlite
 * default flip: under the default (no knob set, envelopes NOT written) it
 * claimed a knob that was never set, a dual-write that does not happen, and
 * a rollback that does not exist — contradicting the accurate jsonWriter-off
 * line persist.ts prints in the same boot and steering field diagnosis into
 * chasing a non-existent dual-write. Pinned for every reachable posture:
 * default pure-sqlite, explicit full, and the two explicit jsonWriter
 * overrides (env tier + file tier through the new fileJsonWriter parameter).
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { setLogCapture } from "../src/logger.ts";
import { _resetStorageRuntimeStatusForTest } from "../src/storage/runtime-status.ts";

let root: string;
let engineAvailable = true;

function freshDir(prefix: string): string {
    return mkdtempSync(path.join(root, prefix));
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

before(() => {
    root = mkdtempSync(path.join(tmpdir(), "bili-7408-"));
    const probe = freshDir("probe-");
    try {
        const s = UnifiedStore.open(path.join(probe, "index.db"));
        s.close();
    } catch {
        engineAvailable = false;
    }
});

after(() => {
    rmSync(root, { recursive: true, force: true });
    setLogCapture(null);
});

/** Open the sidecar under the given knob posture and return the exact
 *  full-mode boot line (both state homes kept out of the way so no test
 *  instance touches a real state dir). */
function bootLine(env: NodeJS.ProcessEnv, fileUnified?: string, fileJsonWriter?: string): string {
    const state = freshDir("state-");
    const sessions = freshDir("sessions-");
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        withEnv({ XDG_STATE_HOME: state }, () => {
            const shadow = UnifiedShadow.maybeOpen(sessions, env, (r) => r as LegacySessionLike, fileUnified, undefined, undefined, fileJsonWriter);
            assert.ok(shadow, "sidecar must open");
            shadow.close();
        });
        const line = logs.find((m) => m.includes("unified FULL mode ENABLED"));
        assert.ok(line, `FULL-mode boot line expected, got: ${logs.join(" | ")}`);
        return line;
    } finally {
        setLogCapture(null);
    }
}

test("#7408 §3b: default (pure-sqlite) — the boot line says index.db is the only persistent copy and envelopes are NOT written", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const line = bootLine({});
    assert.ok(line.includes("pure-sqlite selection (storage.unified absent or =sqlite)"), line);
    assert.ok(line.includes("index.db is the load path AND the only persistent copy — JSON envelopes are not written; restore dual-write with storage.jsonWriter=on"), line);
    assert.ok(!line.includes("legacy files keep being written"), "the pre-#6480 dual-write claim must be gone under the default");
    assert.ok(!line.includes("unset the knob"), "no knob is set under the default — the rollback hint must not claim otherwise");
});

test("#7408 §3b: explicit full — the historical dual-write wording stays (knob set, envelopes written)", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const line = bootLine({ BILI_STORAGE_UNIFIED: "full" });
    assert.ok(line.includes("storage.unified=full or BILI_STORAGE_UNIFIED=full"), line);
    assert.ok(line.includes("legacy files keep being written — unset the knob to roll back"), line);
});

test("#7408 §3b: pure-sqlite + explicit jsonWriter=on (env) — envelopes ARE written; the line names the explicit on, not a unified knob", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const line = bootLine({ BILI_STORAGE_JSON_WRITER: "on" });
    assert.ok(line.includes("pure-sqlite selection (storage.unified absent or =sqlite)"), line);
    assert.ok(line.includes("legacy files keep being written — remove the explicit storage.jsonWriter=on to return to the pure-sqlite default"), line);
});

test("#7408 §3b: explicit full + explicit jsonWriter=off — the writer-off wording wins over the selection wording", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const line = bootLine({ BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "off" });
    assert.ok(line.includes("storage.unified=full or BILI_STORAGE_UNIFIED=full"), line);
    assert.ok(line.includes("JSON envelopes are not written"), line);
    assert.ok(!line.includes("legacy files keep being written"), line);
});

test("#7408 §3b: file tier — storage.unified=sqlite + storage.jsonWriter=on reaches the line through the fileJsonWriter parameter (the persist.ts plumbing)", () => {
    if (!engineAvailable) return;
    _resetStorageRuntimeStatusForTest();
    const line = bootLine({}, "sqlite", "on");
    assert.ok(line.includes("pure-sqlite selection (storage.unified absent or =sqlite)"), line);
    assert.ok(line.includes("legacy files keep being written — remove the explicit storage.jsonWriter=on to return to the pure-sqlite default"), line);
});
