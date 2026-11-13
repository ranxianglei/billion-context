import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage } from "acp-kernel";

// #4730 (P1 data-loss): the fork endpoint derived its inclusive clone bound
// from a COUNT of live rows. Rows anchor at MAX(seq)+1 and tombstones keep
// their seq, so once ANY row is retired the live count under-reports the last
// live seq (count < lastLiveSeq + 1) and the child silently lost the NEWEST
// live rows at fork. The fix clones through the parent's last live seq
// (UnifiedStore.lastLiveSeq / mysql twin / unifiedLastLiveSeq facade).

function msg(id: string, role: "user" | "assistant"): CoreMessage {
    return { id, role, contentType: "text", text: `body ${id}` };
}

function session(id: string, tail: CoreMessage[]): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: tail,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-4730-fork-live-seq-"));
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
}

test("#4730: fork clone keeps the newest live rows when a middle row is tombstoned", () => {
    const dir = tmpDir();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const parent = "sess-4730-parent";
        // 6 messages → seqs 0..5.
        const full = ["f_a", "f_b", "f_c", "f_d", "f_e", "f_f"].map((id, i) => msg(id, i % 2 ? "assistant" : "user"));
        store.ingestSession(planIngest(session(parent, full)));

        // Retire the MIDDLE row (f_c, seq 2) the way the historian does: a
        // completeLog re-ingest whose authoritative set no longer contains it.
        const sansMiddle = full.filter((m) => m.id !== "f_c");
        store.ingestSession(planIngest(session(parent, sansMiddle)), undefined, { completeLog: true });

        const live = store.getMessages(parent).map((m) => m.msgId).sort();
        assert.deepEqual(live, ["f_a", "f_b", "f_d", "f_e", "f_f"], "fixture sanity: f_c tombstoned, the rest live");

        // The regression: lastLiveSeq (5) vs the old count-1 math (4).
        assert.equal(store.liveRowCount(parent), 5, "live count under-reports the last seq once a row is retired");
        assert.equal(store.lastLiveSeq(parent), 5, "last live seq is the NEWEST live row's seq, not count-1");

        // Clone through the fix's bound: the child keeps every live row.
        store.cloneSessionRows(parent, "sess-4730-child", store.lastLiveSeq(parent)!);
        const childIds = store.getMessages("sess-4730-child").map((m) => m.msgId).sort();
        assert.deepEqual(childIds, ["f_a", "f_b", "f_d", "f_e", "f_f"], "child contains ALL live rows including the newest (f_f)");
        const childSeqs = store.getMessages("sess-4730-child").map((m) => m.seq).sort((a, b) => a - b);
        assert.deepEqual(childSeqs, [0, 1, 3, 4, 5], "child keeps the parent's seq values (holes included) so cloned refs still resolve");
        const childRow = store.getSessionRow("sess-4730-child")!;
        assert.equal(childRow.parentSessionId, parent, "lineage column records the parent");
        assert.equal(childRow.forkPointSeq, 5, "fork_point_seq is the last live seq");
        // The child inherits the parent's HISTORY including the tombstone
        // (retired_at copies verbatim — the ledger is the durable record),
        // but its SERVED view excludes it: f_c stays retired, never resurfaces.
        const childAll = store.getMessages("sess-4730-child", { includeRetired: true });
        assert.equal(childAll.length, 6, "history rows (tombstone included) copy wholesale");
        const retiredInChild = childAll.find((m) => m.msgId === "f_c")!;
        assert.notEqual(retiredInChild.retiredAt, null, "the tombstoned row stays retired in the child");

        // Control reproducing the OLD bug's arithmetic: cloning through
        // count-1 (4) drops f_f — the exact data loss #4730 reported.
        store.cloneSessionRows(parent, "sess-4730-oldmath", store.liveRowCount(parent) - 1);
        const oldMathIds = store.getMessages("sess-4730-oldmath").map((m) => m.msgId).sort();
        assert.deepEqual(oldMathIds, ["f_a", "f_b", "f_d", "f_e"], "control: the old count-1 bound loses the newest live row");
    } finally {
        cleanup(dir);
    }
});

test("#4730: lastLiveSeq is null for a session with no live rows", () => {
    const dir = tmpDir();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4730-empty";
        store.ingestSession(planIngest(session(sid, [msg("only", "user")])));

        // Retire everything, then assert the null contract the facade relies
        // on (null → kernel-only fork, never a fabricated bound).
        store.ingestSession(planIngest(session(sid, [])), undefined, { completeLog: true });
        assert.equal(store.getMessages(sid).length, 0, "fixture sanity: no live rows");
        assert.equal(store.lastLiveSeq(sid), null, "no live rows → null, not -1 and not 0");
        assert.equal(store.lastLiveSeq("never-ingested"), null, "unknown session → null");
    } finally {
        cleanup(dir);
    }
});
