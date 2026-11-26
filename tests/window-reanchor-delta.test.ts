/**
 * #7474 window re-anchor delta: the pf-window lane persists only the tail
 * WINDOW every HIT turn, so planIngestDelta's strict-append assumption
 * (the tail extends the trusted prefix) is structurally false — equal /
 * sliding / shrinking windows refuse at the gate and the full ingest paid
 * O(all session rows) per HIT turn to re-derive identity→seq. The re-anchor
 * path resolves every window row by ONE indexed identity point lookup
 * instead: existing rows keep their seq, new rows continue after max(seq),
 * tailSeqs become the window's absolute seqs in envelope order —
 * byte-identical to what the full path writes for a window plan. This suite
 * pins:
 *  1. the repro: a sliding window refuses planIngestDelta (pre-fix every
 *     HIT turn took the full path);
 *  2. seq stability across sliding windows (the D4-1 contract — same
 *     identity keeps its seq, no re-basing);
 *  3. new rows land at max(seq)+k with the watermark following the window
 *     tip;
 *  4. every doubt falls to the exact full path (unknown session = no
 *     anchor; a tombstoned window row = #4390 reactivation territory).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, planIngestDelta, planIngestReanchor, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "../kernel/src/types.js";

const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-reanchor-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const refToken = (i: number): string => `m${String(i + 1).padStart(5, "0")}`;

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

/** Envelope (folded-render) presentation of rows [from, to) plus the new
 *  row `to`: the pf-window shape — lastMessagesFolded, no raw tail. */
function mkWindow(id: string, from: number, toExclusive: number, folded: boolean): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const lastMessages: CoreMessage[] = [];
    for (let i = from; i <= toExclusive; i++) {
        const ref = refToken(i);
        byRaw[`h_msg${i}`] = ref;
        byRef[ref] = `h_msg${i}`;
        lastMessages.push(msg(i));
    }
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000 + toExclusive,
        meta: { protocol: "anthropic" },
        stats: { requests: toExclusive + 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw, byRef },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: folded,
        contentStore: { version: 1 as const, byHash: {} as Record<string, string>, byRef: {} as Record<string, unknown> },
    } as LegacySessionLike;
}

function mkRaw(id: string, count: number): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const lastMessages: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        const ref = refToken(i);
        byRaw[`h_msg${i}`] = ref;
        byRef[ref] = `h_msg${i}`;
        lastMessages.push(msg(i));
    }
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000 + count,
        meta: { protocol: "anthropic" },
        stats: { requests: count },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw, byRef },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
        contentStore: { version: 1 as const, byHash: {} as Record<string, string>, byRef: {} as Record<string, unknown> },
    } as LegacySessionLike;
}

interface Row {
    seq: number;
    msg_id: string;
    content_hash: string;
    retired_at: number | null;
}

function rows(store: UnifiedStore, sid: string): Row[] {
    return (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): unknown } } }).db
        .prepare("SELECT seq, msg_id, content_hash, retired_at FROM messages WHERE session_id = ?")
        .all(sid) as Row[];
}

