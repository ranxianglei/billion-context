import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressAppendTurn, egressFlowWalkBack, egressMaterializeState, egressStateAt, egressStateRead, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, recoverEgressBase, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { EgressAuthorityRejectError } from "../src/storage/egress-record.ts";
import { egressAuthorityProbe, recordAuthorityTurn, resolveEgressAuthority } from "../src/server/egress-lane-io.ts";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";

const S = "sess-authority";
const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });

function open() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-authority-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store: EgressOpLogStore = {
        egressAppendTurn: (sid, ops, baseSeq, nowMs) => egressAppendTurn(db, sid, ops, nowMs, { baseSeq }),
        egressStateView: (sid) => egressStateRead(db, sid),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            egressMaterializeState(db, sid, egressStateAt(db, sid, seq), Date.now());
            return Number(b.changes);
        },
        egressFlowWalkBack: (sid) => egressFlowWalkBack(db, sid),
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

test("recoverEgressBase: an unreplayable tail walks back to the newest healthy point and truncates past it", () => {
    const H = open();
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 2 });
        // damage the newest point so the serving read notices AND the
        // full-history replay fails: the newest flow row (op_seq 3 = m2's
        // I op — log_seq is the kernel citation number 2, op_seq is the
        // dense row order) gets a payload that does not parse, and a stray
        // state row without an I twin forces the read onto the rebuild path
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND op_seq = 3`).run('{"x":1}', S);
        H.db.prepare(`INSERT INTO egress_state (session_id, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, 'ghost', 99, 7, 7, '', 0, 'text', 'user', 0, 0, 'x', 9)`).run(S);
        const got = recoverEgressBase(H.store, S);
        assert.ok(got !== null);
        assert.equal(got.degraded, true);
        assert.equal(got.seq, 2, "newest healthy point = before the corrupt row");
        assert.equal(got.truncated, 1, "the corrupt row was removed from the flow; the state is re-materialized from the surviving prefix");
        assert.equal(H.store.egressStateMaxSeq(S), 2, "flow max collapsed to the healthy point");
        const stateIds = (H.db.prepare(`SELECT msgid FROM egress_state WHERE session_id = ? ORDER BY pos`).all(S) as { msgid: string }[]).map((r) => r.msgid);
        assert.deepEqual(stateIds, ["egress-system", "m1"], "the state is re-materialized clean — the ghost is gone");
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
        // structurally corrupt EVERY flow row AND drop the whole state: the
        // serving read hits the twin check (flow has rows, state is empty),
        // the rebuild replay meets the damaged first row, and the single
        // walk-back pass finds no healthy non-empty prefix. A session that
        // HAS rows and no healthy point is whole-flow-unreadable: the ladder
        // must return null so the caller hard-fails — never client bytes
        // (ruling 7439-5; the old empty-floor escape let the seam re-record
        // them, #7574).
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        H.db.prepare(`DELETE FROM egress_state WHERE session_id = ?`).run(S);
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

test("egress-lane-io: authority seam records first, then serves the written view (#7439-4, P1-1 regression)", () => {
    const H = open();
    const session = { metadata: {} } as unknown as Session;
    try {
        const c1 = [M("m1", "alpha"), M("m2", "beta")];
        // turn 1 (bootstrap): empty flow → client bytes are recorded once
        const a1 = resolveEgressAuthority({ session, st: H.store, sessionId: S, core: c1, log: quiet, armed: true });
        assert.equal(a1.bootstrapping, true, "row-less session is the turn-1 bootstrap");
        assert.equal(a1.swappedCore, null);
        const t1 = recordAuthorityTurn(H.store, S, a1, "sys", quiet);
        assert.ok(t1 !== null, "a bootstrap turn serves the client core");
        assert.deepEqual(t1.map((m) => m.id), ["m1", "m2"], "core rows only — the system row stays out");
        assert.equal(t1[0].text, "alpha");
        assert.equal(session.metadata["egressAuthority"], true, "the KDD#23 latch is set on the first armed turn");
        const rowsBefore = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        // turn 2 (swapped): unchanged echo + ONE new message — the served
        // core must already contain this turn's message (record-first), and
        // the flow must keep appending (pre-fix serve-before-record dropped
        // it and froze the flow on a zero-op diff)
        const c2 = [M("m1", "alpha"), M("m2", "beta"), M("m3", "gamma")];
        const a2 = resolveEgressAuthority({ session, st: H.store, sessionId: S, core: c2, log: quiet, armed: true });
        assert.equal(a2.bootstrapping, false, "a non-empty flow is never bootstrap again");
        assert.ok(a2.swappedCore !== null, "a healthy flow with a passing probe swaps");
        const t2 = recordAuthorityTurn(H.store, S, a2, "sys", quiet);
        assert.ok(t2 !== null, "turn 2 serves");
        assert.deepEqual(t2.map((m) => m.id), ["m1", "m2", "m3"], "the served core contains THIS turn's new message");
        const rowsAfter = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        assert.ok(rowsAfter.n > rowsBefore.n, `the flow keeps appending — it is not frozen (before: ${rowsBefore.n}, after: ${rowsAfter.n})`);
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("egress-lane-io: probe failure degrades to legacy — flow NOT advanced (#3617 both directions)", () => {
    const H = open();
    const session = { metadata: {} } as unknown as Session;
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha"), M("m2", "beta")], systemText: "sys", nowMs: 1 });
        const rowsBefore = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        void view;
        // reordered client rows → probe fails → legacy: no swap, no record
        const a = resolveEgressAuthority({ session, st: H.store, sessionId: S, core: [M("m2", "beta"), M("m1", "alpha")], log: quiet, armed: true });
        assert.equal(a.bootstrapping, false);
        assert.equal(a.swappedCore, null, "probe failure keeps the client core");
        assert.equal(recordAuthorityTurn(H.store, S, a, "sys", quiet), null, "legacy serves nothing from the seam");
        const rowsAfter = H.db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number };
        assert.equal(rowsAfter.n, rowsBefore.n, "the flow did NOT advance on untrusted bytes");
        // ...and the re-attempt with a well-formed echo DOES swap (gate opens again)
        const ok = resolveEgressAuthority({ session, st: H.store, sessionId: S, core: [M("m1", "alpha"), M("m2", "beta"), M("m3", "gamma")], log: quiet, armed: true });
        assert.ok(ok.swappedCore !== null, "a conforming next turn swaps again");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

test("egress-lane-io: no healthy point → hard fail + egressFlowUnreadable latch (ruling 7439-5)", () => {
    const H = open();
    const session = { metadata: {} } as unknown as Session;
    try {
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: [M("m1", "alpha")], systemText: "sys", nowMs: 1 });
        void view;
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":1}', S);
        H.db.prepare(`DELETE FROM egress_state WHERE session_id = ?`).run(S);
        assert.throws(() => resolveEgressAuthority({ session, st: H.store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true }), EgressAuthorityRejectError, "unreadable flow never degrades to client bytes");
        assert.equal(session.metadata["egressFlowUnreadable"], true, "the operator-recovery latch is set");
        // #7574: a retry of the latched session fails at once — no replay
        // pass is repeated on every request.
        H.db.prepare(`UPDATE egress_flow SET payload = ? WHERE session_id = ? AND row_type != 'D'`).run('{"x":2}', S);
        assert.throws(() => resolveEgressAuthority({ session, st: H.store, sessionId: S, core: [M("m1", "alpha")], log: quiet, armed: true }), EgressAuthorityRejectError, "a latched session keeps failing until an operator resets the log");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});
