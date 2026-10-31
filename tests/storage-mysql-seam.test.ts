import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, recordToLegacyView } from "../src/persist.ts";
import { _resetSessionsForTest, getSessionAsync, peekSession } from "../src/session.ts";
import { handlePluginStatus } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type {
    StorageBackend,
    IngestSessionInput,
    MessageRow,
    BlockRow,
    RefRow,
    CcrEntryRow,
    SessionSummaryRow,
    SessionViewRows,
    StorageReadView,
} from "../src/storage/backend.ts";
import { sha256 } from "../src/storage/canonical.ts";

/**
 * #4942: the async reload seam on network storage backends — hermetic twin of
 * tests/storage-backend-mysql-e2e.test.ts (which skips in CI without a DSN,
 * which is exactly why #4936's writerOff breakage sailed through green CI).
 * A typed stub stands in for the mysql2 backend so the seam's contract is
 * pinned on every CI run:
 *   - loadAsync serves what loadSync serves whenever loadSync finds something
 *     (zero behavior change), and only falls to the DB row when the sync path
 *     has no copy (envelope-first precedence);
 *   - boot / bootBounded / loadAll enumerate DB-only ids through the async
 *     twins under the same budgets;
 *   - getSessionAsync single-flights concurrent first-touches of one id;
 *   - the jsonWriter=off gate stays sqlite-only on mysql (the #4936 gate).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-mysql-seam-hermetic-")),
    "no-config.json",
);
for (const k of ["BILI_STORAGE_BACKEND", "BILI_STORAGE_UNIFIED", "BILI_STORAGE_JSON_WRITER", "BILI_MYSQL_DSN"]) delete process.env[k];

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");
const CORPUS_ID = "corpus-folded";
const UPSTREAM_ORIGIN = "http://127.0.0.1:8199";

interface StubRows {
    session: IngestSessionInput["session"];
    messages: MessageRow[];
    blocks: BlockRow[];
    deadRefs: IngestSessionInput["deadRefs"];
    refs: RefRow[];
    ccrEntries: CcrEntryRow[];
}

/** Map-shaped stand-in for MysqlBackend: stores exactly what ingestSession
 *  receives and hands it back through the read twins, so viewForAsync round-
 *  trips the same rows the save path produced (last write wins per session). */
class StubMysqlBackend implements StorageBackend {
    readonly rows = new Map<string, StubRows>();
    readonly viewCalls = { count: 0 };

