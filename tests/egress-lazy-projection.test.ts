/**
 * #7474 P2 (ruling 7439): the egress-on session's pin ledger lives in the
 * op log. `snapPinLiveIds` is the ONE read entry: egress_state (the
 * compaction-bounded serving read) when the session has an op log, the
 * messages rows otherwise — so a non-egress session sees exactly the old
 * output, and a corrupt op log degrades to the (stale-but-honest) messages
 * ledger instead of throwing on the pin path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressStateAppend, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { planIngest } from "../src/storage/ingest.ts";
import type { BiliMessage } from "acp-kernel/wire";

const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage =>
    ({ id, role, contentType: "text", text });

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openStore(): { store: UnifiedStore; adapter: EgressOpLogStore; db: ReturnType<typeof openSqliteDatabase>["db"]; dir: string } {
    const dir = tmpdir("bili-egress-projection-");
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const adapter: EgressOpLogStore = {
        egressStateAppendOps: (sid, ops, nowMs) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateCompactView: () => 0,
        egressStateViewAt: (sid, seq) => {
            const rows = db
                .prepare("SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC")
                .all(sid, seq) as unknown as { op_seq: number; log_seq: number | null; row_type: "B" | "I" | "D" | "U"; msgid: string | null; payload: string; bytes: string | null }[];
            void rows;
            throw new Error("unused in this suite");
        },
        egressStateMaxSeq: (sid) => {
            void egressStateView(db, sid);
            return (db.prepare("SELECT COALESCE(MAX(log_seq), 0) AS mx FROM egress_flow WHERE session_id = ?").get(sid) as { mx: number }).mx;
        },
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare("DELETE FROM egress_state WHERE session_id = ? AND op_seq > ?").run(sid, seq);
            const b = db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?").run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
    return { store, adapter, db, dir };
}

// Close BOTH SQLite handles before removing the dir — Windows refuses to
// delete a directory with open file handles (EPERM), unlike POSIX.
function cleanup(H: { store: UnifiedStore; db: ReturnType<typeof openSqliteDatabase>["db"]; dir: string }): void {
    try { H.store.close(); } catch { /* best-effort shutdown */ }
    try { H.db.close(); } catch { /* best-effort shutdown */ }
    fs.rmSync(H.dir, { recursive: true, force: true });
}

test("snapPinLiveIds: op-log authority, system row excluded, order = log_seq", () => {
    const H = openStore();
    try {
        let view = recordEgressTurn({ store: H.adapter, sessionId: "s1", prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.adapter, sessionId: "s1", prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        assert.deepEqual(H.store.snapPinLiveIds("s1"), ["m1", "m2"]);
        assert.deepEqual(H.store.snapMsgIdLiveIds("s1"), [], "the messages projection is untouched by egress recording");
    } finally {
        cleanup(H);
    }
});

test("snapPinLiveIds: a session without an op log reads the messages ledger unchanged", () => {
    const H = openStore();
    try {
        const core = {
            id: "plain-sess",
            createdAt: 1_000,
            lastSeen: 2_000,
            meta: { protocol: "anthropic" },
            stats: { requests: 2 },
            metadata: {},
            state: {
                blocks: [],
                messageRefs: { byRaw: { h1: "m00001", h2: "m00002" }, byRef: { m00001: "h1", m00002: "h2" } },
                nextBlockId: 1,
                nextRunId: 1,
            },
            blockContents: new Map(),
            lastMessages: [
                { id: "h1", role: "user", contentType: "text", text: "one" } as never,
                { id: "h2", role: "assistant", contentType: "text", text: "two" } as never,
            ],
            contentStore: { version: 1 as const, byHash: {} as Record<string, string>, byRef: {} as Record<string, unknown> },
        } as never;
        assert.ok(H.store.ingestSession(planIngest(core), undefined, { completeLog: true }));
        const fromMessages = H.store.snapMsgIdLiveIds("plain-sess");
        assert.ok(fromMessages.length >= 2, `messages ledger populated (got ${fromMessages.length})`);
        assert.deepEqual(H.store.snapPinLiveIds("plain-sess"), fromMessages, "no op log → byte-identical to the legacy read");
    } finally {
        cleanup(H);
    }
});

test("snapPinLiveIds: a corrupt op log degrades to the messages ledger, never throws", () => {
    const H = openStore();
    try {
        let view = recordEgressTurn({ store: H.adapter, sessionId: "s3", prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.adapter, sessionId: "s3", prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // A +U whose target msgid does not exist in the view: the replay
        // must reject (EgressStateCorruptError) — the pin read then falls
        // back to the messages ledger instead of throwing.
        const bad = dbMaxOpSeq(H.db, "s3") + 1;
        H.db
            .prepare("INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, NULL, 'U', ?, ?, ?, ?)")
            .run("s3", bad, "ghost", JSON.stringify({ role: "user" }), "corrupt-bytes", 3);
        assert.throws(() => H.adapter.egressStateView("s3"), /corrupt|egress-state/i);
        assert.deepEqual(H.store.snapPinLiveIds("s3"), H.store.snapMsgIdLiveIds("s3"), "corrupt op log → messages ledger (stale-but-honest, never a pin-path throw)");
    } finally {
        cleanup(H);
    }
});

function dbMaxOpSeq(db: ReturnType<typeof openSqliteDatabase>["db"], sid: string): number {
    return (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_state WHERE session_id = ?").get(sid) as { mx: number }).mx;
}
