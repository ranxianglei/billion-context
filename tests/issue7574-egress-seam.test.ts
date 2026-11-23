// #7574 (review of PR #6785), the authority seam between the lanes and the
// outbound op log — checked against an in-memory store so every branch can be
// reached:
//   - a session whose log is the authority and is unreadable fails at once
//     and is remembered (latched): the next request must NOT scan the log
//     again (it used to replay up to 17 points on every request);
//   - after the operator resets the log the latch clears and the session
//     bootstraps again;
//   - a session that is NOT on the log (plain proxy, or a plugin turn without
//     a pin) is served normally when the log is unreadable — before, it was
//     failed with 500 on three of the four wires;
//   - a turn that lost the race against another request on the same session
//     is served, not recorded, not failed;
//   - one arming rule for all four lanes.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { EgressConcurrentWriteError, EgressStateCorruptError, egressReplay, type EgressOp, type EgressViewRow } from "../src/storage/egress-state.ts";
import { EgressAuthorityRejectError, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { egressAuthorityArmed, egressTinyBudget, recordAuthorityTurn, resolveEgressAuthority } from "../src/server/egress-lane-io.ts";

process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";

class MemStore implements EgressOpLogStore {
    unreadable = false;
    race = false;
    rows: EgressViewRow[] = [];
    seq = 0;
    reads = 0;
    scans = 0;
    truncations = 0;
    egressAppendTurn(sessionId: string, ops: EgressOp[], baseSeq: number): EgressViewRow[] {
        if (this.race) throw new EgressConcurrentWriteError(sessionId, baseSeq, baseSeq + 2);
        this.seq += ops.length;
        this.rows = egressReplay(this.rows, ops, undefined, sessionId);
        return this.rows;
    }
    egressStateView(): EgressViewRow[] {
        this.reads++;
        if (this.unreadable) throw new EgressStateCorruptError("s", "payload at op_seq=3 is not an object");
        return this.rows;
    }
    egressStateViewAt(): EgressViewRow[] {
        this.scans++;
        throw new EgressStateCorruptError("s", "payload at op_seq=3 is not an object");
    }
    egressStateMaxSeq(): number {
        return this.unreadable ? 3 : this.seq;
    }
    egressStateTruncateAfter(): number {
        this.truncations++;
        return 0;
    }
}

const M = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text });
const CORE = [M("a", "1"), M("b", "2"), M("c", "3")];

test("an authority session with an unreadable log fails at once, is remembered, and starts over after a reset", () => {
    const st = new MemStore();
    st.unreadable = true;
    const session = { metadata: {} } as Session;
    const lines: string[] = [];
    const log = (_lvl: string, m: string) => { lines.push(m); };

    // 1. the log cannot be read anywhere: the turn fails (ruling 7439-5 kept)
    assert.throws(
        () => resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log, armed: true }),
        (e: unknown) => e instanceof EgressAuthorityRejectError && /no healthy op-log point/.test(e.message),
    );
    assert.equal(session.metadata["egressFlowUnreadable"], true, "the session is latched");
    assert.equal(session.metadata["egressAuthority"], undefined, "a session that never reached a healthy point is not marked as the authority");
    const scansAfterFailure = st.scans;
    assert.ok(scansAfterFailure > 0, "the first failure looked for a healthy point");
    const readsAfterFailure = st.reads;

    // 2. the next request fails again WITHOUT touching the log
    assert.throws(() => resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log, armed: true }), EgressAuthorityRejectError);
    assert.equal(st.reads, readsAfterFailure, "no read");
    assert.equal(st.scans, scansAfterFailure, "no walk-back");

    // 3. the operator resets the log: the latch clears and the session bootstraps again
    st.unreadable = false;
    const out = resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log, armed: true });
    assert.deepEqual(out, { base: [], baseSeq: 0, bootstrapping: true, swappedCore: null, recordCore: CORE });
    assert.equal(session.metadata["egressFlowUnreadable"], undefined, "latch cleared");
    assert.ok(lines.some((l) => l.includes("op log was reset")), `the reset is logged (log: ${lines.slice(-3).join(" | ")})`);
    const served = recordAuthorityTurn(st, "s", out, "sys", log);
    assert.deepEqual(served, CORE, "the bootstrap turn serves the client's conversation");
    assert.ok(st.rows.length > 0 && st.seq > 0, "and records it");
    assert.equal(session.metadata["egressAuthority"], true, "the session is the authority from its first healthy point on");
});

