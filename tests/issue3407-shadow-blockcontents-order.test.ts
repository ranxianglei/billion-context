/**
 * #3407: unified shadow digest drift on long sessions — the shadow parity
 * digest must compare blockContents CONTENTS, not Map insertion order.
 *
 * The two verify legs legitimately populate session.blockContents in different
 * orders: the expect leg keeps the live in-memory Map's insertion order and
 * completeBlockContents appends synthesized entries at the END when a block has
 * no slot; the got leg lays blocks out in state.blocks array order via the
 * blocks table. Long dsh persona-fork sessions hit this whenever orphan GC
 * deactivates a non-terminal block (it stays in state.blocks but its content is
 * deleted from blockContents) or fork-adoption sets contents out of array order.
 * Pre-fix, each such save false-alarmed DIGEST DRIFT on the sampled verify
 * (telemetry-only in shadow mode, but a real read-path divergence in full mode);
 * post-fix the digest key-sorts both legs' blockContents so only a genuine
 * content fork trips it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage, CompressionBlock } from "acp-kernel";
import type { BlockView } from "../src/session.js";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests
// (the shadow here is constructed directly with its own env object anyway).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-shadow-digest-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

function mkBlock(blockId: string, summary: string): CompressionBlock {
    return {
        blockId,
        runId: `run_${blockId}`,
        tier: 1,
        summary,
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: 1_500,
        survivedCount: 1,
        generation: "young",
        active: true,
    };
}

type BCEntry = { one: BlockView | null; full: BlockView };
function full(text: string, count: number): BCEntry {
    return { one: null, full: { text, count } };
}

// Above canonicalize's > 2020-09-01 mask threshold so createdAt / lastSeen
// collapse to __TS__ on BOTH digest legs regardless of how the store stamps
// updated_at — isolates the assertion to blockContents ordering.
const T_CREATED = 1_700_000_000_000;
const T_SEEN = 1_700_000_000_500;

function mkBlocksLegacy(id: string, blocks: CompressionBlock[], blockContents: Map<string, BCEntry>): LegacySessionLike {
    return {
        id,
        createdAt: T_CREATED,
        lastSeen: T_SEEN,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        // Key order mirrors MERGE_STATE_FIELDS so the expect-leg state
        // canonicalizes identically to loadLegacyView's reconstruction.
        state: {
            blocks,
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: blocks.length + 1,
            nextRunId: 1,
        },
        blockContents,
        lastMessages: [msg(0), msg(1)],
        lastMessagesFolded: false,
    };
}

interface StatsView {
    ingests: number;
    deltaIngests: number;
    verifySamples: number;
    verifyOk: number;
    verifyDrift: number;
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

function stats(shadow: UnifiedShadow): StatsView {
    return (shadow as unknown as { stats: StatsView }).stats;
}

test("#3407: partial blockContents (orphan-GC shape) must not trip the parity digest", () => {
    const dir = tmpdir("bili-3407-partial-");
    try {
        const b1 = mkBlock("b1", "sum-one");
        const b2 = mkBlock("b2", "sum-two");
        const b3 = mkBlock("b3", "sum-three");
        // orphan-gc reaped the MIDDLE block: it stays in state.blocks (inactive)
        // but its content was deleted from blockContents — completeBlockContents
        // synthesizes it appended at the end, diverging from the array order.
        const blockContents = new Map<string, BCEntry>([
            ["b1", full("full-one", 3)],
            ["b3", full("full-three", 5)],
        ]);
        const { shadow } = openShadow(dir);
        shadow.record(mkBlocksLegacy("bc-partial", [b1, b2, b3], blockContents));
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 0, "partial blockContents must not drift once the digest compares contents, not order (pre-fix: 1)");
        assert.equal(s.verifyOk, 1, "the sampled verify must pass");
    } finally {
        rmBestEffort(dir);
    }
});

test("#3407: full blockContents reordered vs state.blocks must not trip the parity digest", () => {
    const dir = tmpdir("bili-3407-reorder-");
    try {
        const b1 = mkBlock("b1", "sum-one");
        const b2 = mkBlock("b2", "sum-two");
        const b3 = mkBlock("b3", "sum-three");
        // All three contents present, inserted in an order that differs from the
        // state.blocks array order (fork-adoption / host build shapes do this).
        const blockContents = new Map<string, BCEntry>([
            ["b2", full("full-two", 2)],
            ["b3", full("full-three", 5)],
            ["b1", full("full-one", 3)],
        ]);
        const { shadow } = openShadow(dir);
        shadow.record(mkBlocksLegacy("bc-reorder", [b1, b2, b3], blockContents));
        const s = stats(shadow);
        assert.equal(s.verifySamples, 1, "first save must run the sampled verify");
        assert.equal(s.verifyDrift, 0, "reordered-but-complete blockContents must not drift once the digest compares contents, not order (pre-fix: 1)");
        assert.equal(s.verifyOk, 1, "the sampled verify must pass");
    } finally {
        rmBestEffort(dir);
    }
});
