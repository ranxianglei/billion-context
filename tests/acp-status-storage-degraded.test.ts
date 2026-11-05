import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { handleAcpStatus } from "../src/acp-status.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

import { _resetStorageRuntimeStatusForTest, recordEngineBootstrap, recordSidecarOpenFailure } from "../src/storage/runtime-status.ts";
import { createCore, createInitialState, defaultConfig, type CompressionCore, type Config, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3385 (owner directive 3, acp_status surface): the STORAGE section of the
 * acp_status tool must surface the runtime degrade reason verbatim — on
 * Node < 22.5 with no engine it carries the explicit "upgrade Node.js"
 * lever (see nodeSqliteUpgradeHint in src/storage/engine-bootstrap.ts), so
 * the MODEL can relay the fix to the user instead of the fact living only
 * in lane logs the user never opens. Healthy storage stays quiet and an
 * intentional legacy opt-out is never nagged.
 *
 * The store is built for real (engines forced unavailable) so the recording
 * seams fire exactly as they do in production; _setStoreForTest then keeps
 * handleAcpStatus's ccrLoopConfig from rebuilding a healthy store mid-call
 * and clobbering the degraded state (that clobber is also why the store is
 * constructed BEFORE handleAcpStatus here).
 */

function makeCtx(): { core: CompressionCore; config: Config; messages: CoreMessage[]; session: Session } {
    const session = { id: "acp-status-3385", meta: {}, metadata: {}, stats: { requests: 0 }, state: createInitialState() } as unknown as Session;
    return { core: createCore(), config: defaultConfig(200000), messages: [], session };
}

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;

function isolate(base: string): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    const sessions = path.join(base, "sessions");
    mkdtempSync(sessions); // replace mkdirSync recursive — sessions parent exists
    process.env.BILI_SESSIONS_DIR = sessions;
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
    delete process.env.BILI_STORAGE_UNIFIED;
    delete process.env.BILI_ENCRYPTION_KEY;
    return snap;
}

function restore(snap: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

test("#3385: acp_status STORAGE section surfaces the degrade reason so the model can relay the lever", () => {
    const base = mkdtempSync(path.join(tmpdir(), "acp-status-3385-"));
    const snap = isolate(base);
    let store: SessionStore | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        recordEngineBootstrap({ status: "failed", detail: "The operation was aborted due to timeout" });
        // 2026-10-30: a no-engine OPEN refuses boot, so the acp_status surface
        // can only see a failed open post-boot via the runtime breaker; this
        // facet pins the SURFACE by driving the same recording seam shadow.ts
        // calls before its rethrow. A real (healthy) store keeps
        // ccrLoopConfig from rebuilding over the recorded state.
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        recordSidecarOpenFailure("no SQLite engine available");

        const out = handleAcpStatus({}, makeCtx());
        const text = out.text ?? "";
        assert.ok(text.includes("STORAGE —"), "the storage line is present");
        assert.ok(text.includes("⚠ degraded —"), `the degrade warning line is present (got: ${text.slice(-400)})`);
        assert.ok(text.includes("no SQLite engine available"), "the reason names the missing engine");
        assert.ok(text.includes("(relay this to the user)"), "the model is told to relay it");
        // The Node >= 22.5 lever is part of the reason string ONLY on Nodes
        // that lack the builtin (nodeSqliteUpgradeHint is empty on >= 22.5 —
        // pinned separately in tests/storage-engine-bootstrap.test.ts).
        if (Number(process.versions.node.split(".")[0]) < 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) < 5)) {
            assert.ok(/Node\.js >= 22\.5/.test(text), "this Node lacks the builtin — the reason must carry the upgrade lever");
        }
    } finally {
        store?.closeQuietly();
        _setStoreForTest(null as unknown as SessionStore);
        _resetStorageRuntimeStatusForTest();
        restore(snap);
        rmrf(base);
    }
});

test("#3385: healthy storage stays quiet — no degrade line", () => {
    // No engine forcing: on any runner the builtin/host/cached ladder serves
    // a real engine, the sidecar opens, and the STORAGE line must NOT be
    // followed by a degrade warning.
    const base = mkdtempSync(path.join(tmpdir(), "acp-status-3385-ok-"));
    const snap = isolate(base);
    let store: SessionStore | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        const out = handleAcpStatus({}, makeCtx());
        const text = out.text ?? "";
        assert.ok(text.includes("STORAGE —"), "the storage line is present");
        assert.ok(!text.includes("⚠ degraded"), `healthy storage shows no degrade warning (got: ${text.slice(-400)})`);
    } finally {
        store?.closeQuietly();
        _setStoreForTest(null as unknown as SessionStore);
        _resetStorageRuntimeStatusForTest();
        restore(snap);
        rmrf(base);
    }
});

