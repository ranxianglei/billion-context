/**
 * Load-path guard: the egress-on kstate rebuild overlay must NOT replace the
 * refs-ledger citation space with the op log's row numbering.
 *
 * Renumber (2026-11-25, docs/egress-plane.md §10): the op log's canonical
 * number IS the kernel citation number (mNNNNN = m + log_seq), stamped from
 * the session's refs ledger at record time; the constant system row is
 * number 0, outside the citation space. The overlay's `row.num <= 0` skip
 * therefore never mints a ref for the system row, and every number it does
 * mint is the kernel's own — so a cold egress-on load rebuilds a
 * messageRefs map that agrees with the refs table (and with the stored
 * tokenSnapshot, which is keyed by ref). Before the renumber the op log
 * numbered rows densely from 1 with the system row FIRST: the overlay minted
 * m00001 = egress-system, shifted every real citation by one, and after a
 * restart the wire tags misattributed token counts across messages (the
 * storage-engine-proofs "full-mode restart is invisible on the wire" reds
 * under the egress family default-on).
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
process.env.BILI_ROLLOUT_EGRESS_KSTATE_REBUILD = "1";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hermetic = mkdtempSync(join(tmpdir(), "bili-overlay-refs-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";

import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createInitialState, emptyRefMap, type CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { recordEgressTurn } from "../src/storage/egress-record.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.ts";

type Db = SqliteDatabase;

const bm = (id: string): BiliMessage => ({ id, role: "user", content: [{ type: "text", text: id }] } as unknown as BiliMessage);

function makeSession(sessionId: string, messages: BiliMessage[]): object {
    const state = createInitialState();
    state.messageRefs = assignRefs(messages as unknown as CoreMessage[], { existing: emptyRefMap(), nextIndex: 0 }).map;
    const session = {
        id: sessionId,
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, rangeRestores: 0 },
        metadata: {} as Record<string, unknown>,
        state,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
    return session;
}

/** The session record shape SessionStore.writeNow ingests. */
function persistable(session: object, messages: BiliMessage[]): never {
    return {
        ...session,
        lastMessages: messages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

test("load: the refs-ledger citation space wins over the op-log numbering (the system row takes no ref)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-overlay-refs-"));
    let store: SessionStore = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
    _setStoreForTest(store);
    let db: Db | null = null;
    const vd = (): Db => { if (db === null) db = openSqliteDatabase(join(dir, "index.db")).db; return db; };
    try {
        const sid = "sess-overlay-refs";
        const ids = ["u1", "u2", "u3", "u4", "u5"];
        const msgs = ids.map(bm);
        const session = makeSession(sid, msgs);
        // A NORMAL (pre-arm) save: sessions row + refs rows from the kernel's
        // own map (u1 = m00001).
        await store.writeNow(persistable(session, msgs));

        // The plane now records this session — the constant system row enters
        // the op log as log_seq 1, the five messages 2..6.
        const u = store.egressOpLogStore();
        const rows = recordEgressTurn({ store: u!, sessionId: sid, prev: undefined, conversation: msgs as unknown as CoreMessage[], systemText: "sys", nowMs: 1_000_000 });
        assert.equal(rows.length, 6, "system row + 5 messages");
        await store.writeNow(persistable(session, msgs));

        const refRows = vd().prepare("SELECT raw_id, ref FROM refs WHERE session_id = ? ORDER BY ord").all(sid) as { raw_id: string; ref: string }[];
        assert.deepEqual(refRows.map((r) => r.raw_id), ids, "the refs ledger holds the kernel's five messages");
        assert.equal(refRows[0]!.ref, "m00001", "u1 owns m00001 in the ledger");

        // ---- RESTART -------------------------------------------------------
        await store.closeQuietly();
        _resetStoreForTest();
        store = new SessionStore({ enabled: true, dir, debounceMs: 60000 });
        _setStoreForTest(store);
        assert.ok(await store.waitForReplicas(5000), "unified store ready after restart");

        const loaded = await store.loadAsync(sid);
        assert.ok(loaded !== null, "the sessions row from the pre-arm save makes the session loadable");
        const refs = (loaded as { state?: { messageRefs?: { byRaw?: Record<string, string>; byRef?: Record<string, string> } } }).state?.messageRefs;
        assert.ok(refs, "the loaded state carries its message refs");
        assert.equal(refs!.byRef?.["m00001"], "u1", "the FIRST real message keeps m00001 — the op-log's system row (log_seq 1) must not claim it");
        assert.equal(refs!.byRaw?.["u1"], "m00001");
        assert.ok(!Object.values(refs!.byRef ?? {}).includes("egress-system"), "the synthetic system row takes no citation number");
    } finally {
        _resetStoreForTest();
        store.closeQuietly();
        // the handle is assigned inside the vd() closure — a plain `db?.close()`
        // is control-flow-narrowed to null here, so cast to the closeable shape.
        try { (db as { close(): void } | null)?.close(); } catch { /* best-effort */ }
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // transient OS tmpdir — a cleanup failure must not fail the test.
        }
    }
});
