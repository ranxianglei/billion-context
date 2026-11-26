/**
 * #7474 P2 (ruling 7439): the egress-on session's pin ledger lives in the
 * op log. `snapPinLiveIds` is the ONE read entry: egress_state (the
 * compaction-bounded serving read) when the session has an op log, the
 * messages rows otherwise — so a non-egress session sees exactly the old
 * output, and a corrupt op log degrades to the (stale-but-honest) messages
 * ledger instead of throwing on the pin path.
 *
 * #7574: the op log is consulted only while the plane is switched on; a
 * serving copy that disagrees with the log is copied again from the log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressAppendTurn, egressFlowWalkBack, egressStateRead, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { egressPlaneGateOn } from "../src/knobs.ts";

// The pin read consults the op log only while the plane is on (#7574).
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
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
        egressAppendTurn: (sid, ops, baseSeq, nowMs) => egressAppendTurn(db, sid, ops, nowMs, { baseSeq }),
        egressStateView: (sid) => egressStateRead(db, sid),
        egressStateViewAt: (sid, seq) => {
            const rows = db
                .prepare("SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC")
                .all(sid, seq) as unknown as { op_seq: number; log_seq: number | null; row_type: "B" | "I" | "D" | "U"; msgid: string | null; payload: string; bytes: string | null }[];
            void rows;
            throw new Error("unused in this suite");
        },
        egressStateMaxSeq: (sid) => {
            void egressStateView(db, sid);
            return (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?").get(sid) as { mx: number }).mx;
        },
        egressStateTruncateAfter: (sid, seq) => {
            const b = db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?").run(sid, seq);
            return Number(b.changes);
        },
        egressFlowWalkBack: (sid) => egressFlowWalkBack(db, sid),
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

test("snapPinLiveIds: a damaged serving copy is copied again from the log; a corrupt log degrades to the messages ledger, never throws", () => {
    const H = openStore();
    try {
        let view = recordEgressTurn({ store: H.adapter, sessionId: "s3", prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.adapter, sessionId: "s3", prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // A ghost state row: pos density breaks, the serving read notices.
        const plantStateGhost = () =>
            H.db
                .prepare(`INSERT INTO egress_state (session_id, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 'ghost', 99, 0, 0, '', 0, 'text', 'user', 0, 0, 'x', 3)`)
                .run("s3");
        // 1. only the SERVING COPY is damaged, the log itself is intact: the
        //    copy is rebuilt from the log and the session keeps its ids
        //    (#7574 — it used to fall back to the stale messages ledger for
        //    as long as the damaged row stayed).
        plantStateGhost();
        const healed = H.adapter.egressStateView("s3");
        assert.deepEqual(healed.map((r) => r.msgid), ["egress-system", "m1", "m2"], "the self-healing read replays the intact log");
        assert.deepEqual(H.store.snapPinLiveIds("s3"), ["m1", "m2"], "intact log → the copy is repaired, the ids come from the log");
        const stateCount = (H.db.prepare("SELECT COUNT(*) AS c FROM egress_state WHERE session_id = ?").get("s3") as { c: number }).c;
        assert.equal(stateCount, 3, "the damaged row is gone after the repair");
        // 2. the LOG is corrupt too: the pin read falls back to the messages
        //    ledger instead of throwing. Damage a flow I-row's payload (the
        //    rebuild replay meets it) on top of a stray state row (which is
        //    what sends the read onto the rebuild path).
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type = 'I' AND msgid = 'm1'`).run('{"x":1}', "s3");
        plantStateGhost();
        assert.throws(() => H.adapter.egressStateView("s3"), /corrupt|egress-state/i);
        assert.deepEqual(H.store.snapPinLiveIds("s3"), H.store.snapMsgIdLiveIds("s3"), "corrupt op log → messages ledger (stale-but-honest, never a pin-path throw)");
        assert.ok(dbMaxOpSeq(H.db, "s3") >= 3, "a corrupt log is left for the operator — the read does not delete anything");
    } finally {
        cleanup(H);
    }
});

test("snapPinLiveIds: with the plane switched off the op log is not consulted, even when one is there (#7574)", () => {
    const H = openStore();
    const saved = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    try {
        let view = recordEgressTurn({ store: H.adapter, sessionId: "s4", prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.adapter, sessionId: "s4", prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        assert.deepEqual(H.store.snapPinLiveIds("s4"), ["m1", "m2"], "plane on: ids from the op log");
        // the plane is turned off (an install that rolls the feature back):
        // the session goes back to the messages ledger like any other.
        // GA (2026-11-24): "unset" resolves ON, so the rollback is forced "0".
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
        assert.equal(egressPlaneGateOn(), false, "precondition: the plane is off");
        assert.deepEqual(H.store.snapPinLiveIds("s4"), H.store.snapMsgIdLiveIds("s4"), "plane off: messages ledger, the op log is ignored");
        // on again: the log is picked up where it was
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        assert.deepEqual(H.store.snapPinLiveIds("s4"), ["m1", "m2"], "plane back on: ids from the op log again");
    } finally {
        if (saved === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        else process.env.BILI_ROLLOUT_EGRESS_PLANE = saved;
        cleanup(H);
    }
});

function dbMaxOpSeq(db: ReturnType<typeof openSqliteDatabase>["db"], sid: string): number {
    return (db.prepare("SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?").get(sid) as { mx: number }).mx;
}
