import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore } from "../src/storage/store.js";
import { planIngest } from "../src/storage/ingest.js";
import { createInitialState } from "acp-kernel";

interface CoreLike {
    id: string;
    role: "user" | "assistant";
    contentType: "text";
    text: string;
}

function wmsg(id: string, role: "user" | "assistant", text: string): CoreLike {
    return { id, role, contentType: "text", text };
}

function histLike(sessionId: string, messages: CoreLike[], blocks: Array<{ blockId: string; effectiveMessageIds: string[] }>) {
    const state = { ...createInitialState(), requests: 1 };
    state.nextBlockId = blocks.length + 1;
    state.blocks = blocks.map((b) => ({
        blockId: b.blockId,
        runId: "r1",
        tier: 1 as const,
        summary: `summary for ${b.blockId} — covered history retained in the block store, recoverable via decompress`,
        directMessageIds: b.effectiveMessageIds,
        effectiveMessageIds: b.effectiveMessageIds,
        directBlockIds: [],
        compressedTokens: 500,
        createdAt: Date.now(),
        survivedCount: 1,
        generation: "young" as const,
        active: true,
    })) as never;
    const contents = new Map<string, { one: null; full: { text: string; count: number } }>();
    for (const b of blocks) contents.set(b.blockId, { one: null, full: { text: `full summary for ${b.blockId} — durable interval evidence test fixture`, count: 3 } });
    return {
        id: sessionId,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: sessionId, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests: 1, blocks: blocks.length, tokensSaved: 100 },
        metadata: { pluginAgent: null },
        state: state as never,
        blockContents: contents as never,
        lastMessages: messages as never,
        lastMessagesFolded: false,
    };
}

test("block interval bounds survive a resave whose batch no longer contains the covered raws (#4592)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bounds-preserve-"));
    const dbPath = join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            const m1 = wmsg("h_1", "user", "question one about the durable ledger bounds");
            const m2 = wmsg("h_2", "assistant", "answer one with some content so the row carries bytes");
            const m3 = wmsg("h_3", "user", "question two about the durable ledger bounds");
            // first ingest: rows land together with a block covering them → real bounds
            store.ingestSession(planIngest(histLike("bounds-1", [m1, m2, m3], [{ blockId: "b1", effectiveMessageIds: ["h_1", "h_2", "h_3"] }])));
            let row = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { start_seq: number; end_seq: number } } } })
                .db.prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?")
                .get("bounds-1", "b1");
            assert.ok(row.start_seq >= 0 && row.end_seq >= row.start_seq, `first ingest resolves real bounds: ${JSON.stringify(row)}`);

            // second ingest: the post-fold client view — covered raws GONE, only the
            // summary anchor + a fresh tail message ride; the same block re-saves.
            const anchor = wmsg("acp_summary_b1", "user", "[Compressed b1 — summary anchor]");
            const tail = wmsg("h_4", "user", "tail message after the fold");
            store.ingestSession(planIngest(histLike("bounds-1", [anchor, tail], [{ blockId: "b1", effectiveMessageIds: ["h_1", "h_2", "h_3"] }])));
            row = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { start_seq: number; end_seq: number } } } })
                .db.prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?")
                .get("bounds-1", "b1");
            // the regression: the second batch re-derived -1/-1 and clobbered the evidence
            assert.deepEqual(
                { start: row.start_seq, end: row.end_seq },
                { start: 0, end: 2 },
                `bounds must stay durable across the post-fold resave: ${JSON.stringify(row)}`,
            );
        } finally {
            store.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a block that never resolved keeps the honest -1/-1 gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "bounds-gap-"));
    const dbPath = join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            const m1 = wmsg("h_1", "user", "one shot imported history without covered rows");
            store.ingestSession(planIngest(histLike("bounds-2", [m1], [{ blockId: "b-ghost", effectiveMessageIds: ["h_ghost1", "h_ghost2"] }])));
            const row = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { start_seq: number; end_seq: number } } } })
                .db.prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?")
                .get("bounds-2", "b-ghost");
            // "unknown" has two legacy shapes: -1/-1 (plan side) and the
            // pre-layer-3 0/0 placeholder (store side). Either is honest here;
            // what must NEVER happen is a resolved interval for ghost ids.
            assert.ok(row.start_seq <= 0 && row.end_seq <= Math.max(row.start_seq, 0), `ghost coverage stays unknown: ${JSON.stringify(row)}`);
        } finally {
            store.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