test("#3894: an unsupported Node surfaces the artifact-table reason, not generic no-engine", () => {
    // Unsupported-node refuses the engine BEFORE any load, so the sidecar open
    // ALSO records a "no SQLite engine available" open-error. That reason must
    // outrank the generic one — otherwise the user sees "better-sqlite3 not
    // installed" when the real cause is the running Node (#3894 dead-code fix).
    const base = mkdtempSync(path.join(tmpdir(), "acp-status-3894-"));
    const snap = isolate(base);
    let store: SessionStore | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        recordEngineBootstrap({ status: "unsupported-node", detail: "no pinned SQLite engine runs on Node.js 21.7.3 (ABI 120)" });
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        recordSidecarOpenFailure("no self-downloaded SQLite engine supports this Node.js 21.7.3 (ABI 120)");

        const out = handleAcpStatus({}, makeCtx());
        const text = out.text ?? "";
        assert.ok(text.includes("STORAGE —"), "the storage line is present");
        assert.ok(text.includes("⚠ degraded —"), `the degrade warning line is present (got: ${text.slice(-400)})`);
        assert.ok(text.includes("no self-downloaded SQLite engine supports this Node.js"), `the specific reason surfaces (got: ${text.slice(-400)})`);
        assert.ok(/Node\.js 21\.7\.3/.test(text), "the reason carries the runtime the table could not serve");
    } finally {
        store?.closeQuietly();
        _setStoreForTest(null as unknown as SessionStore);
        _resetStorageRuntimeStatusForTest();
        restore(snap);
        rmrf(base);
    }
});

test("#4444: an unsupported Node surfaces the Node.js upgrade lever on the degrade reason", () => {
    // Node 21 has NO pinned band (neither builtin node:sqlite nor a prebuild), so
    // bootstrap is refused before any download -> unsupported-node. The degrade
    // reason must carry BOTH the specific coverage detail (the #3894 ordering) AND
    // the "upgrade Node.js" lever the sidecar-open branch carries — pre-#4444 the
    // unsupported-node branch outranked it and dropped the lever entirely. The
    // diagnosed runtime is forced to 21.6.1 so the lever is non-empty regardless
    // of the runner's own (builtin-bearing) Node version.
    const base = mkdtempSync(path.join(tmpdir(), "acp-status-4444-"));
    const snap = isolate(base);
    const origNodeDesc = Object.getOwnPropertyDescriptor(process.versions, "node");
    let store: SessionStore | null = null;
    try {
        _resetStorageRuntimeStatusForTest();
        recordEngineBootstrap({ status: "unsupported-node", detail: "no pinned SQLite engine runs on Node.js 21.6.1 (ABI 120)" });
        store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        _setStoreForTest(store);
        recordSidecarOpenFailure("no self-downloaded SQLite engine supports this Node.js 21.6.1 (ABI 120)");

        Object.defineProperty(process.versions, "node", { value: "21.6.1", configurable: true, writable: true });
        const text = handleAcpStatus({}, makeCtx()).text ?? "";
        assert.ok(text.includes("STORAGE —"), "the storage line is present");
        assert.ok(text.includes("⚠ degraded —"), `the degrade warning line is present (got: ${text.slice(-400)})`);
        assert.ok(text.includes("no self-downloaded SQLite engine supports this Node.js"), "the specific coverage detail surfaces");
        assert.ok(/Node\.js 21\.6\.1/.test(text), "the reason names the runtime the table could not serve");
        assert.ok(/Node\.js >= 22\.5/.test(text), `#4444: the unsupported-node reason must carry the Node.js upgrade lever (got: ${text.slice(-400)})`);
    } finally {
        if (origNodeDesc) Object.defineProperty(process.versions, "node", origNodeDesc);
        store?.closeQuietly();
        _setStoreForTest(null as unknown as SessionStore);
        _resetStorageRuntimeStatusForTest();
        restore(snap);
        rmrf(base);
    }
});
