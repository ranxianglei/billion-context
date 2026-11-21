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

test("recoverEgressBase: no healthy point at all returns null (hard fail, ruling 7439-5)", () => {
    const H = open();
    try {
        // a ROW-LESS session is the one legitimate empty-flow case (turn-1 bootstrap)
        const fresh = recoverEgressBase(H.store, "sess-empty");
        assert.ok(fresh !== null && fresh.view.length === 0 && fresh.seq === 0 && fresh.degraded === false, "row-less session recovers to the clean bootstrap point");
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // structurally corrupt EVERY op row in both tables => every prefix
        // replay throws, including the empty floor. A session that HAS rows
        // and no healthy non-empty point is whole-flow-unreadable: the
        // ladder must return null so the caller hard-fails — the old
        // empty-floor escape let the seam re-record client bytes (#7439-5).
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        H.db.prepare(`UPDATE egress_state SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        const got = recoverEgressBase(H.store, S);
        assert.equal(got, null, "rows present + no healthy point => null (hard fail, never client bytes)");
        assert.equal(H.store.egressStateMaxSeq(S), 3, "nothing truncated — the corrupt rows stay for the operator");
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

import { serveLaneTurn, recordLaneTurn, rebuildLaneCore } from "../src/server/egress-lane-io.ts";

test("egress-lane-io: serveLaneTurn records first, then serves the written view (#7439-4, P1-1 regression)", () => {
    const H = open();
    try {
        // empty flow => nothing to rebuild (bootstrap turn records instead)
        assert.equal(rebuildLaneCore(H.store, S, quiet), null, "empty flow serves nothing");
        // turn 1: recorded AND served in the same call — the served core
        // must already contain this turn's messages (record-first)
        const t1 = serveLaneTurn({ st: H.store, sessionId: S, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", log: quiet });
        assert.ok(t1 !== null, "a recorded flow serves");
        assert.deepEqual(t1.map((m) => m.id), ["m1", "m2"], "core rows only — the system row stays out");
        assert.equal(t1[0].text, "alpha");
        const rowsBefore = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        // turn 2: the NEW message must ride out (pre-fix serve-before-record
        // dropped it and froze the flow on a zero-op diff)
        const t2 = serveLaneTurn({ st: H.store, sessionId: S, conversation: [M("m1", "alpha"), M("m2", "beta"), M("m3", "gamma")], systemText: "sys", log: quiet });
        assert.ok(t2 !== null, "turn 2 serves");
        assert.deepEqual(t2.map((m) => m.id), ["m1", "m2", "m3"], "the served core contains THIS turn's new message");
        const rowsAfter = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        assert.ok(rowsAfter.n > rowsBefore.n, `the flow keeps appending — it is not frozen (before: ${rowsBefore.n}, after: ${rowsAfter.n})`);
        // a single corrupt tail row does NOT degrade — the ladder walks back
        // and truncates, then serves the newest healthy point. Target the ACTUAL
        // max log_seq (a hardcoded 5 no-ops when the flow has 4 rows: the
        // UPDATE matches nothing and the healthy flow serves unchanged).
        const maxSeq = (H.db.prepare("SELECT MAX(log_seq) AS x FROM egress_flow WHERE session_id = ?").get(S) as { x: number }).x;
        assert.ok(maxSeq >= 4, `the flow has the expected tail (max_seq: ${maxSeq})`);
        H.db.prepare("UPDATE egress_flow SET payload = ? WHERE session_id = ? AND log_seq = ?").run('{"x":1}', S, maxSeq);
        H.db.prepare("UPDATE egress_state SET payload = ? WHERE session_id = ? AND log_seq = ?").run('{"x":1}', S, maxSeq);
        const partial = rebuildLaneCore(H.store, S, quiet);
        assert.ok(partial !== null, "ladder recovery still serves the healthy point");
        assert.deepEqual(partial.map((m) => m.id), ["m1", "m2"], "served core = the healthy point (m3 row truncated away)");
        // total corruption (no healthy point) => the lane rebuild returns
        // null; the pinned seam hard-fails the turn on that (ruling 7439-5)
        H.db.prepare("UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'").run('{"x":1}', S);
        H.db.prepare("UPDATE egress_state SET payload = ? WHERE session_id = ? AND row_type != 'D'").run('{"x":1}', S);
        assert.equal(rebuildLaneCore(H.store, S, quiet), null, "no healthy point => null (the seam hard-fails; never throws)");
        void recordLaneTurn;
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});