    ingestSession(input: IngestSessionInput): Promise<boolean> {
        this.rows.set(input.session.sessionId, {
            session: input.session,
            messages: input.messages,
            blocks: input.blocks,
            deadRefs: input.deadRefs,
            refs: input.refs,
            ccrEntries: input.ccrEntries,
        });
        return Promise.resolve(true);
    }
    sessionCounters(sessionId: string): Promise<{ requests: number; nextBlockId: number } | null> {
        const row = this.rows.get(sessionId)?.session;
        if (!row) return Promise.resolve(null);
        let requests = 0;
        try { requests = (JSON.parse(row.statsJson) as { requests?: number }).requests ?? 0; } catch { /* malformed statsJson counts as zero */ }
        return Promise.resolve({ requests, nextBlockId: row.nextBlockId });
    }
    sessionUpdatedAt(sessionId: string): Promise<number | null> {
        return Promise.resolve(this.rows.get(sessionId)?.session.updatedAt ?? null);
    }
    deleteSession(sessionId: string): Promise<void> {
        this.rows.delete(sessionId);
        return Promise.resolve();
    }
    listSessionIds(): Promise<string[]> {
        return Promise.resolve([...this.rows.keys()]);
    }
    lookupConversation(_namespace: string, _conversationId: string): Promise<string | null> {
        return Promise.resolve(null);
    }
    listConversationBindings(): Promise<{ namespace: string; conversationId: string; sessionId: string; claimedAt: number }[]> {
        return Promise.resolve([]);
    }
    getSessionRow(sessionId: string): Promise<StubRows["session"] | null> {
        this.viewCalls.count++;
        return Promise.resolve(this.rows.get(sessionId)?.session ?? null);
    }
    // #5198-era interface members (#4739 narrow reads + snapshot facade),
    // satisfied from the same rows ingestSession captured.
    sessionViewRows(sessionId: string): Promise<SessionViewRows> {
        const row = this.rows.get(sessionId);
        if (!row) return Promise.resolve(null);
        const view = {
            session: row.session,
            messages: row.messages.map((r) => ({ ...r, contentHash: r.contentHash ?? sha256(r.content) })),
            blocks: row.blocks.map((b) => ({ ...b, summaryHash: sha256(b.summary), oneHash: b.one === null ? null : sha256(b.one) })),
            deadRefs: row.deadRefs,
            refs: row.refs,
        };
        return Promise.resolve(view as unknown as SessionViewRows);
    }
    readSnapshot<T>(read: (reader: StorageReadView) => Promise<T>): Promise<T> {
        const row = (id: string) => this.rows.get(id);
        const view: StorageReadView = {
            getSessionRow: async (id) => row(id)?.session ?? null,
            getMessages: async (id, _opts) => (row(id)?.messages ?? []).map((r) => ({ ...r, contentHash: r.contentHash ?? sha256(r.content), retiredAt: null })),
            getBlocks: async (id, _opts) => (row(id)?.blocks ?? []).map((b) => ({ ...b, summaryHash: sha256(b.summary), oneHash: b.one === null ? null : sha256(b.one) })),
            getDeadRefs: async (id) => row(id)?.deadRefs ?? [],
            getRefs: async (id) => row(id)?.refs ?? [],
        };
        return read(view);
    }
    liveRowCount(sessionId: string): Promise<number> {
        return Promise.resolve(this.rows.get(sessionId)?.messages.length ?? 0);
    }
    lastLiveSeq(sessionId: string): Promise<number | null> {
        const rows = this.rows.get(sessionId)?.messages ?? [];
        return Promise.resolve(rows.length > 0 ? Math.max(...rows.map((r) => r.seq)) : null);
    }
    seqByRaw(sessionId: string): Promise<Map<string, number> | null> {
        const refs = this.rows.get(sessionId)?.refs;
        if (!refs || refs.length === 0) return Promise.resolve(null);
        const out = new Map<string, number>();
        for (const r of refs) out.set(r.rawId, r.ord);
        return Promise.resolve(out);
    }
    cloneSessionRows(): Promise<boolean> {
        return Promise.resolve(true);
    }
    getMessages(sessionId: string, _opts?: { includeRetired?: boolean; seqs?: readonly number[] }): Promise<(MessageRow & { contentHash: string; retiredAt: number | null })[]> {
        const rows = this.rows.get(sessionId)?.messages ?? [];
        // Stub rows come from ingest inputs only (live rows, never retired),
        // so retiredAt is always null here — shape kept for interface parity.
        return Promise.resolve(rows.map((r) => ({ ...r, contentHash: r.contentHash ?? sha256(r.content), retiredAt: null })));
    }
    getBlocks(sessionId: string): Promise<(BlockRow & { summaryHash: string; oneHash: string | null })[]> {
        const rows = this.rows.get(sessionId)?.blocks ?? [];
        return Promise.resolve(rows.map((b) => ({ ...b, summaryHash: sha256(b.summary), oneHash: b.one === null ? null : sha256(b.one) })));
    }
    getDeadRefs(sessionId: string): Promise<IngestSessionInput["deadRefs"]> {
        return Promise.resolve(this.rows.get(sessionId)?.deadRefs ?? []);
    }
    getRefs(sessionId: string): Promise<RefRow[]> {
        return Promise.resolve(this.rows.get(sessionId)?.refs ?? []);
    }
    getCcr(): Promise<null> {
        return Promise.resolve(null);
    }
    getCcrEntries(sessionId: string): Promise<CcrEntryRow[]> {
        return Promise.resolve(this.rows.get(sessionId)?.ccrEntries ?? []);
    }
    // No watermark on the stub → every record takes the full-ingest path
    // (deterministic seeding; the delta probe would need boundary state).
    ingestWatermark(): Promise<null> {
        return Promise.resolve(null);
    }
    tailSeqs(): Promise<null> {
        return Promise.resolve(null);
    }
    clearIngestWatermark(): Promise<void> {
        return Promise.resolve();
    }
    resetAllIngestWatermarks(): Promise<void> {
        return Promise.resolve();
    }
    probeIngestBoundary(): Promise<null> {
        return Promise.resolve(null);
    }
    reapBlocks(): Promise<void> {
        return Promise.resolve();
    }
    archiveSession(): Promise<{ ok: boolean; exportPath?: string; reason?: string; contentRowsDeleted?: number }> {
        return Promise.resolve({ ok: false, reason: "stub" });
    }
    restoreArchived(): Promise<{ ok: boolean; reason?: string }> {
        return Promise.resolve({ ok: false, reason: "stub" });
    }
    gc(): Promise<{ archived: number; contentRowsDeleted: number }> {
        return Promise.resolve({ archived: 0, contentRowsDeleted: 0 });
    }
    contentRefCountOfBody(): Promise<number> {
        return Promise.resolve(0);
    }
    mediaRefCount(): Promise<number> {
        return Promise.resolve(0);
    }
    insertCheckpoint(): Promise<void> {
        return Promise.resolve();
    }
    listCheckpoints(): Promise<never[]> {
        return Promise.resolve([]);
    }
    getCheckpoint(): Promise<undefined> {
        return Promise.resolve(undefined);
    }
    checkpointState(): Promise<never> {
        throw new Error("stub-mysql backend: checkpoints not implemented");
    }
    deleteCheckpoint(): Promise<boolean> {
        return Promise.resolve(false);
    }
    setSessionExt(): Promise<void> {
        return Promise.resolve();
    }
    getSessionExt(): Promise<unknown> {
        return Promise.resolve(null);
    }
    listSessionExt(): Promise<{ key: string; value: unknown; updatedAt: number }[]> {
        return Promise.resolve([]);
    }
    deleteSessionExt(): Promise<number> {
        return Promise.resolve(0);
    }
    setKv(): Promise<void> {
        return Promise.resolve();
    }
    getKv(): Promise<unknown> {
        return Promise.resolve(null);
    }
    listKv(): Promise<{ namespace: string; key: string; value: unknown; updatedAt: number }[]> {
        return Promise.resolve([]);
    }
    deleteKv(): Promise<number> {
        return Promise.resolve(0);
    }
    sessionSummaries(): Promise<SessionSummaryRow[]> {
        const out: SessionSummaryRow[] = [];
        for (const stored of this.rows.values()) {
            const s = stored.session;
            let contextTokens: number | undefined;
            try {
                const stats = JSON.parse(s.statsJson) as { contextEstimateTokens?: unknown };
                if (typeof stats.contextEstimateTokens === "number") contextTokens = stats.contextEstimateTokens;
            } catch { /* malformed statsJson leaves contextTokens unset */ }
            out.push({
                sessionId: s.sessionId,
                title: s.title ?? undefined,
                label: s.label ?? undefined,
                protocol: s.protocol ?? undefined,
                origin: s.origin ?? undefined,
                namespace: s.namespace ?? "",
                blocks: stored.blocks.length,
                latestBlockAt: stored.blocks.length > 0 ? Math.max(...stored.blocks.map((b) => b.createdAt)) : undefined,
                contextTokens,
                updatedAt: s.updatedAt,
                status: s.status ?? "active",
            });
        }
        return Promise.resolve(out);
    }
    webSummaryRows(): Promise<never[]> {
        return Promise.resolve([]);
    }
    verifyProjections(): Promise<{ ok: true; checks: number } | { ok: false; error: string }> {
        return Promise.resolve({ ok: true, checks: 0 });
    }
    counts(): Promise<Record<string, number>> {
        return Promise.resolve({ sessions: this.rows.size });
    }
    contentDedupReport(): Promise<{ rows: number; bytesTotal: number; refcounted: number }> {
        return Promise.resolve({ rows: 0, bytesTotal: 0, refcounted: 0 });
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Loads the folded corpus case into its own legacy store and returns the
 *  Session — the seed for every seam store below. */
async function seedCorpusSession(baseDir: string): Promise<Session> {
    fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(baseDir, "folded"), { recursive: true });
    const loader = new SessionStore({ dir: path.join(baseDir, "folded"), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(CORPUS_ID, { protocol: "anthropic", upstreamOrigin: UPSTREAM_ORIGIN });
    loader.cancelAll();
    await loader.closeQuietlyAsync();
    if (!loaded) throw new Error(`corpus case ${CORPUS_ID} failed to load`);
    return loaded;
}

/** One full-mode sidecar over a stub backend, wired with the SAME
 *  record→view adapter the real store uses (recordToLegacyView) so ingest
 *  lands rows exactly as production would. */
function makeShadow(stub: StubMysqlBackend): UnifiedShadow {
    return UnifiedShadow.fromBackend("full", stub, recordToLegacyView);
}

/** Seam store: empty dir, injected sidecar. */
function makeSeamStore(dir: string, shadow: UnifiedShadow): SessionStore {
    return new SessionStore({ dir, debounceMs: 1, enabled: true, shadow });
}

/** Drives the seeded session onto the stub through the real save path
 *  (guardedBuild → shadow.record → serial queue → ingestSession). */
async function seedOnSeam(store: SessionStore, shadow: UnifiedShadow, session: Session): Promise<void> {
    assert.equal(store.flushSync(session), true);
    const deadline = Date.now() + 5000;
    for (;;) {
        if ((await shadow.viewForAsync(CORPUS_ID)) !== null) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${CORPUS_ID} to land on the stub backend`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

function findEnvelopeFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name.endsWith(".json")) out.push(p);
        }
    };
    walk(dir);
    return out;
}

function removeEnvelopes(dir: string): void {
    for (const f of findEnvelopeFiles(dir)) fs.rmSync(f, { force: true });
}

test("seam: DB-only session is unreachable via loadSync but reachable via loadAsync", async () => {
    const baseDir = tmpDir("bili-seam-dbonly-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-dbonly-store-");
    const store = makeSeamStore(seamDir, shadow);
    try {
        await seedOnSeam(store, shadow, loaded);
        removeEnvelopes(seamDir);
        assert.equal(findEnvelopeFiles(seamDir).length, 0);

        // The old contract, pinned: the sync facade misses by design on
        // network backends — this is the exact read that returned null and
        // started a fresh (empty) session before #4942.
        assert.equal(store.loadSync(CORPUS_ID), null);

        const reloaded = await store.loadAsync(CORPUS_ID);
        assert.ok(reloaded, "loadAsync must serve the DB row when no envelope exists");
        assert.equal(reloaded.id, CORPUS_ID);
        assert.ok(loaded.state.blocks.length > 0, "corpus case must carry folded blocks");
        assert.deepEqual(
            reloaded!.state.blocks.map((b) => b.blockId).sort(),
            loaded.state.blocks.map((b) => b.blockId).sort(),
        );
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: an existing envelope wins over the DB row (zero behavior change)", async () => {
    const baseDir = tmpDir("bili-seam-envfirst-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-envfirst-store-");
    const store = makeSeamStore(seamDir, shadow);
    try {
        await seedOnSeam(store, shadow, loaded);
        assert.ok(findEnvelopeFiles(seamDir).length > 0, "mysql keeps writing envelopes (writerOff is sqlite-only)");

        const viaSync = store.loadSync(CORPUS_ID);
        assert.ok(viaSync, "envelope load must keep working");
        const before = stub.viewCalls.count;
        const viaAsync = await store.loadAsync(CORPUS_ID);
        assert.deepEqual(viaAsync, viaSync, "loadAsync serves content-identical to the sync result when the sync path finds a copy (each cold load builds a fresh object; reference identity was never part of the contract)");
        assert.equal(stub.viewCalls.count, before, "no DB read may happen while an envelope exists");
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: without a sidecar at all, loadAsync is exactly loadSync", async () => {
    const baseDir = tmpDir("bili-seam-parity-");
    const loaded = await seedCorpusSession(baseDir);
    const store = new SessionStore({ dir: baseDir, debounceMs: 1, enabled: true });
    try {
        store.flushSync(loaded);
        const a = store.loadSync(CORPUS_ID);
        const b = await store.loadAsync(CORPUS_ID);
        assert.ok(a && b);
        assert.deepEqual(b, a, "no sidecar → loadAsync serves content-identical to the sync result");
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: bounded boot pre-warms DB-only sessions within the budget", async () => {
    const baseDir = tmpDir("bili-seam-boot-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-boot-store-");
    const store = makeSeamStore(seamDir, shadow);
    try {
        await seedOnSeam(store, shadow, loaded);
        removeEnvelopes(seamDir);

        const warmed = await store.boot({ maxSessions: 8, maxBytes: 64 * 1024 * 1024 });
        const warm = warmed.get(CORPUS_ID);
        assert.ok(warm, "boot union must enumerate the DB-only id through the async twins");
        assert.deepEqual(
            warm!.state.blocks.map((b) => b.blockId).sort(),
            loaded.state.blocks.map((b) => b.blockId).sort(),
        );
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: loadAll unions in DB-only sessions", async () => {
    const baseDir = tmpDir("bili-seam-loadall-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-loadall-store-");
    const store = makeSeamStore(seamDir, shadow);
    try {
        await seedOnSeam(store, shadow, loaded);
        removeEnvelopes(seamDir);

        const all = await store.loadAll();
        assert.ok(all.has(CORPUS_ID), "loadAll must see the DB-only id");
        assert.ok(all.get(CORPUS_ID)!.state.blocks.length === loaded.state.blocks.length);
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: getSessionAsync reloads a DB-only session into the resident pool, single-flight", async () => {
    const baseDir = tmpDir("bili-seam-pool-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-pool-store-");
    const store = makeSeamStore(seamDir, shadow);
    _setStoreForTest(store);
    try {
        await seedOnSeam(store, shadow, loaded);
        removeEnvelopes(seamDir);
        assert.equal(store.loadSync(CORPUS_ID), null, "precondition: nothing local to serve");

        const [a, b] = await Promise.all([getSessionAsync(CORPUS_ID), getSessionAsync(CORPUS_ID)]);
        assert.equal(a, b, "concurrent first-touches must share one load (single-flight)");
        assert.equal(a.id, CORPUS_ID);
        assert.equal(a.state.blocks.length, loaded.state.blocks.length);
        assert.equal(await getSessionAsync(CORPUS_ID), a, "subsequent calls hit the resident pool");
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("seam: plugin conversation resolution materializes DB-only sessions through the async seam", async () => {
    const baseDir = tmpDir("bili-seam-pluginres-");
    const loaded = await seedCorpusSession(baseDir);
    const stub = new StubMysqlBackend();
    const shadow = makeShadow(stub);
    const seamDir = tmpDir("bili-seam-pluginres-store-");
    const store = makeSeamStore(seamDir, shadow);
    _setStoreForTest(store);
    // The earlier tests leave CORPUS_ID resident in the module-level pool —
    // this scenario needs a cold process view of the conversation.
    _resetSessionsForTest();
    try {
        await seedOnSeam(store, shadow, loaded);
        removeEnvelopes(seamDir);
        assert.equal(store.loadSync(CORPUS_ID), null, "precondition: DB-only");
        assert.equal(peekSession(CORPUS_ID), undefined, "precondition: not resident");

        const chunks: string[] = [];
        let status = 0;
        const res = {
            writeHead: (st: number): void => { status = st; },
            end: (body?: string): void => { if (body) chunks.push(body); },
        } as unknown as import("node:http").ServerResponse;
        // The kernel/config deps are never reached for a DB-reloaded session
        // (no in-memory plugin snapshot → the nudge path stays empty), so a
        // throwing stub doubles as a guard against accidental use.
        const deps = {
            core: { processTurn(): never { throw new Error("deps.core must not be called"); } },
            config: {},
            log: (): void => {},
        } as unknown as Parameters<typeof handlePluginStatus>[2];
        await handlePluginStatus(CORPUS_ID, res, deps);

        assert.equal(status, 200, "status must resolve the DB-only conversation");
        const body = JSON.parse(chunks[chunks.length - 1]);
        assert.ok(body.ok === true);
        assert.equal(body.sessionId, CORPUS_ID, "must answer from the resolved session, not a ghost");
        const resident = peekSession(CORPUS_ID);
        assert.ok(resident, "resolution must land the session in the resident pool");
        // The pre-fix shape: a sync getSession after an async probe minted an
        // EMPTY ghost here (0 blocks) that then poisoned later getSessionAsync.
        assert.deepEqual(
            resident!.state.blocks.map((b) => b.blockId).sort(),
            loaded.state.blocks.map((b) => b.blockId).sort(),
        );
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync();
    }
});

test("gate: jsonWriter=off stays ignored on mysql; DSN-less mysql ask REFUSES at ready() (2026-10-30)", async () => {
    const prev = {
        BILI_STORAGE_BACKEND: process.env.BILI_STORAGE_BACKEND,
        BILI_STORAGE_UNIFIED: process.env.BILI_STORAGE_UNIFIED,
        BILI_STORAGE_JSON_WRITER: process.env.BILI_STORAGE_JSON_WRITER,
    };
    const logs: string[] = [];
    // Seed FIRST: under the refusal policy the loader store built inside
    // seedCorpusSession must still use the sqlite backend — flipping the env
    // to DSN-less mysql first would refuse ITS construction too.
    const baseDir = tmpDir("bili-seam-gate-");
    const loaded = await seedCorpusSession(baseDir);
    // Now ask for mysql WITHOUT a DSN: construction succeeds (the backend
    // attach is async), the #4936 gate warning fires at construct time, and
    // ready() must REJECT with the actionable message instead of silently
    // degrading (#5046 chain, 2026-10-30 owner policy).
    process.env.BILI_STORAGE_BACKEND = "mysql";
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off";
    const seamDir = tmpDir("bili-seam-gate-store-");
    const store = new SessionStore({ dir: seamDir, debounceMs: 1, enabled: true, log: (_l, m) => logs.push(m) });
    try {
        assert.ok(
            logs.some((m) => m.includes("storage.jsonWriter=off ignored")),
            `expected the sqlite-only gate warning, got: ${logs.join(" | ")}`,
        );
        let refusalMsg = "";
        try {
            await store.ready();
        } catch (e) {
            refusalMsg = String(e);
        }
        assert.match(refusalMsg, /no DSN is configured/, `ready() must reject naming the missing DSN, got: "${refusalMsg}"`);
        // A refused boot persists NOTHING: no turn was ever flushed through
        // the dead backend, so the dir holds no envelopes.
        assert.equal(findEnvelopeFiles(seamDir).length, 0, "a refused backend must not leave persisted state behind");
        void loaded; // corpus seeded only to prove the ordering above is what saves it
    } finally {
        store.cancelAll();
        await store.closeQuietlyAsync().catch(() => {});
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});
