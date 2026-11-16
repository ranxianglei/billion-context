// Migration: a legacy session may carry folded blocks with no blockContents snapshot
// (pruned or never cached). planIngest stores a placeholder for them
// ({ one: null, full: { text: block.summary, count: 0 } }, completeBlockContents) and
// the index replay serves it back as if it were a compression-time snapshot. decompress,
// the web block view and export must treat that placeholder as "no snapshot" — exactly
// like the legacy JSON load — instead of returning the block's own summary as content.
import test from "node:test";
import assert from "node:assert/strict";

process.env.BILI_PERSIST = "0";

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { storeEffectiveCcr } from "../src/store.ts";
import { getSession, blockContentSnapshot } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { completeBlockContents } from "../src/storage/ingest.ts";

const pad = (n: number): string => String(n).padStart(5, "0");

function fold() {
    const core = createCore();
    const config = applyCompressSettings(defaultConfig(200_000), 200_000, { ccr: { enabled: true, minToolTokens: 50 } }) as Config;
    const session = getSession(`mig-ph-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(1000)}`,
        });
    }
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { ctx, session, block };
}

test("migration: decompress of a block whose snapshot is the index placeholder restores the originals, not the summary", () => {
    const { ctx, session, block } = fold();
    const legacyLoad = resolveDecompress({ blockId: block.blockId }, ctx).text;
    assert.match(legacyLoad, /Historical detail 0\./, "cached snapshot restores originals");

    // Legacy JSON without a snapshot for this block (pruned) → collected from the live messages.
    session.blockContents = new Map();
    const noSnapshot = resolveDecompress({ blockId: block.blockId }, ctx).text;
    assert.match(noSnapshot, /Historical detail 0\./);

    // Same session after the unified import + index replay: the placeholder row comes back.
    session.blockContents = completeBlockContents(new Map(), session.state.blocks);
    assert.equal(session.blockContents.get(block.blockId)?.full.text, block.summary, "replay serves the placeholder");
    const migrated = resolveDecompress({ blockId: block.blockId }, ctx).text;
    assert.equal(migrated, noSnapshot, "migrated decompress must equal the legacy no-snapshot decompress");
});

test("migration: blockContentSnapshot ignores only the placeholder shape", () => {
    const { session, block } = fold();
    const real = session.blockContents.get(block.blockId);
    assert.ok(real);
    assert.equal(blockContentSnapshot(session.blockContents, block), real);
    const placeholder = completeBlockContents(new Map(), session.state.blocks);
    assert.equal(blockContentSnapshot(placeholder, block), undefined);
    const emptySummary = new Map([[block.blockId, { one: null, full: { text: "different", count: 0 } }]]);
    assert.ok(blockContentSnapshot(emptySummary, block), "a real zero-count snapshot with other text is kept");
    const nonEmptyCount = new Map([[block.blockId, { one: null, full: { text: block.summary, count: 5 } }]]);
    assert.ok(blockContentSnapshot(nonEmptyCount, block), "a snapshot with the summary text but real items is kept");
    const oneView = new Map([[block.blockId, { one: { text: "x", count: 1 }, full: { text: block.summary, count: 0 } }]]);
    assert.ok(blockContentSnapshot(oneView, block), "a snapshot with a real one-view is kept");
});
