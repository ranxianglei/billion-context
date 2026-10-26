import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

/**
 * #3931 step 3: the mysql backend on the REAL SessionStore hot path.
 *
 * The contract suite (storage-backend-contract.test.ts) proves the backend
 * satisfies the operation contract against a real MySQL. This suite proves
 * the WIRING: a SessionStore booted with storage.backend=mysql + full mode
 *   - attaches its sidecar asynchronously (ready()) and keeps writing JSON
 *     envelopes (writerOff is sqlite-only),
 *   - ingests saves onto the serial backend queue (rows appear),
 *   - serves cold loads from the envelope (the sync read path),
 *   - exposes replicas/ext through the async twins,
 *   - restarts warm on the same DSN.
 *
 * Skipped unless BILI_MYSQL_TEST_DSN is set (same discipline as the
 * contract suite; the CI mysql-contract job runs both).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-mysql-e2e-hermetic-")),
    "no-config.json",
);

const DSN = process.env.BILI_MYSQL_TEST_DSN ?? "";
const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

async function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    // With the mysql env pinned this loader also opens a pool — close it or
    // the process hangs on the open connection.
    await loader.closeQuietlyAsync();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded;
}

function mysqlEnv(dsn: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        BILI_STORAGE_UNIFIED: "full",
        BILI_STORAGE_BACKEND: "mysql",
        BILI_MYSQL_DSN: dsn,
    };
}

/** Poll the async twin until the session row lands (mysql network + queue
 *  latency). tail_json may legitimately carry null tailSeqs (a corpus
 *  session with empty lastMessages), so the session ROW is the wait signal. */
async function untilRows(store: SessionStore, id: string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const shadow = (store as unknown as { shadow?: { viewForAsync(sid: string): Promise<{ id?: string } | null> } }).shadow;
        const view = shadow ? await shadow.viewForAsync(id) : null;
        if (view) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`mysql rows for ${id} did not land within ${ms}ms`);
}

test("mysql hot path: saves land on the backend, envelopes keep being written, restart stays warm", { skip: DSN ? false : "BILI_MYSQL_TEST_DSN not set" }, async () => {
    const prevEnv = { ...process.env };
    Object.assign(process.env, mysqlEnv(DSN));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mysql-e2e-"));
    const sid = `mysql-e2e-${Date.now().toString(36)}`;
    try {
        // A corpus session folded once (deadrefs case has blocks + contents).
        const corpus = await loadCorpusCase(dir, "deadrefs", "corpus-deadrefs", "anthropic");
        corpus.id = sid;
        corpus.metadata.label = sid;

        const store = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await store.ready();
        const shadow = (store as unknown as { shadow?: { isAsyncBackend: boolean; viewForAsync(id: string): Promise<LegacySessionLike | null> } }).shadow;
        assert.ok(shadow, "mysql sidecar must attach after ready()");
        assert.equal(shadow.isAsyncBackend, true, "the shadow must ride the async backend");

        // Hot-path write: the save runs the async ingest queue.
        await store.writeNow(corpus);
        await untilRows(store, sid);

        // Envelope discipline: writerOff is sqlite-only — the JSON file is
        // the sync read path on mysql, so it MUST exist.
        const all: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) walk(full); else all.push(e.name); } };
        walk(dir);
        const envelope = all.find((f) => f.endsWith(".json") && !f.endsWith(".content-store.json"));
        assert.ok(envelope, `a JSON envelope must be written under mysql (${all.join(",")})`);

        // The backend holds the session view (async twin): same id, fold
        // blocks intact (the corpus case carries blocks + contents).
        const view = await shadow.viewForAsync(sid);
        assert.ok(view, "viewForAsync must serve the ingested session");
        const viewAny = view as unknown as { id?: string; state?: { blocks?: unknown[] } };
        assert.equal(viewAny.id, sid, "backend view id");
        assert.ok(Array.isArray(viewAny.state?.blocks) && (viewAny.state?.blocks?.length ?? 0) > 0, "backend view keeps the fold blocks");

        // Replicas through the async twins.
        const cp = await store.createReplica(sid, { label: "mysql-e2e" });
        assert.match(cp.cp_id, /^cp-/);
        const listed = await store.listReplicas(sid);
        assert.ok(listed.some((r) => r.cp_id === cp.cp_id));
        const restored = await store.restoreReplica(cp.cp_id);
        assert.equal(restored.restoredFrom, sid);
        assert.equal(await store.deleteReplica(cp.cp_id), true);

        // ext substrate (incremental pointers) round-trips async.
        const shExt = (store as unknown as { shadow: { setSessionExtAsync(id: string, k: string, v: unknown): Promise<void>; getSessionExtAsync(id: string, k: string): Promise<unknown> } }).shadow;
        await shExt.setSessionExtAsync(sid, "inc:test-key", [1, 2, 3]);
        assert.deepEqual(await shExt.getSessionExtAsync(sid, "inc:test-key"), [1, 2, 3]);

        await store.closeQuietlyAsync();

        // Restart on the same DSN: the sidecar reattaches, the session is
        // still fully served (envelope + backend rows), and a second save
        // lands again (watermark path on the async backend).
        const reopen = new SessionStore({ dir, debounceMs: 0, enabled: true });
        await reopen.ready();
        const warm = reopen.loadSync(sid);
        assert.ok(warm, "cold load after restart must serve (envelope path)");
        await reopen.writeNow(warm);
        await untilRows(reopen, sid);
        await reopen.closeQuietlyAsync();
    } finally {
        Object.assign(process.env, prevEnv);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
