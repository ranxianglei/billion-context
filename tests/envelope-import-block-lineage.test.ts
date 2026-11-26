/**
 * 2026-11-21 (#7156 incident follow-up): envelope imports must never replace
 * a stored block lineage (or regress the stored lifetime stats).
 *
 * The incident: a 3.2 GB index.db proved corrupt mid-session; the process
 * degraded to JSON envelopes (zero-copy), whose view carried a 32-BLOCK
 * coarse rendering of the same history the index had stored as a 103-block
 * fine lineage. After the index was salvaged and put back, the unified
 * import (envelope savedAt > stored updated_at) ran with the envelope's
 * block set as AUTHORITATIVE: the "drop absent ids" sweep deleted stored
 * blocks b33..b103 — summaries that no longer existed anywhere — and
 * upserted the coarse b1..b32 on top of the fine ones. The same import
 * also overwrote the session row's real lifetime stats (1563 requests /
 * 169M input tokens) with the degraded writer's {"requests":2}.
 *
 * Contract under test (ingestSession's envelopeImport flag, set ONLY by
 * shadow.importRecord / importRecordAsync — the envelope paths):
 *   1. stored blocks exist  → the stored lineage is preserved untouched;
 *      the envelope contributes its NEW messages only;
 *   2. no stored blocks     → the envelope's structure is adopted (true
 *      first import);
 *   3. organic saves (flag off) keep the authoritative-set discipline —
 *      the live writer's block set still wins;
 *   4. envelope stats may ADVANCE the stored lifetime counters but never
 *      REGRESS them (a smaller `requests` total names a foreign/partial
 *      lineage).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage, CompressionBlock } from "acp-kernel";
import { UnifiedStore, sha256Hex, type BlockRow, type MessageRow, type SessionRow } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity pin (same pattern as the other storage suites): a developer
// machine's real storage config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-env-import-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const T0 = 1_700_000_000_000;

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leaked temp dir on a Windows runner is harmless */ }
}

/** Deterministic message bytes (id + content), stable across "saves". */
function msgContent(i: number): string {
    return JSON.stringify({ id: `h_m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` });
}

function msgRow(i: number): MessageRow {
    return { seq: i, msgId: `h_m${i}`, ref: null, refNum: null, role: i % 2 === 0 ? "user" : "assistant", kind: "text", content: msgContent(i) };
}

function blockRow(blockId: string, ord: number, summary: string, msgIds: string[], createdAt: number): BlockRow {
    const full = JSON.stringify({ text: summary, count: msgIds.length });
    const covered = JSON.stringify({ effectiveMessageIds: msgIds, directMessageIds: msgIds });
    return {
        blockId, ord, startSeq: -1, endSeq: -1, startRef: null, endRef: null, tier: 1,
        summary: full, one: null, summaryHash: sha256Hex(full), oneHash: null,
        supersedesBlockId: null, active: true, createdAt, coveredHash: sha256Hex(covered),
        payloadJson: JSON.stringify({
            blockId, runId: `r-${ord}`, tier: 1, summary,
            directMessageIds: msgIds, effectiveMessageIds: msgIds, directBlockIds: [],
            compressedTokens: msgIds.length, createdAt, survivedCount: 0, generation: "young", active: true,
        }),
    };
}

function sessionRow(id: string, updatedAt: number, requests: number): SessionRow {
    return {
        sessionId: id, createdAt: T0, updatedAt, nextBlockId: 100, nextRunId: 1,
        metaJson: "{}", statsJson: JSON.stringify({ requests }), metadataJson: "{}",
        kstateJson: "{}", tailJson: JSON.stringify({ tailSeqs: null, tailFolded: false }), ccrJson: "{}",
    };
}

const ids = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, k) => `h_m${from + k}`);

