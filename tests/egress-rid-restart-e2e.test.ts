/**
 * E2E — server restart + client restart: the rid keeps auto-incrementing and
 * the 2026-11-28 incident class (permanent egress stop after a client
 * restart) is structurally impossible (2026-11-28 owner ruling,
 * discussions/7903, PR #7910).
 *
 * The incident, step by step (session 01a2222a, owner's box):
 *   1. a turn with a MULTI-PART assistant message (reasoning + text → two
 *      rows under one element msgid) was recorded;
 *   2. the client restarted (its in-memory pf state died) and resends the
 *      FULL conversation; the server cold-loaded from disk in between;
 *   3. the first diff turn after the restart stamped a kernel citation
 *      number onto a live row that already owned it → the batch was
 *      refused → and because the identical diff repeats every turn, the
 *      egress record FROZE for the rest of the session.
 *
 * This test replays exactly that shape — multi-part turn, server restart
 * (store close + cold load in the SAME directory), client restart (full
 * resend), then a FOLD after the restart — and pins the contract the
 * owner ruled:
 *   - existing rows keep their rids across the restart (no renumbering);
 *   - new rows take fresh rids strictly above the pre-restart frontier
 *     (numbering continues auto-incrementing);
 *   - a fold after the retart takes a FRESH rid (the retired range stays
 *     spent);
 *   - nothing throws: the old "cited number ... already live" deadlock is
 *     gone — rids are self-issued, one-shot, and no external number can
 *     collide with a live row anymore.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { recordEgressTurn, type EgressSourceMsg } from "../src/storage/egress-record.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-rid-restart-"));
process.env.BILI_CONFIG_FILE = path.join(dir, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_TEST_FORCE_FULL_DDL = "1";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
process.env.BILI_PERSIST_ZSTD = "0";

const SID = "sess-rid-restart";
const M = (id: string, text: string, role = "user", contentType?: string) =>
    ({ id, role, text, ...(contentType ? { contentType } : {}) }) as EgressSourceMsg;

test("restart both endpoints: rids continue auto-incrementing; the incident shape (multi-part + restart + fold) never freezes", { timeout: 60_000 }, () => {
    setRegistryForTest({});
    const openStores: SessionStore[] = [];
    try {
        // ================= phase 1 — the live session =================
        const store1 = new SessionStore({ dir: path.join(dir, "sessions"), enabled: true, debounceMs: 15 });
        openStores.push(store1);
        _setStoreForTest(store1);
        const st1 = store1.egressOpLogStore();
        assert.ok(st1, "unified egress op-log store present");

        // turn 1: a user message + a MULTI-PART assistant reply (the
        // incident shape: reasoning + text under one element msgid "a1").
        const t1 = [
            M("u1", "hello"),
            M("a1", "the answer", "assistant"),
            M("a1#p1", "reasoning…", "assistant"),
        ];
        let view = recordEgressTurn({ store: st1, sessionId: SID, prev: undefined, conversation: t1, systemText: "SYS", nowMs: 1_000 });
        assert.deepEqual(view.map((r) => [r.msgid, r.rid]), [
            ["egress-system", 1], ["u1", 2], ["a1", 3], ["a1", 4],
        ], "turn 1: system + user + two parts of the assistant element (shared element msgid, Path A), rids dense from 1");

        // turn 2: the tail grows (the client is still alive here)
        const t2 = [...t1, M("u2", "more")];
        view = recordEgressTurn({ store: st1, sessionId: SID, prev: view, baseSeq: st1.egressStateMaxSeq(SID), conversation: t2, systemText: "SYS", nowMs: 2_000 });
        assert.deepEqual(view.map((r) => r.rid!), [1, 2, 3, 4, 5], "turn 2: u2 takes rid 5");
        const preRestart = view.map((r) => [r.msgid, r.rid, r.bytes] as const);
        const frontierBefore = st1.egressStateMaxRid?.(SID) ?? Math.max(...view.map((r) => r.rid!));
        assert.equal(frontierBefore, 5);

        // ============ phase 2 — the SERVER restarts ====================
        // The process dies: every in-memory view, cursor and ledger is
        // gone; only the on-disk tables survive. A new process opens the
        // SAME directory (cold load).
        store1.closeQuietly();
        openStores.splice(openStores.indexOf(store1), 1);
        const store2 = new SessionStore({ dir: path.join(dir, "sessions"), enabled: true, debounceMs: 15 });
        openStores.push(store2);
        _setStoreForTest(store2);
        const st2 = store2.egressOpLogStore();
        assert.ok(st2, "the restarted server exposes the egress op-log store");

        // the cold-loaded view is byte-identical to the pre-restart one —
        // nothing was renumbered, nothing was re-issued
        const reloaded = st2.egressStateView(SID);
        assert.deepEqual(reloaded.map((r) => [r.msgid, r.rid, r.bytes] as const), preRestart, "server restart: the view comes back from disk, rows keep their rids");

        // ============ phase 3 — the CLIENT restarts ====================
        // The client lost its in-memory state and resends the FULL
        // conversation (no pf headers), now with a fresh message at the
        // tail. The prepare layer reads `prev` from the store — exactly
        // like recordAuthorityTurn does.
        const t3 = [...t2, M("u3", "after the client restarted")];
        const prevAfterRestart = st2.egressStateView(SID);
        view = recordEgressTurn({
            store: st2, sessionId: SID, prev: prevAfterRestart, baseSeq: st2.egressStateMaxSeq(SID),
            conversation: t3, systemText: "SYS", nowMs: 3_000,
        });
        assert.deepEqual(view.map((r) => r.rid!), [1, 2, 3, 4, 5, 6], "client restart: u3 takes rid 6 — numbering CONTINUED across both restarts");
        assert.equal(view.filter((r) => r.rid! <= 5).every((r) => r.bytes === preRestart.find((p) => p[1] === r.rid)![2]), true, "pre-restart rows are byte-identical (no renumber, no rewrite)");

        // ============ phase 4 — a FOLD after the restart ==============
        // The incident's fatal combo: fold + restarted endpoints. The
        // summary takes a FRESH rid above the frontier; the retired range
        // (2..4) stays spent forever.
        const t4 = [M("u1", "hello"), M("sum", "Folded the early exchange", "assistant", "acp_summary"), M("u3", "after the client restarted")];
        view = recordEgressTurn({ store: st2, sessionId: SID, prev: view, baseSeq: st2.egressStateMaxSeq(SID), conversation: t4, systemText: "SYS", nowMs: 4_000 });
        const sumRow = view.find((r) => r.msgid === "sum");
        assert.ok(sumRow, "the fold recorded its summary row");
        assert.equal(sumRow!.rid!, 7, "the summary takes the next FRESH rid (frontier was 6)");
        assert.deepEqual(view.map((r) => r.msgid), ["egress-system", "u1", "sum", "u3"], "the folded range is gone from the live view; its rids are retired");

        // and the numbering still auto-increments past the fold
        const t5 = [...t4, M("u4", "one more")];
        view = recordEgressTurn({ store: st2, sessionId: SID, prev: view, baseSeq: st2.egressStateMaxSeq(SID), conversation: t5, systemText: "SYS", nowMs: 5_000 });
        assert.deepEqual(view.map((r) => r.rid!), [1, 2, 7, 6, 8], "post-fold: u4 takes rid 8 — the retired 3/4 are never re-issued");

        // the model-visible tag is derived from the rid at render time —
        // the kernel and the egress plane share ONE number by
        // construction (this is what the dead cited-number path could
        // never guarantee).
        const tag = (r: { rid?: number }) => "m" + String(r.rid).padStart(5, "0");
        assert.equal(tag(sumRow!), "m00007", "the model would see the summary as m00007");
    } finally {
        for (const s of openStores) s.closeQuietly();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep on failure */ }
    }
});
