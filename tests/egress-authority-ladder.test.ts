import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressStateAppend, egressStateAt, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, recoverEgressBase, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { egressAuthorityProbe } from "../src/server/prepare-openai.ts";
import type { BiliMessage } from "acp-kernel/wire";

const S = "sess-authority";
const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });

function open() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-authority-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store: EgressOpLogStore = {
        egressStateAppendOps: (sid, ops, nowMs) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateCompactView: (sid, view, nowMs) => db.prepare(`SELECT 1`).get() ? 0 : 0,
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(log_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND log_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND log_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
    return { db, store, dir };
}

test("recoverEgressBase: healthy flow returns the current point (no degrade, no truncation)", () => {
    const H = open();
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        const got = recoverEgressBase(H.store, S);
        assert.ok(got !== null, "a healthy flow always recovers");
        assert.equal(got.degraded, false);
        assert.equal(got.truncated, 0);
        assert.equal(got.seq, 3, "system I + m1 I (turn 1) + m2 I (turn 2)");
        assert.equal(got.view.length, 3, "system + m1 + m2");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("recoverEgressBase: corrupt tail walks back to the newest healthy point and truncates past it", () => {
    const H = open();
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // structurally corrupt the newest row (log_seq 3 = m2's I op) in BOTH tables
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND log_seq = 3`).run('{"x":1}', S);
        H.db.prepare(`UPDATE egress_state SET payload = ? WHERE session_id = ? AND log_seq = 3`).run('{"x":1}', S);
        const got = recoverEgressBase(H.store, S);
        assert.ok(got !== null);
        assert.equal(got.degraded, true);
        assert.equal(got.seq, 2, "newest healthy point = before the corrupt row");
        assert.equal(got.truncated, 2, "corrupt row removed from BOTH tables");
        assert.equal(H.store.egressStateMaxSeq(S), 2, "flow max collapsed to the healthy point");
        // healthy replay still works and records can continue after recovery
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: got.view, conversation: [M("m1", "alpha"), M("m3", "gamma")], systemText: "sys", nowMs: 3 });
        assert.equal(view.length, 3, "system + m1 + m3 after recovery");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("recoverEgressBase: no healthy point at all returns null (session-level recovery)", () => {
    const H = open();
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // structurally corrupt EVERY op row in both tables => the only healthy
        // point is the empty flow (seq 0) = the bootstrap point
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        H.db.prepare(`UPDATE egress_state SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        const got = recoverEgressBase(H.store, S);
        assert.ok(got !== null, "the empty flow is always a valid recovery point");
        assert.equal(got.degraded, true);
        assert.equal(got.seq, 0, "recovered to the bootstrap point");
        assert.equal(got.view.length, 0);
        assert.equal(H.store.egressStateMaxSeq(S), 0, "flow collapsed to empty");
        // the next turn re-records the full batch (self-heal)
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: got.view, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 3 });
        assert.equal(view.length, 2, "bootstrap re-record: system + m1");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

const quiet = () => {};

test("egressAuthorityProbe: identity + order + sampled-byte rows (#3617 both directions)", () => {
    const base = [M("m1", "alpha"), M("m2", "beta"), M("m3", "gamma")];
    // unchanged client resend => pass
    assert.equal(egressAuthorityProbe(base, [base[0], base[1], base[2], M("m4", "delta")], S, quiet), true, "identical rows + fresh tail pass");
    // reordered client row => fail (legacy this turn)
    assert.equal(egressAuthorityProbe(base, [base[1], base[0], base[2]], S, quiet), false, "reorder fails the probe");
    // byte divergence under a stable msgid => STILL passes (server bytes win; divergence is logged, not fatal)
    assert.equal(egressAuthorityProbe(base, [base[0], M("m2", "tampered beta"), base[2]], S, quiet), true, "divergence is non-fatal (ruling 7439-5: server wins)");
    // pure fresh tail (empty base ids in client) => pass
    assert.equal(egressAuthorityProbe(base, [M("m9", "fresh")], S, quiet), true, "all-fresh client rows pass");
});
