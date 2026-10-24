import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage, CompressionBlock } from "acp-kernel";

// #4512: ingestSession used to scan the WHOLE messages table per persist to
// build block seq bounds. The fix fetches only the rows the blocks cover, via
// a chunked `msg_id IN (...)`. These tests pin the two things the old code
// never exercised: a covered-id union that spans MULTIPLE query batches, and
// directMessageIds feeding the union (not just effectiveMessageIds).

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

function withStore(label: string, fn: (store: UnifiedStore, dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bili-4512-${label}-`));
    try {
        fn(UnifiedStore.open(path.join(dir, "index.db")), dir);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
}

test("#4512: a covered-id union over one batch resolves across multiple query batches", () => {
    withStore("chunk", (store) => {
        const sid = "sess-4512-chunk";
        // 600 distinct covered ids > SEQ_SPAN_QUERY_BATCH (500): the span query
        // must run in >=2 batches and fetch every row. A single block covering
        // the whole transcript spans both batches, so a dropped/truncated batch
        // would leave end_seq stuck on the last id of batch 1.
        const N = 600;
        const ids = Array.from({ length: N }, (_, i) => `m_${i}`);
        const tail = ids.map((id, i) => msg(id, i % 2 === 0 ? "user" : "assistant"));
        store.ingestSession(planIngest(session(sid, tail, [block("big", ids)])));

        const first = seqOf(store, sid, ids[0]);
        const last = seqOf(store, sid, ids[N - 1]);
        assert.notEqual(first, undefined, "fixture sanity: first covered id must be a transcript row");
        assert.notEqual(last, undefined, "fixture sanity: last covered id must be a transcript row");

        const b = store.getBlocks(sid).find((x) => x.blockId === "big")!;
        assert.equal(b.startSeq, first, "start_seq = seq of first covered id (batch 1)");
        assert.equal(b.endSeq, last, "end_seq = seq of last covered id (batch 2) — proves the later batch ran");
        assert.ok(b.endSeq > b.startSeq, "interval spans the whole transcript");
    });
});

test("#4512: directMessageIds coverage feeds the union (not only effectiveMessageIds)", () => {
    withStore("direct", (store) => {
        const sid = "sess-4512-direct";
        const tail = [msg("d_a", "user"), msg("d_b", "assistant"), msg("d_c", "user")];
        // Covers via directMessageIds only; effectiveMessageIds is empty. If the
        // union collection read only effectiveMessageIds, d_b would never be
        // fetched and the bounds would fall back to the 0 placeholder.
        const bDirect: CompressionBlock = { ...block("bd", []), directMessageIds: ["d_b"] };
        store.ingestSession(planIngest(session(sid, tail, [bDirect])));

        const exp = seqOf(store, sid, "d_b");
        assert.notEqual(exp, undefined, "fixture sanity: d_b must be a transcript row");
        const b = store.getBlocks(sid).find((x) => x.blockId === "bd")!;
        assert.equal(b.startSeq, exp, "direct-covered id resolves to a real bound, not the 0 placeholder");
        assert.equal(b.endSeq, exp);
    });
});
