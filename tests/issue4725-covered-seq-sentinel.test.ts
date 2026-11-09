import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage, CompressionBlock } from "acp-kernel";

// PR #4725 N1 (round-3 review): boundsForCovered returned [0,0] when a
// block's covered ids could not be resolved to transcript rows. That
// placeholder is NOT absence — it passes every >= 0 guard and reads back as a
// REAL interval claim over seq 0, suppressing the seq-0 message as already
// folded (silent content loss for migrated pre-unified-storage installs; the
// window is permanent because folded raws never re-ingest). The fix stores
// the -1/-1 "no claim" sentinel, which the #4608 CASE guard already treats as
// unknown-bounds and the kernel's coveredSeqIntervals/blockSeqPresent skip
// (kernel side: kernel/tests/covered-seq-sentinel.test.ts).

function msg(id: string, role: "user" | "assistant"): CoreMessage {
    return { id, role, contentType: "text", text: `body ${id}` };
}

function block(id: string, covered: string[]): CompressionBlock {
    return {
        blockId: id,
        runId: `run-${id}`,
        tier: 1,
        summary: `summary ${id}`,
        directMessageIds: [],
        effectiveMessageIds: covered,
        directBlockIds: [],
        compressedTokens: 10,
        createdAt: 1_000,
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

function session(id: string, tail: CoreMessage[], blocks: CompressionBlock[]): LegacySessionLike {
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
        state: { blocks, nextBlockId: blocks.length + 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(blocks.map((b) => [b.blockId, { one: null, full: { text: b.summary, count: 1 } }])),
        lastMessages: tail,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
}

test("#4725 N1: unresolvable covered set stores the -1 sentinel and claims no row — seq 0 included", () => {
    const dir = tmpDir("bili-4725-sentinel-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4725-sentinel";
        // The block covers a pre-fold id with no transcript row; the visible
        // tail includes a message at seq 0 — exactly the row the old [0,0]
        // placeholder falsely claimed.
        store.ingestSession(planIngest(session(sid, [msg("v0", "user"), msg("v1", "assistant")], [block("b1", ["folded-away"])])));

        const b = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(b.startSeq, -1, "start_seq sentinel is -1, not the [0,0] placeholder");
        assert.equal(b.endSeq, -1, "end_seq sentinel is -1, not the [0,0] placeholder");

        // The claim is empty: reading rows outside the block's interval keeps
        // EVERY live row, seq 0 included (the N1 loss shape excluded seq 0).
        const uncovered = store.uncoveredRows(sid, [[b.startSeq, b.endSeq]]);
        assert.deepEqual(
            uncovered.map((r) => r.seq).sort((a, z) => a - z),
            [0, 1],
            "sentinel interval covers nothing",
        );
    } finally {
        cleanup(dir);
    }
});

test("#4725 N1: a resolvable block that genuinely covers seq 0 keeps its REAL [0, n] claim (no [0,0] special-casing)", () => {
    const dir = tmpDir("bili-4725-real-zero-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4725-real-zero";
        const tail = [msg("z_a", "user"), msg("z_b", "assistant"), msg("z_c", "user")];
        store.ingestSession(planIngest(session(sid, tail, [block("b1", ["z_a", "z_b"])])));

        const b = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(b.startSeq, 0, "genuine seq-0 coverage is a real claim, not the sentinel");
        assert.equal(b.endSeq, 1, "end bound spans to the last covered row");
        assert.deepEqual(
            store.uncoveredRows(sid, [[b.startSeq, b.endSeq]]).map((r) => r.seq),
            [2],
            "the real [0,1] claim still covers seqs 0-1",
        );
    } finally {
        cleanup(dir);
    }
});

test("#4725 N1: the sentinel self-heals to real bounds once the covered raws resolve on a later save", () => {
    const dir = tmpDir("bili-4725-heal-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4725-heal";
        // Save 1: covered id has no row (imported pre-fold) → sentinel.
        store.ingestSession(planIngest(session(sid, [msg("h_x", "user")], [block("b1", ["h_old"])])));
        const before = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(before.startSeq, -1);

        // Save 2: the raw arrived (host re-ingested the full log). The
        // upsert's >= 0 branch overwrites the sentinel with real bounds.
        store.ingestSession(planIngest(session(sid, [msg("h_x", "user"), msg("h_old", "assistant")], [block("b1", ["h_old"])])));
        const after = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(after.startSeq, 1, "self-heal: real start bound once the raw resolves");
        assert.equal(after.endSeq, 1, "self-heal: real end bound once the raw resolves");
    } finally {
        cleanup(dir);
    }
});

test("#4725 N3: covered-seq resolution survives the 500-id chunk boundary (point query batches)", () => {
    const dir = tmpDir("bili-4725-chunk-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4725-chunk";
        // 600 covered ids > the 500-id IN-batch — bounds must still resolve
        // across BOTH batches (min from the first, max from the second).
        const tail: CoreMessage[] = [];
        for (let i = 0; i < 600; i++) tail.push(msg(`c_${i}`, i % 2 ? "assistant" : "user"));
        const covered = tail.map((m) => m.id);
        store.ingestSession(planIngest(session(sid, tail, [block("b1", covered)])));

        const b = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(b.startSeq, 0, "min bound resolves from the first batch");
        assert.equal(b.endSeq, 599, "max bound resolves across the batch boundary");
        assert.equal(store.uncoveredRows(sid, [[b.startSeq, b.endSeq]]).length, 0, "the whole span is claimed");
    } finally {
        cleanup(dir);
    }
});