test("#7474: sliding window refuses the delta gate and re-anchors by indexed identity", () => {
    const dir = tmpdir("bili-reanchor-");
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        const sid = "sess-window";
        // Turn 1: raw full view of 100 rows establishes the ledger.
        const t1 = mkRaw(sid, 100);
        assert.ok(store.ingestSession(planIngest(t1), undefined, { completeLog: true }));
        const base = rows(store, sid);
        assert.equal(base.length, 100);
        const seqOf = new Map(base.map((r) => [r.msg_id, r.seq]));

        // Turn 2: the HIT-turn window — rows 44..99 slide in PLUS new row
        // 100 (57 envelope rows, no raw tail). PRE-FIX repro: the delta
        // planner refuses this shape (equal-length / boundary gates), so
        // every HIT turn paid the O(all rows) full remap.
        const t2 = mkWindow(sid, 44, 100, true);
        const mark2 = store.ingestWatermark(sid)!;
        const boundary2 = store.probeIngestBoundary(sid, mark2.seq)!;
        assert.equal(
            planIngestDelta(t2, mark2.seq, mark2.tailSeqs, { msgId: boundary2.msgId, contentHash: boundary2.contentHash }, false),
            null,
            "sliding window must still refuse strict-append (the repro)",
        );
        const p2 = planIngestReanchor(t2);
        assert.ok(p2, "re-anchor planner accepts the window shape");
        assert.ok(
            store.ingestSession(p2, undefined, { completeLog: false }, { trustedTailSeqs: mark2.tailSeqs }),
            "re-anchor commit",
        );
        let cur = rows(store, sid);
        assert.equal(cur.length, 101, "only the ONE new row lands — no full rewrite");
        for (const r of cur) {
            if (r.msg_id !== "h_msg100") assert.equal(r.seq, seqOf.get(r.msg_id), `seq stability for ${r.msg_id}`);
        }
        seqOf.set("h_msg100", 100);
        let tail2 = store.tailSeqs(sid)!;
        assert.equal(tail2.length, 57, "tailSeqs = the window, in envelope order");
        assert.equal(tail2[0], seqOf.get("h_msg44"), "window head keeps its absolute seq");
        assert.equal(tail2[56], 100, "new row continues after max(seq)");
        assert.equal(store.ingestWatermark(sid)!.seq, 100, "watermark follows the window tip");

        // Turn 3: the window slides again (45..100 + new 101) — seqs must
        // stay put (D4-1) and the ledger grows by one.
        const t3 = mkWindow(sid, 45, 101, true);
        const mark3 = store.ingestWatermark(sid)!;
        assert.equal(mark3.seq, 100, "tip after the second window");
        const boundary3 = store.probeIngestBoundary(sid, mark3.seq)!;
        assert.equal(planIngestDelta(t3, mark3.seq, mark3.tailSeqs, { msgId: boundary3.msgId, contentHash: boundary3.contentHash }, false), null);
        const p3 = planIngestReanchor(t3)!;
        assert.ok(store.ingestSession(p3, undefined, { completeLog: false }, { trustedTailSeqs: mark3.tailSeqs }));
        cur = rows(store, sid);
        assert.equal(cur.length, 102);
        for (const r of cur) {
            if (r.msg_id !== "h_msg101") assert.equal(r.seq, seqOf.get(r.msg_id), `seq stability after second slide (${r.msg_id})`);
        }
        const tail3 = store.tailSeqs(sid)!;
        assert.equal(tail3[0], seqOf.get("h_msg45"));
        assert.equal(tail3[tail3.length - 1], 101);
        assert.equal(store.ingestWatermark(sid)!.seq, 101);
    } finally {
        store.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win */ }
    }
});

test("#7474: re-anchor refuses with nothing to anchor and with tombstoned window rows", () => {
    const dir = tmpdir("bili-reanchor-refuse-");
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        // Unknown session: every row is new → no anchor → refuse (the full
        // path must establish the rows, not the re-anchor). No session row
        // yet, so the trusted tail is empty.
        const fresh = mkWindow("sess-fresh", 0, 5, true);
        const pf = planIngestReanchor(fresh);
        assert.ok(pf);
        assert.ok(!store.ingestSession(pf, undefined, { completeLog: false }, { trustedTailSeqs: [] }), "no session row → refuse to the full path");
        assert.ok(store.ingestSession(planIngest(fresh), undefined, { completeLog: true }));

        // Tombstoned window row: #4390 rewind-redo territory — the full
        // path reactivates in place; a pointer at a retired seq would drop
        // the row from the view.
        const sid = "sess-tomb";
        const t1 = mkRaw(sid, 10);
        assert.ok(store.ingestSession(planIngest(t1), undefined, { completeLog: true }));
        (store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
            .prepare("UPDATE messages SET retired_at = ? WHERE session_id = ? AND msg_id = ?")
            .run(Date.now(), sid, "h_msg8");
        const t2 = mkWindow(sid, 5, 10, true);
        const mark = store.ingestWatermark(sid)!;
        const p2 = planIngestReanchor(t2)!;
        assert.ok(!store.ingestSession(p2, undefined, { completeLog: false }, { trustedTailSeqs: mark.tailSeqs }), "tombstone must fall to the full path");
        // And the full path still heals (reactivates) it — the COMPLETE raw
        // view, so the sweep has nothing legitimate to retire.
        assert.ok(store.ingestSession(planIngest(mkRaw(sid, 11)), undefined, { completeLog: true }));
        assert.ok(rows(store, sid).every((r) => r.retired_at === null));
    } finally {
        store.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win */ }
    }
});
