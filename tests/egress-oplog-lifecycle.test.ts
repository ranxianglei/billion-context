/**
 * Egress op-log self-containment (revised design discussions/7439 ruling 1,
 * #6785): the op-log must be byte-self-contained — recording and replaying
 * NEVER touch the global content table (the old casRef design put every row
 * into it with a refcount bump per turn; that seam is gone):
 *   1. three recorded turns (append / fold / edit) leave the content table
 *      EMPTY and every view row carries its bytes inline; replayed views
 *      stay byte-equal across turns;
 *   2. deleteSession cascades egress_state/egress_flow — the tables are now
 *      plain rows (no CAS refs to release), and the session disappears
 *      atomically.
 * Both directions asserted (#3617): the content table IS untouched on the
 * happy path AND the cascade DOES delete (a kept row would be a leak).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.js";
import { migrateSchema } from "../src/storage/schema.js";
import { egressStateAppend, egressStateView } from "../src/storage/egress-state.js";
import { buildEgressViewRows, recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.js";
import { rebuildCoreFromLog } from "../src/storage/egress-serve.js";
import { UnifiedStore } from "../src/storage/store.js";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-hermetic-"));
process.env.BILI_CONFIG_FILE = join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const M = (id: string, text: string, role: string = "user") => ({ id, role, contentType: "text", text });

test("recording is content-table-free: rows carry bytes, content stays empty, replay is byte-equal", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
        migrateSchema(db);
        const sid = "sess-egress-selfcontained";

        const ops: EgressOpLogStore = {
            egressAppendTurn: (s, o, baseSeq, nowMs) => store.egressAppendTurn(s, o, baseSeq, nowMs),
            egressStateView: (s) => store.egressStateView(s),
            egressStateViewAt: (s, x) => store.egressStateViewAt(s, x),
            egressStateMaxSeq: (s) => store.egressStateMaxSeq(s),
            egressStateTruncateAfter: (s, x) => store.egressStateTruncateAfter(s, x),
            egressFlowWalkBack: (s) => store.egressFlowWalkBack(s),
        };
        // turn 1: two messages; turn 2: tail append + fold shape; turn 3: an edit
        let view = recordEgressTurn({ store: ops, sessionId: sid, prev: undefined, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 1000 });
        view = recordEgressTurn({ store: ops, sessionId: sid, prev: view, conversation: [M("m1", "alpha"), { id: "acp_summary_1", role: "system", contentType: "text", text: "<summary>beta</summary>" }], systemText: "sys", nowMs: 2000 });
        view = recordEgressTurn({ store: ops, sessionId: sid, prev: view, conversation: [M("m1", "alpha!"), { id: "acp_summary_1", role: "system", contentType: "text", text: "<summary>beta</summary>" }], systemText: "sys", nowMs: 3000 });
        assert.ok(view.every((r) => typeof r.bytes === "string" && r.bytes.length > 0), "every row carries its bytes inline");
        const rebuilt = rebuildCoreFromLog(view);
        assert.ok(rebuilt !== null, "the in-turn view rebuilds");
        assert.equal(JSON.stringify(rebuilt), JSON.stringify([M("m1", "alpha!"), { id: "acp_summary_1", role: "system", contentType: "text", text: "<summary>beta</summary>" }]), "rebuilt core equals the recorded conversation");

        // the replayed (table) view is byte-equal to the in-turn view
        const fromTable = egressStateView(db, sid);
        assert.deepEqual(fromTable.map((r) => [r.msgid, r.bytes]), view.map((r) => [r.msgid, r.bytes]), "table replay is byte-equal");

        // THE self-containment claim: three turns of recording + fold +
        // edit appended NOTHING to the content table.
        const contentRows = (db.prepare("SELECT count(*) AS n FROM content").get() as { n: number }).n;
        assert.equal(contentRows, 0, "the content table stayed untouched — the op-log is self-contained");
    } finally {
        // Windows locks open SQLite files: release the handle before the
        // cleanup, then retry the unlink (same pattern as egress-state.test.ts).
        try { store.close(); } catch { /* already closed */ }
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch { /* leaked temp dir on a Windows runner is harmless */ }
    }
});

test("deleteSession cascades egress_state/egress_flow (plain rows, no CAS to release)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-egress-lifecycle-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const db = (store as unknown as { db: ReturnType<typeof openSqliteDatabase>["db"] }).db;
        migrateSchema(db);
        const sid = "sess-egress-cascade";

        egressStateAppend(db, sid, [
            { type: "I", msgid: "m1", after: null, ref: "", tokens: 5, typeTag: "text", bytes: '{"id":"m1","role":"user","text":"alpha"}', role: "user" },
            { type: "I", msgid: "m2", after: "m1", ref: "", tokens: 5, typeTag: "text", bytes: '{"id":"m2","role":"user","text":"beta"}', role: "user" },
            { type: "D", start: "m1", end: "m1" },
            { type: "U", msgid: "m2", bytes: '{"id":"m2","role":"user","text":"beta!"}', role: "user" },
        ], Date.now());
        const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        assert.equal(count("egress_flow"), 4, "the flow keeps every op (append-only)");
        assert.equal(count("egress_state"), 1, "the state plane is materialized — the live rows only (7773)");
        const v = egressStateView(db, sid);
        assert.deepEqual(v.map((r) => r.msgid), ["m2"]);
        assert.equal(v[0].bytes, '{"id":"m2","role":"user","text":"beta!"}', "the +U replaced the bytes in place");

        store.deleteSession(sid);

        assert.equal(count("egress_state"), 0, "egress_state rows cascade-deleted");
        assert.equal(count("egress_flow"), 0, "egress_flow rows cascade-deleted");
    } finally {
        try { store.close(); } catch { /* already closed */ }
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch { /* leaked temp dir on a Windows runner is harmless */ }
    }
});
