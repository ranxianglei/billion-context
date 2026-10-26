/**
 * #4730: fork clones history using live-row COUNT as the cut, so any retired
 * row makes the child silently lose its newest messages.
 *
 * The unified store's message seq is APPEND-ONLY (remap/delta anchor at
 * MAX(seq)+1). Once any row is retired (a fold tombstones the covered rows),
 * COUNT(*) of live rows understates the newest position: count-1 < MAX(live
 * seq). The fork endpoint passed count-1 as the inclusive throughSeq, so the
 * child lost tail messages — one per retired row.
 *
 * Fix: cut at the HIGHEST live row seq (MAX(seq) WHERE retired_at IS NULL),
 * exposed as lastLiveSeq() (-1 when there are no live rows → kernel-only
 * fork). These stakes pin: (a) lastLiveSeq returns the true cut, (b) cloning
 * at that cut retains the tail, (c) the no-retired and all-retired edges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "i4730-cfg-")), "missing.json");

function msg(id: string, text: string, wireIndex: number): CoreMessage {
    return { id, role: "user", contentType: "text", text, wireIndex } as CoreMessage;
}

function sessLike(id: string, requests: number, lastMessages: CoreMessage[]): LegacySessionLike {
    const state = { ...createInitialState(), requests };
    state.nextBlockId = 1;
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests },
        metadata: { pluginAgent: "proxy" },
        state: state as never,
        blockContents: new Map() as never,
        lastMessages,
        lastMessagesFolded: false,
    };
}

function openStore(): { st: UnifiedStore; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "i4730-db-"));
    return { st: UnifiedStore.open(join(dir, "index.db")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("#4730: lastLiveSeq cuts at the highest live seq; fork clone retains the tail past retired rows", () => {
    const { st, cleanup } = openStore();
    try {
        // Parent: 6 messages → seq 0..5, all live.
        st.ingestSession(planIngest(sessLike("p", 1, [
            msg("a", "alpha", 0), msg("b", "bravo", 1), msg("c", "charlie", 2),
            msg("d", "delta", 3), msg("e", "echo", 4), msg("f", "foxtrot", 5),
        ])), undefined, { completeLog: true });

        // Simulate a fold: b and d leave the authoritative view → RETIRED
        // (tombstoned at their original seqs); a,c,e,f survive at the same seqs.
        st.ingestSession(planIngest(sessLike("p", 2, [
            msg("a", "alpha", 0), msg("c", "charlie", 2), msg("e", "echo", 4), msg("f", "foxtrot", 5),
        ])), undefined, { completeLog: true });

        // Live rows: a(0), c(2), e(4), f(5). MAX(live seq)=5, COUNT(live)=4.
        // The old cut (count-1=3) undershot the true position (5) and would
        // have dropped e and f — the reported data loss.
        assert.equal(st.getMessages("p").length, 4, "four live rows after the fold");
        assert.equal(st.lastLiveSeq("p"), 5, "lastLiveSeq = highest live row seq, not count-1");

        // Fork clone at the corrected cut retains every live row incl. the tail.
        st.cloneSessionRows("p", "child", st.lastLiveSeq("p"));
        assert.deepEqual(
            st.getMessages("child").map((r) => r.msgId),
            ["a", "c", "e", "f"],
            "child keeps the full live prefix including the tail (e,f)",
        );

        // Idempotent replay must not duplicate rows.
        st.cloneSessionRows("p", "child", st.lastLiveSeq("p"));
        assert.equal(st.getMessages("child").length, 4, "replay is a no-op");

        // The child's own first append continues from max seq + 1 (6) over the
        // FULL prefix — proof the fork did not truncate the tail. (Cloned
        // retired rows b,d sit below and are filtered from the live view.)
        const cloned = st.getMessages("child").map((r) => JSON.parse(r.content) as CoreMessage);
        st.ingestSession(planIngest(sessLike("child", 3, [...cloned, msg("g", "golf", 4)])), undefined, { completeLog: true });
        const after = st.getMessages("child");
        assert.deepEqual(after.map((r) => r.msgId), ["a", "c", "e", "f", "g"], "tail intact after the child's own turn");
        assert.equal(after.find((r) => r.msgId === "g")!.seq, 6, "child append lands at parent max seq + 1");
    } finally {
        st.close();
        cleanup();
    }
});

test("#4730 edge: with no retired rows lastLiveSeq equals the old count-1 cut (unchanged)", () => {
    const { st, cleanup } = openStore();
    try {
        st.ingestSession(planIngest(sessLike("fresh", 1, [
            msg("a", "alpha", 0), msg("b", "bravo", 1), msg("c", "charlie", 2),
        ])), undefined, { completeLog: true });
        // 3 live rows, none retired: MAX(live seq)=2 == count-1. The fix must
        // not move the boundary in the common (unfolded) case.
        assert.equal(st.getMessages("fresh").length, 3);
        assert.equal(st.lastLiveSeq("fresh"), 2, "no retired rows → same cut as before");
    } finally {
        st.close();
        cleanup();
    }
});

test("#4730 edge: a session whose rows are all retired reports -1 (kernel-only fork)", () => {
    const { st, cleanup } = openStore();
    try {
        st.ingestSession(planIngest(sessLike("gone", 1, [msg("a", "alpha", 0)])), undefined, { completeLog: true });
        // The single row leaves the authoritative view → retired; nothing live.
        st.ingestSession(planIngest(sessLike("gone", 2, [])), undefined, { completeLog: true });
        assert.equal(st.getMessages("gone").length, 0, "no live rows remain");
        assert.equal(st.lastLiveSeq("gone"), -1, "empty live set → -1 sentinel (kernel-only fork)");
    } finally {
        st.close();
        cleanup();
    }
});