test("envelope import: stored block lineage is preserved; new messages still land", () => {
    const dir = tmpdir("bili-env-import-lineage-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            // The index's fine lineage: 2 blocks over 10 messages.
            store.ingestSession({
                session: sessionRow("imp-lineage", T0, 100),
                messages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(msgRow),
                blocks: [blockRow("b1", 0, "fine summary one", ids(0, 4), T0), blockRow("b2", 1, "fine summary two", ids(5, 9), T0)],
                deadRefs: [], refs: [],
            });
            assert.equal(store.getBlocks("imp-lineage").length, 2);

            // The envelope: a COARSE re-render (one block, different summary)
            // plus three messages the index does not have yet. Its writer
            // only served 2 requests — importing it must not touch the
            // lineage or regress the stats.
            store.ingestSession({
                session: sessionRow("imp-lineage", T0 + 5_000, 2),
                messages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(msgRow),
                blocks: [blockRow("b1", 0, "COARSE summary of everything", ids(0, 12), T0 + 5_000)],
                deadRefs: [], refs: [],
            }, undefined, { envelopeImport: true });

            const blocks = store.getBlocks("imp-lineage");
            assert.equal(blocks.length, 2, "stored blocks must survive the coarse envelope import");
            assert.deepEqual(blocks.map((b) => b.blockId).sort(), ["b1", "b2"]);
            const b1 = blocks.find((b) => b.blockId === "b1")!;
            assert.equal(JSON.parse(b1.summary).text, "fine summary one", "the coarse envelope must NOT overwrite stored block b1");
            assert.equal(JSON.parse(blocks.find((b) => b.blockId === "b2")!.summary).text, "fine summary two", "block b2 must not be deleted by the sweep");

            const msgs = store.getMessages("imp-lineage");
            assert.equal(msgs.length, 13, "the envelope's new messages must still be appended");
            assert.equal(msgs[12].msgId, "h_m12");

            const row = store.getSessionRow("imp-lineage")!;
            assert.equal(row.statsJson, JSON.stringify({ requests: 100 }), "a regression of the lifetime counters must be blocked");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("envelope import: stats may advance, never regress", () => {
    const dir = tmpdir("bili-env-import-stats-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession({
                session: sessionRow("imp-stats", T0, 100),
                messages: [0, 1, 2].map(msgRow),
                blocks: [blockRow("b1", 0, "s", ids(0, 2), T0)],
                deadRefs: [], refs: [],
            });
            // Same envelope, but its counter is AHEAD — a same-lineage
            // continuation: the update applies.
            store.ingestSession({
                session: sessionRow("imp-stats", T0 + 1_000, 150),
                messages: [0, 1, 2].map(msgRow),
                blocks: [blockRow("b1", 0, "s", ids(0, 2), T0)],
                deadRefs: [], refs: [],
            }, undefined, { envelopeImport: true });
            assert.equal(store.getSessionRow("imp-stats")!.statsJson, JSON.stringify({ requests: 150 }), "advancing counters must apply");

            // And a stale envelope arriving afterwards cannot pull it back.
            store.ingestSession({
                session: sessionRow("imp-stats", T0 + 2_000, 3),
                messages: [0, 1, 2].map(msgRow),
                blocks: [blockRow("b1", 0, "s", ids(0, 2), T0)],
                deadRefs: [], refs: [],
            }, undefined, { envelopeImport: true });
            assert.equal(store.getSessionRow("imp-stats")!.statsJson, JSON.stringify({ requests: 150 }), "a smaller incoming total must not regress the stored counters");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("envelope import: a session with no stored blocks adopts the envelope structure", () => {
    const dir = tmpdir("bili-env-import-first-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession({
                session: sessionRow("imp-first", T0, 5),
                messages: [0, 1, 2, 3, 4].map(msgRow),
                blocks: [blockRow("b1", 0, "e", ids(0, 4), T0)],
                deadRefs: [], refs: [],
            }, undefined, { envelopeImport: true });
            assert.equal(store.getBlocks("imp-first").length, 1, "true first import must adopt the envelope's blocks");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("organic save (flag off): the writer's block set stays authoritative", () => {
    const dir = tmpdir("bili-env-import-organic-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.ingestSession({
                session: sessionRow("imp-organic", T0, 1),
                messages: [0, 1, 2, 3].map(msgRow),
                blocks: [blockRow("b1", 0, "fine one", ids(0, 1), T0), blockRow("b2", 1, "fine two", ids(2, 3), T0)],
                deadRefs: [], refs: [],
            });
            // A live-writer save whose state genuinely has one coarse block:
            // the old authoritative-set discipline must keep applying.
            store.ingestSession({
                session: sessionRow("imp-organic", T0 + 1_000, 2),
                messages: [0, 1, 2, 3].map(msgRow),
                blocks: [blockRow("b1", 0, "coarse all", ids(0, 3), T0 + 1_000)],
                deadRefs: [], refs: [],
            });
            const blocks = store.getBlocks("imp-organic");
            assert.equal(blocks.length, 1, "organic saves must still sweep absent blocks");
            assert.equal(JSON.parse(blocks[0].summary).text, "coarse all");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

// ---- wiring: shadow.importRecord is the ONLY producer of the flag --------

function mkCoreMsg(i: number): CoreMessage {
    return { id: `h_m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

function mkLegacyWithBlocks(id: string, nBlocks: number, nMsgs: number, updatedAt: number): LegacySessionLike {
    const per = Math.ceil(nMsgs / nBlocks);
    const blocks: CompressionBlock[] = [];
    for (let i = 0; i < nBlocks; i++) {
        const msgIds = Array.from({ length: Math.min(per, nMsgs - i * per) }, (_, k) => `h_m${i * per + k}`);
        blocks.push({
            blockId: `b${i + 1}`, runId: `r${i + 1}`, tier: 1,
            summary: `summary covering ${msgIds.length} messages`,
            directMessageIds: msgIds, effectiveMessageIds: msgIds, directBlockIds: [],
            compressedTokens: msgIds.length, createdAt: T0 + i, survivedCount: 0, generation: "young", active: true,
        } as CompressionBlock);
    }
    return {
        id,
        createdAt: T0,
        lastSeen: updatedAt,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 + nMsgs },
        metadata: {},
        state: {
            blocks,
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: nBlocks + 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: Array.from({ length: nMsgs }, (_, i) => mkCoreMsg(i)),
        lastMessagesFolded: false,
    };
}

test("wiring: importRecord keeps the stored lineage across a coarser re-import", () => {
    const dir = tmpdir("bili-env-import-wire-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
        assert.ok(shadow, "shadow sidecar must open");
        try {
            // First import: the index has no stored blocks → adopt (2 fine blocks).
            const fine = mkLegacyWithBlocks("imp-wire", 2, 10, T0 + 1_000);
            assert.ok(shadow.importRecord(fine), "first importRecord must succeed");
            assert.equal(store.getBlocks("imp-wire").length, 2);

            // Re-import: a coarser rendering of the SAME history (1 block)
            // from a writer that only saw 13 of the 13 messages… its block
            // structure must not replace the stored fine lineage.
            const coarse = mkLegacyWithBlocks("imp-wire", 1, 13, T0 + 9_000);
            assert.ok(shadow.importRecord(coarse), "re-importRecord must succeed");
            const blocks = store.getBlocks("imp-wire");
            assert.equal(blocks.length, 2, "the coarse envelope must not erase the stored fine blocks");
            assert.equal(blocks.filter((b) => b.active).length, 2);
            assert.equal(store.getMessages("imp-wire").length, 13, "the envelope's new messages must land");

            // planIngest without the flag (an organic save of the same
            // coarse state) WOULD replace — proving the wiring (the flag),
            // not a coincidental no-op, is what preserved the lineage.
            assert.equal(
                store.ingestSession(planIngest(coarse)),
                true,
                "organic re-ingest of the same state applies the authoritative sweep",
            );
            assert.equal(store.getBlocks("imp-wire").length, 1, "organic discipline: the writer's block set wins");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
