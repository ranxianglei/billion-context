import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAdminRoute, isManagementPath } from "../src/server/admin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

/**
 * #3633: checkpoint API naming + multi-instance posture surface.
 *
 * /__bili/checkpoints is the canonical prefix; /__bili/replicas stays routable
 * as a deprecated alias ("replica" always meant a frozen session copy, never a
 * pod peer). This suite pins the HTTP contract both prefixes must hold:
 * routing on both, response keys following the prefix used (byte-compat for
 * pre-existing scripts), unified-store gating (501 in legacy mode), and the
 * additive /__bili/status fields instanceId + sessionsOnDisk that let an LB
 * tell "session lives here" from "session moved".
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity (same pin discipline as tests/storage-replicas.test.ts): control
// every storage tier explicitly; the baseline is legacy so each leg opts in.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-3633-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
const SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3633-sessions-"));
process.env.BILI_SESSIONS_DIR = SESSIONS_DIR;

type AdminCtxForTest = Parameters<typeof handleAdminRoute>[2];

function makeCtx(): AdminCtxForTest {
    return {
        opts: { host: "127.0.0.1" },
        core: {},
        config: {},
        log: (): void => {},
        instanceId: "test-instance",
        instanceStartedAt: Date.now(),
        proxyWatchers: new Set<number>(),
        initialWatcherPid: null,
        bootReady: (): boolean => true,
        requestShutdown: (): void => {},
    } as unknown as AdminCtxForTest;
}

function mkReq(method: string, url: string, opts: { remoteAddress?: string; body?: string } = {}): http.IncomingMessage {
    // the trusted-origin gate verifies Host against the admin's trusted
    // hostnames, so bare loopback requests must carry it
    const readable = new Readable({ read(): void {} });
    if (opts.body !== undefined) readable.push(opts.body);
    readable.push(null);
    return Object.assign(readable, {
        method,
        url,
        headers: { host: "127.0.0.1" },
        socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    }) as unknown as http.IncomingMessage;
}

function mkRes(): { res: http.ServerResponse; out: { code?: number; body?: string } } {
    const out: { code?: number; body?: string } = {};
    const res = {
        writeHead(code: number, _headers?: unknown): void { out.code = code; },
        end(body?: string): void { out.body = body; },
    };
    return { res: res as unknown as http.ServerResponse, out };
}

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(name: string, id: string, protocol: string) {
    const dir = path.join(SESSIONS_DIR, name);
    fs.cpSync(path.join(CORPUS_ROOT, name), dir, { recursive: true });
    const loader = new SessionStore({ dir, debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

function withUnified<T>(fn: () => Promise<T> | T): Promise<T> | T {
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        return fn();
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
    }
}

let store: SessionStore;
let cpId = "";

test("#3633 list+create: both prefixes routable, response keys follow the prefix", async () => {
    await withUnified(async () => {
        store = new SessionStore({ dir: SESSIONS_DIR, debounceMs: 1, enabled: true });
        _setStoreForTest(store);
        const session = loadCorpusCase("folded", "corpus-folded", "anthropic");
        await store.writeNow(session);
        assert.ok(store.checkpointsAvailable(), "full mode must expose checkpoints");

        // empty list on both prefixes, keyed per prefix
        let { res, out } = mkRes();
        await handleAdminRoute(mkReq("GET", "/__bili/checkpoints"), res, makeCtx());
        assert.equal(out.code, 200);
        assert.deepEqual(JSON.parse(out.body ?? "{}"), { ok: true, checkpoints: [] });

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/replicas"), res, makeCtx());
        assert.equal(out.code, 200);
        assert.deepEqual(JSON.parse(out.body ?? "{}"), { ok: true, replicas: [] });

        // create on the canonical prefix → "checkpoint" key
        ({ res, out } = mkRes());
        await handleAdminRoute(
            mkReq("POST", "/__bili/checkpoints", { body: JSON.stringify({ sessionId: "corpus-folded", label: "before-experiment" }) }),
            res, makeCtx(),
        );
        assert.equal(out.code, 201);
        const created = JSON.parse(out.body ?? "{}") as { ok: boolean; checkpoint?: Record<string, unknown> };
        assert.equal(created.ok, true);
        assert.ok(created.checkpoint, "canonical prefix must answer with the checkpoint key");
        cpId = String(created.checkpoint!.cpId);
        assert.match(cpId, /^cp-/);
        assert.equal(created.checkpoint!.sessionId, "corpus-folded");
        assert.equal(created.checkpoint!.kind, "replica");
        assert.equal(created.checkpoint!.label, "before-experiment");

        // create on the alias prefix → "replica" key (byte-compat contract)
        ({ res, out } = mkRes());
        await handleAdminRoute(
            mkReq("POST", "/__bili/replicas", { body: JSON.stringify({ sessionId: "corpus-folded", label: "alias copy" }) }),
            res, makeCtx(),
        );
        assert.equal(out.code, 201);
        const aliased = JSON.parse(out.body ?? "{}") as { ok: boolean; replica?: Record<string, unknown> };
        assert.equal(aliased.ok, true);
        assert.ok(aliased.replica, "alias prefix must keep answering with the replica key");
        assert.notEqual(String(aliased.replica!.cpId), cpId);

        // ?sessionId= filter still works through both prefixes
        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/checkpoints?sessionId=corpus-folded"), res, makeCtx());
        assert.equal((JSON.parse(out.body ?? "{}") as { checkpoints: unknown[] }).checkpoints.length, 2);
        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/replicas?sessionId=nobody-here"), res, makeCtx());
        assert.equal((JSON.parse(out.body ?? "{}") as { replicas: unknown[] }).replicas.length, 0);
    });
});

test("#3633 detail: both prefixes, byteLen present, 404/400 shapes stable", async () => {
    await withUnified(async () => {
        let { res, out } = mkRes();
        await handleAdminRoute(mkReq("GET", `/__bili/checkpoints/${cpId}`), res, makeCtx());
        assert.equal(out.code, 200);
        const detail = JSON.parse(out.body ?? "{}") as { ok: boolean; checkpoint?: { cpId: string; byteLen: number } };
        assert.equal(detail.ok, true);
        assert.equal(detail.checkpoint?.cpId, cpId);
        assert.ok(typeof detail.checkpoint?.byteLen === "number" && detail.checkpoint.byteLen > 0, "frozen blob size must ride along");

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", `/__bili/replicas/${cpId}`), res, makeCtx());
        assert.equal(out.code, 200);
        const aliased = JSON.parse(out.body ?? "{}") as { replica?: { cpId: string } };
        assert.equal(aliased.replica?.cpId, cpId);

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/checkpoints/cp-nope"), res, makeCtx());
        assert.equal(out.code, 404);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /checkpoint not found: cp-nope/);

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/checkpoints/"), res, makeCtx());
        assert.equal(out.code, 400);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /expected \/__bili\/checkpoints\/<cpId>/);
    });
});

test("#3633 restore: both prefixes materialize a fresh session; 409 on live id", async () => {
    await withUnified(async () => {
        let { res, out } = mkRes();
        await handleAdminRoute(mkReq("POST", `/__bili/checkpoints/${cpId}/restore`), res, makeCtx());
        assert.equal(out.code, 201);
        const restored = JSON.parse(out.body ?? "{}") as { ok: boolean; sessionId: string; restoredFrom: string };
        assert.equal(restored.ok, true);
        assert.match(restored.sessionId, /^restore-/);
        assert.equal(restored.restoredFrom, "corpus-folded");

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("POST", `/__bili/replicas/${cpId}/restore`), res, makeCtx());
        assert.equal(out.code, 201);
        assert.match(String(JSON.parse(out.body ?? "{}").sessionId), /^restore-/);

        // caller-chosen id that already exists must 409, never clobber
        ({ res, out } = mkRes());
        await handleAdminRoute(
            mkReq("POST", `/__bili/checkpoints/${cpId}/restore`, { body: JSON.stringify({ sessionId: "corpus-folded" }) }),
            res, makeCtx(),
        );
        assert.equal(out.code, 409);

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("POST", "/__bili/checkpoints/a/b/restore"), res, makeCtx());
        assert.equal(out.code, 400);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /expected \/__bili\/checkpoints\/<cpId>\/restore/);
    });
});

test("#3633 delete: both prefixes; second delete 404s", async () => {
    await withUnified(async () => {
        let { res, out } = mkRes();
        await handleAdminRoute(mkReq("DELETE", `/__bili/replicas/${cpId}`), res, makeCtx());
        assert.equal(out.code, 200);
        assert.deepEqual(JSON.parse(out.body ?? "{}"), { ok: true, deleted: true });

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("DELETE", `/__bili/checkpoints/${cpId}`), res, makeCtx());
        assert.equal(out.code, 404);
        assert.deepEqual(JSON.parse(out.body ?? "{}"), { ok: false, deleted: false });

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("DELETE", "/__bili/replicas/"), res, makeCtx());
        assert.equal(out.code, 400);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /expected \/__bili\/replicas\/<cpId>/);
    });
});

test("#3633 management gate: the new prefix inherits loopback-only protection", () => {
    assert.equal(isManagementPath("/__bili/checkpoints"), true);
    assert.equal(isManagementPath("/__bili/checkpoints/cp-abc"), true);
    assert.equal(isManagementPath("/__bili/replicas"), true);
    return withUnified(async () => {
        const { res, out } = mkRes();
        await handleAdminRoute(mkReq("GET", "/__bili/checkpoints", { remoteAddress: "10.0.0.5" }), res, makeCtx());
        assert.equal(out.code, 403);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /loopback-only/);
    });
});

test("#3633 status: additive instanceId + sessionsOnDisk, existing payload intact", async () => {
    await withUnified(async () => {
        const { res, out } = mkRes();
        await handleAdminRoute(mkReq("GET", "/__bili/status"), res, makeCtx());
        assert.equal(out.code, 200);
        const status = JSON.parse(out.body ?? "{}") as Record<string, unknown>;
        // additive fields (#3633): LB pinning + "session moved vs evicted"
        assert.equal(status.instanceId, "test-instance");
        assert.ok(typeof status.sessionsOnDisk === "number" && (status.sessionsOnDisk as number) >= 1,
            `sessionsOnDisk must count the seeded corpus session, got ${String(status.sessionsOnDisk)}`);
        // pre-existing keys must survive unchanged (regression guard);
        // commit/diskVersion are build-info-sourced and legitimately absent
        // in a dev tree without a prior npm run build
        for (const key of ["version", "stale", "inFlight", "splitSessions", "conflicts", "storage", "attribution"]) {
            assert.ok(key in status, `existing status key missing: ${key}`);
        }
        for (const key of ["commit", "diskVersion"]) {
            assert.ok(!(key in status) || typeof status[key] === "string", `${key} must be absent or a string`);
        }
    });
});

test("#3633 legacy mode: 501 on both prefixes with canonical wording", async () => {
    const legacy = new SessionStore({ dir: SESSIONS_DIR, debounceMs: 1, enabled: true });
    _setStoreForTest(legacy);
    try {
        assert.equal(legacy.checkpointsAvailable(), false, "legacy mode must not expose checkpoints");
        let { res, out } = mkRes();
        await handleAdminRoute(
            mkReq("POST", "/__bili/checkpoints", { body: JSON.stringify({ sessionId: "corpus-folded" }) }),
            res, makeCtx(),
        );
        assert.equal(out.code, 501);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /checkpoints require the unified store/);

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("GET", "/__bili/replicas"), res, makeCtx());
        assert.equal(out.code, 501);
        assert.match(String(JSON.parse(out.body ?? "{}").error), /checkpoints require the unified store/);

        ({ res, out } = mkRes());
        await handleAdminRoute(mkReq("DELETE", "/__bili/checkpoints/cp-x"), res, makeCtx());
        assert.equal(out.code, 501);
    } finally {
        legacy.closeQuietly();
        _setStoreForTest(store);
    }
});

test("#3633 cleanup", () => {
    store.closeQuietly();
    try { fs.rmSync(SESSIONS_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
});
