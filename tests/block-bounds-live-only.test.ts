import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy"; // hermetic tier baseline; tests drive UnifiedStore directly

/**
 * #4801 review (P2 storage): a block's start_seq/end_seq describe what the
 * unified replay CURRENTLY serves — getMessages filters retired rows, so a
 * bound spanning a tombstoned generation claims coverage over rows the
 * replay never returns. Realistic trigger: a message is edited in place
 * (same client id, new bytes → new identity); a complete-log save sweeps the
 * old generation to a tombstone and lands the new one past max(seq), so the
 * covered id spans two generations. Pre-fix resolution took min/max over ALL
 * rows including retired, widening the bound onto the dead row. Post-fix an
 * all-retired id yields no span and boundsForCovered demotes it honestly (if
 * that empties the whole claim the -1 sentinel preserves stored bounds, #4608).
 */

function msg(id: string): CoreMessage {
    return { id, role: "user", contentType: "text", text: `body ${id}` } as unknown as CoreMessage;
}

function session(id: string, tail: CoreMessage[]): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    const blk = {
        blockId: "blk1",
        runId: 1,
        createdAt: 1_000,
        tier: 1,
        active: true,
        summary: "summary body",
        kind: "fold",
        reason: "test",
        effectiveMessageIds: tail.map((m) => m.id),
        directMessageIds: [] as string[],
    };
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks: [blk as never], nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: tail,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

interface Handle {
    dir: string;
    store: UnifiedStore;
    bounds(): [number, number];
    close(): void;
}

function open(label: string): Handle {
    const dir = mkdtempSync(path.join(tmpdir(), `bili-block-bounds-${label}-`));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    const raw = openSqliteDatabase(dbPath, "node:sqlite");
    const q = raw.db as unknown as { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close?(): void };
    return {
        dir,
        store,
        bounds() {
            const row = q.prepare("SELECT start_seq, end_seq FROM blocks WHERE session_id = ? AND block_id = ?").get("sess-bounds", "blk1") as { start_seq: number; end_seq: number } | undefined;
            assert.ok(row, "block row present");
            return [row.start_seq, row.end_seq];
        },
        close() {
            try { store.close(); } catch { /* already closed */ }
            try { q.close?.(); } catch { /* no-op */ }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("block seq bounds follow LIVE rows only: a retired generation never widens the span", () => {
    const h = open("retired");
    try {
        const S = session("sess-bounds", ["A", "B", "C"].map(msg));
        h.store.ingestSession(planIngest(S));
        assert.deepEqual(h.bounds(), [0, 2], "fixture sanity: full live coverage resolves to [0,2]");

        // Pinned-id edit shape: A is rewritten in place (same id, new bytes →
        // new identity). A complete-log save tombstones the old generation
        // (its identity is absent from the incoming log) and lands the new one
        // past max(seq) — covered id A now spans two generations.
        const edited = ["A", "B", "C"].map((id) => (id === "A" ? { ...msg(id), text: "body A v2" } : msg(id)));
        h.store.ingestSession(planIngest(session("sess-bounds", edited)), undefined, { completeLog: true });

        assert.equal(h.bounds()[0], 1, "start bound follows the FIRST LIVE covered row (B@1) — pre-fix the retired A@0 leaked in and widened it to 0");
        assert.equal(h.bounds()[1], 3, "end bound follows the newest live generation (A'@3)");
    } finally {
        h.close();
    }
});
