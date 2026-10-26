import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CompressionBlock } from "acp-kernel";

/**
 * #3901 / #3841 — reaped blocks must stay reaped across restarts.
 *
 * A session whose substrate was reaped (#2695: state.blocks loses the entry,
 * blockContents KEEPS the full text for derived-decompress) had its stale
 * block rows resurrect by a viewFor rebuild after restart, polluting the
 * envelope on the next save. The reap journal (#3901): record()-time targeted
 * update — delete the reaped block rows, persist the orphan contents in
 * sessions.orphans_json (schema v6) so viewFor rebuilds them into
 * blockContents WITHOUT resurrecting state.blocks.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-reap-journal-")),
    "no-config.json",
);

const mkSession = (id: string): LegacySessionLike => {
    const blocks: CompressionBlock[] = Array.from({ length: 2 }, (_, i) => ({
        blockId: `b${i + 1}`,
        runId: `r${i + 1}`,
        tier: 1,
        summary: `summary ${id} b${i + 1}`,
        directMessageIds: [],
        effectiveMessageIds: [`m${i + 1}`],
        directBlockIds: [],
        compressedTokens: 10,
        createdAt: 1_000 + i,
        survivedCount: 0,
        generation: "young",
        active: true,
    }));
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks, nextBlockId: 3, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(blocks.map((b) => [b.blockId, { one: null, full: { text: `${b.summary} ORIGINAL TEXT`, count: 1 } }])),
        lastMessages: undefined,
        lastMessagesFolded: undefined,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as LegacySessionLike;
};

test("reap journal: reaped block does not resurrect after restart; orphan content survives for decompress", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-reap-journal-"));
    try {
        const dbPath = path.join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        const legacy = mkSession("sess-reap");
        store.ingestSession(planIngest(legacy));
        assert.equal(store.getBlocks("sess-reap").length, 2);

        // #2695 reap: state.blocks loses b2, blockContents keeps its text.
        legacy.state.blocks = legacy.state.blocks.filter((b) => b.blockId !== "b2");
        // #3901 reap journal — record()-time targeted update for the orphan shape.
        store.reapBlocks(
            "sess-reap",
            new Set(["b2"]),
            new Map([["b2", legacy.blockContents.get("b2")!]]),
        );

        // Restart: a fresh handle on the same database.
        store.close();
        const reopened = UnifiedStore.open(dbPath);
        const rows = {
            session: reopened.getSessionRow("sess-reap")!,
            messages: reopened.getMessages("sess-reap"),
            blocks: reopened.getBlocks("sess-reap"),
            deadRefs: reopened.getDeadRefs("sess-reap"),
            refs: reopened.getRefs("sess-reap"),
        };
        const view = loadLegacyView(rows) as LegacySessionLike;
        const state = view.state as { blocks: CompressionBlock[] };
        assert.equal(state.blocks.length, 1, "reaped block must NOT resurrect into state.blocks");
        assert.equal(state.blocks[0].blockId, "b1");
        assert.ok(view.blockContents.has("b2"), "orphan content survives in blockContents (decompress fallback)");
        const full = view.blockContents.get("b2")!.full as unknown as { text: string };
        assert.equal(full.text, "summary sess-reap b2 ORIGINAL TEXT");
        reopened.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("reap journal: idempotent re-reap and no-op for unknown blocks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-reap-journal-2-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const legacy = mkSession("sess-idem");
        store.ingestSession(planIngest(legacy));
        store.reapBlocks("sess-idem", new Set(["b1"]), new Map([["b1", legacy.blockContents.get("b1")!]]));
        // Re-reap the same id and an id that never existed: neither throws.
        store.reapBlocks("sess-idem", new Set(["b1", "bX"]), new Map());
        assert.equal(store.getBlocks("sess-idem").length, 1);
        const view = loadLegacyView({
            session: store.getSessionRow("sess-idem")!,
            messages: store.getMessages("sess-idem"),
            blocks: store.getBlocks("sess-idem"),
            deadRefs: store.getDeadRefs("sess-idem"),
            refs: store.getRefs("sess-idem"),
        }) as LegacySessionLike;
        assert.equal((view.state as { blocks: CompressionBlock[] }).blocks.length, 1);
        assert.ok(view.blockContents.has("b1"));
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});
