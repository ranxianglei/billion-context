import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage, CompressionBlock } from "acp-kernel";

// #4316 layer 3 (owner ruling 2026-10-22): block coverage becomes a canonical
// [start_seq, end_seq] interval so a client byte-rewrite can't churn held
// m-numbers. RED today — start_seq/end_seq are hard-wired to 0 at the single
// write site (src/storage/ingest.ts); GREEN once the store-layer fill resolves
// covered ids -> seq from the append-only transcript.

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

function seqOf(store: UnifiedStore, sessionId: string, msgId: string): number | undefined {
    return store.getMessages(sessionId).find((m) => m.msgId === msgId)?.seq;
}

test("#4316: a block whose covered messages are present carries their real seq bounds (RED: placeholder 0)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4316-bounds-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4316";
        const tail = [msg("h_a", "user"), msg("h_b", "assistant"), msg("h_c", "user"), msg("h_d", "assistant"), msg("h_e", "user")];
        // One fold over the middle three — all still resolvable in the transcript.
        store.ingestSession(planIngest(session(sid, tail, [block("b1", ["h_b", "h_c", "h_d"])])));

        const expStart = seqOf(store, sid, "h_b");
        const expEnd = seqOf(store, sid, "h_d");
        assert.notEqual(expStart, undefined, "fixture sanity: covered message h_b must be a transcript row");
        assert.notEqual(expEnd, undefined, "fixture sanity: covered message h_d must be a transcript row");

        const b = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.ok(b.startSeq > 0, `start_seq must be filled from the transcript, got placeholder ${b.startSeq}`);
        assert.equal(b.startSeq, expStart, "start_seq = seq of first covered message");
        assert.equal(b.endSeq, expEnd, "end_seq = seq of last covered message");
        assert.ok(b.endSeq >= b.startSeq, "interval must be ordered");
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});

test("#4316: a block whose covered ids are absent from the transcript keeps placeholder 0 (no crash, honest gap)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4316-gap-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const sid = "sess-4316-gap";
        // Visible tail holds only h_x/h_y; the block covers h_old, which was
        // folded away / imported pre-fold and thus has no seq row to join.
        store.ingestSession(planIngest(session(sid, [msg("h_x", "user"), msg("h_y", "assistant")], [block("b1", ["h_old"])])));

        assert.equal(seqOf(store, sid, "h_old"), undefined, "fixture sanity: h_old must NOT be a transcript row");
        const b = store.getBlocks(sid).find((x) => x.blockId === "b1")!;
        assert.equal(b.startSeq, 0, "unresolvable coverage keeps the 0 placeholder, never a fabricated bound");
        assert.equal(b.endSeq, 0, "unresolvable coverage keeps the 0 placeholder, never a fabricated bound");
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
});