test("a session that is not on the log keeps working when the log is unreadable", () => {
    const st = new MemStore();
    st.unreadable = true;
    const session = { metadata: {} } as Session;
    const lines: string[] = [];
    const log = (_lvl: string, m: string) => { lines.push(m); };
    const out = resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log, armed: false });
    assert.deepEqual(out, { base: [], baseSeq: 0, bootstrapping: false, swappedCore: null, recordCore: null });
    assert.equal(session.metadata["egressFlowUnreadable"], undefined, "a record-only session is never latched");
    assert.equal(st.reads, 1, "the damaged log is opened exactly once — enough to know it cannot be used");
    assert.equal(st.scans, 0, "no walk-back: a mirror log is never repaired by deleting rows");
    assert.equal(st.truncations, 0, "nothing was deleted");
    assert.equal(recordAuthorityTurn(st, "s", out, "sys", log), null, "nothing to record — the lane keeps its own outbound");
    assert.ok(lines.some((l) => l.includes("turn not recorded")), `the skip is logged (log: ${lines.slice(-3).join(" | ")})`);
});

test("a healthy log + a session that is not on it: the turn is recorded, the outbound is the lane's own", () => {
    const st = new MemStore();
    const session = { metadata: {} } as Session;
    const quiet = () => undefined;
    // the operator reset the log while the session was not loaded: no rows, no latch to clear
    session.metadata["egressFlowUnreadable"] = true;
    const out = resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log: quiet, armed: false });
    assert.equal(session.metadata["egressFlowUnreadable"], undefined, "a latch without a log is stale");
    assert.equal(out.swappedCore, null, "no swap — the client's bytes stay the lane's input");
    assert.deepEqual(out.recordCore, CORE, "but the turn is recorded");
    assert.equal(recordAuthorityTurn(st, "s", out, "sys", quiet), null, "the lane keeps its own outbound");
    assert.deepEqual(st.rows.map((r) => r.msgid), ["egress-system", "a", "b", "c"]);
});

test("another request on the same session recorded first: this turn is served, not recorded, not failed", () => {
    const st = new MemStore();
    const session = { metadata: {} } as Session;
    const quiet = () => undefined;
    recordAuthorityTurn(st, "s", resolveEgressAuthority({ session, st, sessionId: "s", core: CORE, log: quiet, armed: true }), "sys", quiet);
    const lines: string[] = [];
    const log = (_lvl: string, m: string) => { lines.push(m); };
    // turn 2 started from turn 1's view, but another request wrote in between
    st.race = true;
    const next = [...CORE, M("d", "4")];
    const out = resolveEgressAuthority({ session, st, sessionId: "s", core: next, log, armed: true });
    assert.deepEqual(out.swappedCore?.map((m) => m.id), ["a", "b", "c", "d"], "the three known rows come from the log, the new one from the client");
    assert.equal(out.swappedCore?.[3], next[3], "the new message is the client's object, untouched");
    const served = recordAuthorityTurn(st, "s", out, "sys", log);
    assert.deepEqual(served?.map((m) => m.id), ["a", "b", "c", "d"], "the turn is served with the new message");
    assert.ok(lines.some((l) => l.includes("recorded first")), `the race is named in the log (log: ${lines.slice(-3).join(" | ")})`);
    assert.equal(st.rows.length, 4, "nothing was written on top of the other request's turn");
});

test("one arming rule for the four lanes: plane on, plugin lane, pinned, not a side request", () => {
    const armed = (pluginMode: boolean, pinned: boolean, sideRequest: boolean) => egressAuthorityArmed({ pluginMode, pinned, sideRequest });
    assert.equal(armed(true, true, false), true);
    assert.equal(armed(false, true, false), false, "a plain proxy session is never on the log");
    assert.equal(armed(true, false, false), false, "a plugin turn without a pin has no server-side identity");
    assert.equal(armed(true, true, true), false, "a title request (or any side request) never touches the log");
    delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
    assert.equal(armed(true, true, false), false, "plane off: nothing arms");
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
});

test("the side-request budget test for lanes without a title flag", () => {
    assert.equal(egressTinyBudget({ max_tokens: 100 }), true);
    assert.equal(egressTinyBudget({ max_tokens: 201 }), false);
    assert.equal(egressTinyBudget({ max_tokens: 0 }), false);
    assert.equal(egressTinyBudget({}), false);
    assert.equal(egressTinyBudget("not an object"), false);
});
